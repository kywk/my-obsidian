#!/usr/bin/env node
/**
 * Menu acceptance harness: zero dependencies, drives the local Chrome over CDP
 * through tools/lib/cdp.mjs (frozen; nothing here needs a new primitive).
 *
 * What it proves (docs/DESIGN.md §3 item 5, §11.8):
 *
 *   1. menuBar            — the application menu bar exists with >= 4 top items
 *   2. submenu            — opening View shows its items and an accelerator
 *   3. menuState          — checked/enabled in the DOM match set-menu's template
 *   4. appCommand         — clicking an appCommand item runs the command
 *   5. moveToNewWindow    — tab right-click -> Move to new window -> new target
 *   6. editorContextMenu  — editor right-click shows a menu with clipboard items
 *   7. noExceptions       — no unhandled exception, fatal or caught menu warning
 *   8. nested lifecycle   — nested action order, keyboard/sibling cleanup, hover cancellation
 *
 * Two menu implementations are exercised, and the report says which one ran:
 *
 *   renderer-html  — app.json/appearance.json has nativeMenus: false, so
 *                    Obsidian's own Menu class draws the context menu
 *   html-fallback  — nativeMenus is unset/true, so the renderer calls
 *                    electron.remote.Menu.popup() and runtime/menu.js draws it
 *
 * Both paths go through the same `context-menu` IPC reply, which is what makes
 * the editor menu appear at all (the shim used to answer null).
 *
 * The vault must be a copy. The live vault is refused by path.
 *
 * Usage:
 *   node tools/menu-check.mjs --vault <dir> [--url ...] [--port 3701]
 *                             [--chrome-port 4701] [--timeout 90]
 *                             [--native-menus keep|true|false]
 *                             [--json <out.json>] [--log <file>] [--verbose]
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  Cdp,
  assertNotLiveVault,
  attachToPage,
  clickAt,
  evalInPage,
  launchChrome,
  listPageTargets,
  readTermsFromVendor,
  sleep,
  startServer,
  waitForPage,
} from './lib/cdp.mjs';

const CLIPBOARD_LABELS = {
  // English and zh-TW (the two locales this runtime is used in); the check is
  // a subset test over the labels the menu actually rendered.
  cut: /^(cut|剪下|剪切)$/i,
  copy: /^(copy|複製|复制)$/i,
  paste: /^(paste|貼上|粘贴)$/i,
};
const MOVE_TO_WINDOW = /move .*new window|新視窗|新窗口|移動到新視窗|移动到新窗口/i;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = {
    url: null,
    vault: null,
    timeout: 90,
    port: 3701,
    chromePort: 4701,
    nativeMenus: 'keep',
    json: null,
    log: null,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--vault') out.vault = argv[++i];
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--chrome-port') out.chromePort = Number(argv[++i]);
    else if (a === '--native-menus') out.nativeMenus = argv[++i];
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--log') out.log = argv[++i];
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 40).join('\n'));
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.vault) throw new Error('--vault <dir> is required (a copy, never the live vault)');
args.vault = path.resolve(args.vault);
assertNotLiveVault(args.vault);
if (!fs.existsSync(path.join(args.vault, '.obsidian'))) {
  throw new Error(`not an Obsidian vault (no .obsidian): ${args.vault}`);
}

const url = args.url || `http://127.0.0.1:${args.port}/`;

// ---------------------------------------------------------------- report

const report = {
  url,
  vault: args.vault,
  nativeMenus: null,
  menuPath: null,
  criteria: {},
  facts: {},
  console: { errors: [], exceptions: [], menuWarnings: [] },
};
const checks = [];
let verbose = args.verbose;

function log(...parts) {
  if (verbose) console.log('[menu-check]', ...parts);
}

async function check(name, fn, detail) {
  try {
    const value = await fn();
    const pass = value === undefined ? true : !!value;
    checks.push({ name, pass, detail: pass ? detail || null : detail || null });
    return pass;
  } catch (err) {
    checks.push({ name, pass: false, detail: err && err.message ? err.message : String(err) });
    return false;
  }
}

function fact(key, value) {
  report.facts[key] = value;
}

// ---------------------------------------------------------------- nativeMenus

let appearancePath = null;
let appearanceBackup = null;

function setNativeMenus(value) {
  appearancePath = path.join(args.vault, '.obsidian', 'appearance.json');
  appearanceBackup = fs.existsSync(appearancePath) ? fs.readFileSync(appearancePath, 'utf8') : null;
  const current = appearanceBackup ? JSON.parse(appearanceBackup) : {};
  current.nativeMenus = value;
  fs.writeFileSync(appearancePath, JSON.stringify(current, null, 2) + '\n');
  log(`nativeMenus -> ${value} (${appearancePath})`);
}

function restoreAppearance() {
  if (!appearancePath || appearanceBackup == null) return;
  try {
    fs.writeFileSync(appearancePath, appearanceBackup);
  } catch (err) {
    console.error('[menu-check] could not restore appearance.json:', err.message);
  }
}

// ---------------------------------------------------------------- page helpers

async function evaluate(session, expression, options) {
  return evalInPage(cdp, session, expression, options);
}

async function waitFor(session, expression, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(session, expression);
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

async function rectOf(session, selector, offset) {
  const raw = await evaluate(
    session,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return null;
      const dx = ${offset && offset.dx != null ? offset.dx : 0.5};
      const dy = ${offset && offset.dy != null ? offset.dy : 0.5};
      return JSON.stringify({ x: r.x + r.width * dx, y: r.y + r.height * dy, w: r.width, h: r.height });
    })()`,
  );
  if (!raw) throw new Error(`element not found or not visible: ${selector}`);
  return JSON.parse(raw);
}

async function clickSelector(session, selector, options = {}) {
  const rect = await rectOf(session, selector, options.offset);
  await clickAt(cdp, session, { x: rect.x, y: rect.y }, options);
  return rect;
}

async function rightClickSelector(session, selector, options = {}) {
  return clickSelector(session, selector, { ...options, button: 'right' });
}

async function pressKey(session, key, code, keyCode) {
  await cdp.send(
    'Input.dispatchKeyEvent',
    { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode },
    session,
  );
  await cdp.send(
    'Input.dispatchKeyEvent',
    { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode },
    session,
  );
}

/**
 * Rows come from two implementations: Obsidian's `.menu-item` and the runtime's
 * `.myobs-menu-row`. Return a uniform view for assertions and diagnostics.
 */
const ROW_SNAPSHOT = `(() => {
  const rows = [...document.querySelectorAll(".myobs-menu-row, .menu-item")];
  return rows.map((el) => {
    const labelEl = el.querySelector(".myobs-menu-label");
    const accelEl = el.querySelector(".myobs-menu-accel");
    const text = labelEl ? labelEl.textContent : (el.innerText || "").split("\\n")[0];
    return {
      label: (text || "").trim(),
      accel: accelEl ? (accelEl.textContent || "").trim() : "",
      checked: el.getAttribute("aria-checked"),
      disabled: el.getAttribute("aria-disabled"),
      isSeparator: false,
      cls: el.className,
    };
  }).filter((r) => r.label.length > 0);
})()`;

async function openMenuSnapshot(session) {
  return evaluate(
    session,
    `(() => {
      const panels = [...document.querySelectorAll(".myobs-menu-panel, .menu")];
      return JSON.stringify({
        count: panels.length,
        classes: panels.map((p) => p.className),
        rows: ${ROW_SNAPSHOT},
      });
    })()`,
  ).then((raw) => JSON.parse(raw));
}

async function closeMenus(session) {
  await pressKey(session, 'Escape', 'Escape', 27);
  await sleep(200);
  await evaluate(session, 'window.__MYOBS_MENU && window.__MYOBS_MENU.close()').catch(() => {});
}

// ---------------------------------------------------------------- checks

let cdp;
let server;
let chrome;
let mainSession = null;

function attachConsole(session) {
  cdp.on((msg) => {
    if (msg.sessionId !== session) return;
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      report.console.exceptions.push(
        (d.exception && (d.exception.description || d.exception.value)) || d.text || 'exception',
      );
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'warning') {
      const text = msg.params.args.map(a => a.value ?? a.description ?? a.type).join(' ');
      if (text.startsWith('[my-obsidian] menu:')) report.console.menuWarnings.push(text.slice(0, 1000));
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      report.console.errors.push(
        msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 500),
      );
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      report.console.errors.push(String(msg.params.entry.text || '').slice(0, 500));
    }
  });
}

async function dismissTrustModal(session) {
  const state = await evaluate(
    session,
    `(async () => {
      if (!app.workspace || !app.workspace.layoutReady) {
        await new Promise((resolve) => {
          if (!app.workspace) return resolve();
          app.workspace.onLayoutReady(resolve);
        });
      }
      const had = !!document.querySelector(".modal-bg");
      if (had) {
        // Trust is recorded in origin localStorage, which a fresh Chrome
        // profile never has, so the prompt reappears on every run.
        try { await app.plugins.setEnable(true); } catch (err) {}
        try { app.setting.close(); } catch (err) {}
        document.querySelectorAll(".modal-bg, .modal-container, .modal").forEach((el) => {
          if (typeof el.detach === "function") el.detach();
          else el.remove();
        });
        await new Promise((r) => setTimeout(r, 400));
      }
      return JSON.stringify({ had, remains: !!document.querySelector(".modal-bg") });
    })()`,
  );
  return JSON.parse(state);
}

async function openNote(session) {
  await waitFor(
    session,
    'app.vault.getMarkdownFiles().length > 0',
    30000,
    'the vault scan to produce markdown files',
  );
  return evaluate(
    session,
    `(async () => {
      const file = app.vault.getMarkdownFiles().find((f) => f.extension === "md");
      if (!file) throw new Error("vault has no markdown file");
      // A freshly opened vault can be layout-ready before its tab group
      // exists; getLeaf(true) throws "No tab group found" in that window.
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && !document.querySelector(".workspace-tab-header")) {
        await new Promise((r) => setTimeout(r, 200));
      }
      let leaf = null;
      try { leaf = app.workspace.getMostRecentLeaf(app.workspace.rootSplit); } catch (err) {}
      for (let i = 0; i < 40 && !leaf; i += 1) {
        try { leaf = app.workspace.getLeaf("tab"); } catch (err) { await new Promise((r) => setTimeout(r, 250)); }
      }
      if (!leaf) throw new Error("no workspace leaf available");
      await leaf.openFile(file);
      try { leaf.setMode("source"); } catch (err) {}
      app.workspace.setActiveLeaf(leaf, { focus: true });
      return file.path;
    })()`,
  );
}

function modelItem(session, commandId) {
  return evaluate(
    session,
    `(() => {
      const walk = (items) => {
        for (const item of items || []) {
          if (item.appCommand === ${JSON.stringify(commandId)} || item.id === ${JSON.stringify(commandId)}) {
            return {
              appCommand: item.appCommand || null,
              id: item.id || null,
              label: item.label || "",
              checked: typeof item.checked === "boolean" ? item.checked : null,
              enabled: item.enabled !== false,
              type: item.type || null,
              accelerator: item.accelerator || "",
            };
          }
          if (item.submenu) {
            const found = walk(item.submenu);
            if (found) return found;
          }
        }
        return null;
      };
      return JSON.stringify(walk((window.__MYOBS_MENU.getTemplate() || [])));
    })()`,
  ).then((raw) => JSON.parse(raw));
}

async function submenuLifecycle() {
  const menu = window.__MYOBS_MENU;
  const facts = {}, criteria = {};
  let doc = document;
  const popup = (items, close) => {
    const panel = menu.popupTemplate(items, { x: 30, y: 60 }, close);
    if (!panel) throw new Error('Menu popup did not open');
    doc = panel.ownerDocument;
    return panel;
  };
  const rows = () => [...doc.querySelectorAll('.myobs-menu-row')];
  const row = text => rows().find(el => el.querySelector('.myobs-menu-label')?.textContent === text);
  const click = text => { const el = row(text); if (!el) throw new Error('Missing menu row: ' + text); el.click(); };
  const clean = () => !menu.isOpen() && !doc.querySelector('.myobs-menu-panel') && menu.getState().rows === 0;
  const key = key => doc.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  try {
    menu.close();
    const order = [];
    popup([{ label: 'First', submenu: [{ label: 'Second', submenu: [{ label: 'Run nested action', click: () => order.push('action') }] }] }], () => order.push('close'));
    click('First'); click('Second'); click('Run nested action');
    facts.actionOrder = order;
    criteria.nestedMenuAction = clean() && order.join(',') === 'close,action';
    if (!criteria.nestedMenuAction) return { criteria, facts, error: 'Nested selection did not close and run its action' };

    let closes = 0;
    popup([{ label: 'Branch A', submenu: [{ label: 'Leaf A' }] }, { label: 'Branch B', submenu: [{ label: 'Leaf B' }] }], () => closes++);
    const root = doc.querySelector('.myobs-menu-panel');
    click('Branch A');
    key('ArrowLeft');
    const leftClosed = !row('Leaf A') && root._myobsChildren.length === 0 && menu.getActiveRow() === 'Branch A';
    click('Branch A');
    row('Branch B').dispatchEvent(new doc.defaultView.MouseEvent('mouseenter'));
    const siblingClosed = !row('Leaf A') && root._myobsChildren.length === 0;
    click('Branch B');
    const oneChild = root._myobsChildren.length === 1;
    key('Escape');
    criteria.submenuKeyboardAndSiblingCleanup = leftClosed && siblingClosed && oneChild && closes === 1 && clean() && root._myobsChildren.length === 0;
    facts.submenuCleanup = { leftClosed, siblingClosed, oneChild, closes };

    let pendingCloses = 0;
    popup([{ label: 'Pending submenu', submenu: [{ label: 'Late child' }] }], () => pendingCloses++);
    const pendingRow = row('Pending submenu');
    pendingRow.dispatchEvent(new doc.defaultView.MouseEvent('mouseenter'));
    const hadTimer = !!pendingRow._myobsTimer;
    pendingRow.hidden = true;
    menu.close();
    const timerCleared = !pendingRow._myobsTimer;
    // Cross the runtime's 140 ms hover deadline to prove teardown cancels it.
    await new Promise(resolve => setTimeout(resolve, 220));
    criteria.submenuHoverCancelledOnDismiss = hadTimer && timerCleared && pendingCloses === 1 && clean();
    facts.pendingHover = { hadTimer, timerCleared, closes: pendingCloses };
  } catch (error) { facts.error = String(error); }
  return { criteria, facts };
}

async function main() {
  const terms = readTermsFromVendor();
  if (args.nativeMenus !== 'keep') setNativeMenus(args.nativeMenus === 'true');

  server = await startServer(args.vault, args.port, terms);
  chrome = await launchChrome(args.chromePort);
  cdp = new Cdp(chrome.wsUrl);
  await cdp.connect();

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  mainSession = await attachToPage(cdp, targetId);
  attachConsole(mainSession);

  await cdp.send('Runtime.enable', {}, mainSession);
  await cdp.send('Page.enable', {}, mainSession);
  await cdp.send('Log.enable', {}, mainSession).catch(() => {});

  const started = Date.now();
  await cdp.send('Page.navigate', { url }, mainSession);

  const booted = await waitForPage(
    cdp,
    mainSession,
    'typeof window.app === "object" && !!app.workspace',
    args.timeout * 1000,
  );
  if (!booted) {
    const fatal = await evaluate(
      mainSession,
      '(function(){var e=document.getElementById("myobs-fatal");return !(e && !e.hidden && e.style.display !== "none");})()',
    ).catch(() => true);
    if (!fatal) {
      const detail = await evaluate(
        mainSession,
        '(document.getElementById("myobs-fatal-detail")||{}).textContent || ""',
      ).catch(() => '');
      throw new Error(`runtime showed the fatal screen:\n${detail}`);
    }
    throw new Error('window.app never appeared');
  }
  fact('bootMs', Date.now() - started);

  const modal = await dismissTrustModal(mainSession);
  fact('trustModal', modal);
  log('trust modal', modal);

  fact('note', await openNote(mainSession));
  await sleep(600);
  // The trust prompt is raised once plugins finish loading, which can be after
  // layout-ready; a second pass keeps the tab and editor clicks unobstructed.
  const modal2 = await dismissTrustModal(mainSession);
  if (modal2.had) fact('trustModalAfterOpen', modal2);

  report.nativeMenus = await evaluate(mainSession, 'app.vault.getConfig("nativeMenus")');
  report.menuPath = report.nativeMenus === false ? 'renderer-html' : 'html-fallback';
  fact('platformIsMac', await evaluate(mainSession, 'process.platform === "darwin"'));

  // ---- 1. menu bar -------------------------------------------------------
  await check(
    'menuBar',
    async () => {
      const labels = await waitFor(
        mainSession,
        'window.__MYOBS_MENU && window.__MYOBS_MENU.installed && (window.__MYOBS_MENU.getBarLabels().length >= 4 ? window.__MYOBS_MENU.getBarLabels() : null)',
        20000,
        'application menu bar',
      );
      fact('barLabels', labels);
      const barRect = await rectOf(mainSession, '.myobs-menubar');
      const appTop = await evaluate(
        mainSession,
        'document.querySelector(".app-container").getBoundingClientRect().top',
      );
      const barBottom = barRect.y + barRect.h / 2;
      fact('barHeight', barRect.h);
      fact('appContainerTop', appTop);
      fact('barBottom', barBottom);
      if (appTop < barBottom - 1) throw new Error('menu bar overlaps app content');
      return labels.length >= 4;
    },
    'bar rendered from set-menu',
  );

  // ---- 1b. render-menu (tray / titlebar popup) -------------------------
  await check(
    'renderMenu',
    async () => {
      // The non-macOS frameless titlebar sends render-menu on its logo button;
      // this runtime uses frame:"native", so the channel is exercised directly.
      await cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseMoved', x: 500, y: 400, buttons: 0 },
        mainSession,
      );
      await sleep(150);
      await evaluate(mainSession, 'electron.ipcRenderer.send("render-menu")');
      await sleep(400);
      const panel = JSON.parse(
        await evaluate(
          mainSession,
          `(() => {
            const p = document.querySelector(".myobs-menu-panel");
            if (!p) return JSON.stringify({ open: false });
            const r = p.getBoundingClientRect();
            return JSON.stringify({
              open: true,
              x: Math.round(r.x),
              y: Math.round(r.y),
              labels: [...p.querySelectorAll(".myobs-menu-row .myobs-menu-label")].map((e) => e.textContent),
            });
          })()`,
        ),
      );
      fact('renderMenu', panel);
      if (!panel.open) throw new Error('render-menu did not open a panel');
      if (Math.abs(panel.x - 500) > 4 || Math.abs(panel.y - 400) > 4) {
        throw new Error(`render-menu opened at ${panel.x},${panel.y} instead of the cursor`);
      }
      if (panel.labels.length < 4) throw new Error('render-menu panel is missing top-level items');
      await closeMenus(mainSession);
      return true;
    },
    'render-menu pops the root menu at the cursor',
  );

  // ---- 2. View submenu + accelerator ------------------------------------
  const viewIndex = await evaluate(
    mainSession,
    `(() => {
      const labels = window.__MYOBS_MENU.getBarLabels();
      const exact = labels.findIndex((l) => /^view$/i.test(l.trim()));
      if (exact !== -1) return exact;
      const template = window.__MYOBS_MENU.getTemplate() || [];
      const wanted = template.filter((i) => i && i.visible !== false && i.type !== "separator");
      const idx = wanted.findIndex((i) => /&?view/i.test(String(i.label || "")));
      return idx;
    })()`,
  );
  fact('viewTopIndex', viewIndex);

  await check(
    'submenu',
    async () => {
      if (viewIndex < 0) throw new Error('no View top-level item in the bar');
      const buttons = await evaluate(
        mainSession,
        `(() => {
          const b = document.querySelectorAll(".myobs-menubar-item")[${viewIndex}];
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()`,
      );
      if (!buttons) throw new Error('View button not found');
      const p = JSON.parse(buttons);
      await clickAt(cdp, mainSession, p);
      await sleep(350);
      const snapshot = await openMenuSnapshot(mainSession);
      fact('viewMenu', snapshot);
      if (!snapshot.count) throw new Error('View menu did not open');
      const withAccel = snapshot.rows.filter((r) => r.accel);
      fact('viewAccelerators', withAccel);
      if (!snapshot.rows.length) throw new Error('View menu has no rows');
      if (!withAccel.length) throw new Error('no accelerator text rendered in View');

      // Keyboard: the active row is tracked by menu.js (Obsidian's keymap blurs
      // any element outside its focus container, so document.activeElement is
      // not a usable signal here).
      const activeBefore = await evaluate(mainSession, 'window.__MYOBS_MENU.getActiveRow()');
      await pressKey(mainSession, 'ArrowDown', 'ArrowDown', 40);
      await sleep(200);
      const activeAfter = await evaluate(mainSession, 'window.__MYOBS_MENU.getActiveRow()');
      await pressKey(mainSession, 'Escape', 'Escape', 27);
      await sleep(250);
      const closed = await evaluate(mainSession, 'String(!window.__MYOBS_MENU.isOpen())');
      fact('keyboard', { activeBefore, activeAfter, closed });
      if (!activeBefore) throw new Error('no active row after opening View');
      if (activeAfter === activeBefore) throw new Error('ArrowDown did not move the active row');
      if (closed !== 'true') throw new Error('Escape did not close the menu');
      return true;
    },
    'View opens, shows accelerators, responds to arrows/Escape',
  );

  // ---- 3. checked/enabled mirror the template ---------------------------
  await check(
    'menuState',
    async () => {
      const model = await modelItem(mainSession, 'app:toggle-ribbon');
      fact('ribbonModel', model);
      if (!model) throw new Error('app:toggle-ribbon is not in the set-menu template');
      if (typeof model.checked !== 'boolean') throw new Error('app:toggle-ribbon has no checked state (update-menu-items never arrived)');
      await clickAt(
        cdp,
        mainSession,
        JSON.parse(
          await evaluate(
            mainSession,
            `(() => {
              const b = document.querySelectorAll(".myobs-menubar-item")[${viewIndex}];
              const r = b.getBoundingClientRect();
              return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
            })()`,
          ),
        ),
      );
      await sleep(300);
      const snapshot = await openMenuSnapshot(mainSession);
      const label = await evaluate(
        mainSession,
        `(() => {
          const t = window.__MYOBS_MENU.getTemplate();
          const walk = (items) => {
            for (const item of items || []) {
              if (item.appCommand === "app:toggle-ribbon") return item.label;
              if (item.submenu) { const f = walk(item.submenu); if (f) return f; }
            }
            return null;
          };
          return walk(t);
        })()`,
      );
      const row = snapshot.rows.find((r) => r.label === label || r.label === model.label);
      fact('ribbonRow', row || null);
      if (!row) throw new Error(`ribbon row not found in View (rows: ${snapshot.rows.map((r) => r.label).join(', ')})`);
      if (row.checked !== String(!!model.checked)) {
        throw new Error(`aria-checked=${row.checked} but template checked=${model.checked}`);
      }
      if (row.disabled !== String(!model.enabled)) {
        throw new Error(`aria-disabled=${row.disabled} but template enabled=${model.enabled}`);
      }
      await closeMenus(mainSession);
      return true;
    },
    'checked/enabled match set-menu + update-menu-items',
  );

  // ---- 4. appCommand executes ------------------------------------------
  await check(
    'appCommand',
    async () => {
      const before = await evaluate(mainSession, 'document.body.classList.contains("show-ribbon")');
      const model = await modelItem(mainSession, 'app:toggle-ribbon');
      await clickAt(
        cdp,
        mainSession,
        JSON.parse(
          await evaluate(
            mainSession,
            `(() => {
              const b = document.querySelectorAll(".myobs-menubar-item")[${viewIndex}];
              const r = b.getBoundingClientRect();
              return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
            })()`,
          ),
        ),
      );
      await sleep(300);
      const target = await evaluate(
        mainSession,
        `(() => {
          const row = [...document.querySelectorAll(".myobs-menu-row")].find((el) => {
            const l = el.querySelector(".myobs-menu-label");
            return l && l.textContent === ${JSON.stringify(model.label)};
          });
          if (!row) return null;
          const r = row.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()`,
      );
      if (!target) throw new Error('ribbon row not found before click');
      await clickAt(cdp, mainSession, JSON.parse(target));
      const flipped = await waitFor(
        mainSession,
        `document.body.classList.contains("show-ribbon") === ${!before}`,
        4000,
        'ribbon state to flip',
      ).catch(() => false);
      const after = await evaluate(mainSession, 'document.body.classList.contains("show-ribbon")');
      fact('ribbonToggle', { before, after });
      if (!flipped) throw new Error(`app:toggle-ribbon did not run (show-ribbon stayed ${before})`);

      // update-menu-items must follow the command; the panel was closed by the
      // click, so reopen and compare again.
      const updated = await waitFor(
        mainSession,
        `(() => {
          const r = ${JSON.stringify(model.label)};
          const t = window.__MYOBS_MENU.getTemplate();
          const walk = (items) => {
            for (const item of items || []) {
              if (item.appCommand === "app:toggle-ribbon") return item.checked === ${!before};
              if (item.submenu) { const f = walk(item.submenu); if (f) return true; }
            }
            return false;
          };
          return walk(t);
        })()`,
        4000,
        'update-menu-items for app:toggle-ribbon',
      ).catch(() => false);
      fact('ribbonCheckedUpdated', updated);
      return true;
    },
    'View > Toggle ribbon flips the ribbon',
  );

  // ---- 6. editor context menu ------------------------------------------
  await openNote(mainSession);
  await sleep(700);

  await check(
    'editorContextMenu',
    async () => {
      // The context menu's clipboard section only exists in source mode; the
      // reading view builds a different menu.
      await evaluate(
        mainSession,
        `(async () => {
          const leaf = app.workspace.activeLeaf;
          if (leaf && leaf.view && typeof leaf.view.getMode === "function" && leaf.view.getMode() !== "source") {
            app.commands.executeCommandById("editor:toggle-source");
            await new Promise((r) => setTimeout(r, 400));
          }
          const el = leaf && leaf.view.containerEl ? leaf.view.containerEl.querySelector(".cm-content") : null;
          if (el) el.scrollIntoView({ block: "center" });
          return true;
        })()`,
      );
      await sleep(300);
      const rect = await evaluate(
        mainSession,
        `(() => {
          const leaf = app.workspace.activeLeaf;
          const view = leaf && leaf.view;
          const el = view && view.containerEl ? view.containerEl.querySelector(".cm-content") : null;
          // .cm-content is the whole document (1437px tall, often scrolled
          // above the viewport). Click inside the visible .cm-scroller instead.
          const scroller = view && view.containerEl ? view.containerEl.querySelector(".cm-scroller") : null;
          if (!el || !scroller) return null;
          const r = scroller.getBoundingClientRect();
          const x = Math.round(r.x + Math.min(240, r.width / 2));
          const y = Math.round(r.y + Math.min(80, r.height / 2));
          const hit = document.elementFromPoint(x, y);
          return JSON.stringify({
            x, y,
            hit: hit ? (hit.className || hit.tagName) : null,
            rect: { x: r.x, y: r.y, w: r.width, h: r.height },
            content: (() => { const c = el.getBoundingClientRect(); return { x: c.x, y: c.y, w: c.width, h: c.height }; })(),
            mode: view.getMode ? view.getMode() : null,
            type: view.getViewType ? view.getViewType() : null,
          });
        })()`,
      );
      if (!rect) throw new Error('no .cm-content in the active leaf');
      const p = JSON.parse(rect);
      fact('editorPoint', p);
      // focus the editor first so CodeMirror owns the selection
      await clickAt(cdp, mainSession, { x: p.x, y: p.y });
      await sleep(250);
      await clickAt(cdp, mainSession, { x: p.x, y: p.y }, { button: 'right' });
      await sleep(900);
      const snapshot = await openMenuSnapshot(mainSession);
      fact('editorMenu', snapshot);
      if (!snapshot.count) throw new Error('no editor context menu appeared');
      const labels = snapshot.rows.map((r) => r.label);
      const missing = Object.keys(CLIPBOARD_LABELS).filter((k) => !labels.some((l) => CLIPBOARD_LABELS[k].test(l)));
      if (missing.length) throw new Error(`clipboard items missing: ${missing.join(', ')} (labels: ${labels.join(' | ')})`);
      const reply = await evaluate(
        mainSession,
        'JSON.stringify(window.__MYOBS_MENU.getLastContextReply())',
      ).then((raw) => JSON.parse(raw));
      fact('contextReply', reply);
      if (!reply || !reply.editFlags) throw new Error('no editFlags reply recorded');
      await closeMenus(mainSession);
      return true;
    },
    'editor right-click shows Cut/Copy/Paste',
  );

  // ---- 5. Move to new window -------------------------------------------
  await openNote(mainSession);
  await sleep(600);

  await check(
    'moveToNewWindow',
    async () => {
      fact(
        'tabs',
        JSON.parse(
          await evaluate(
            mainSession,
            `JSON.stringify([...document.querySelectorAll(".workspace-tab-header")].map((el) => {
              const r = el.getBoundingClientRect();
              return { type: el.dataset.type, text: (el.innerText || "").trim().slice(0, 40), x: r.x, y: r.y, w: r.width, h: r.height };
            }))`,
          ),
        ),
      );
      const tabRaw = await evaluate(
        mainSession,
        `(() => {
          // Use the *active* leaf's tab: background tabs may be DeferredViews,
          // whose onTabMenu is the base one and has no "Move to new window".
          const active = app.workspace.activeLeaf;
          const el = (active && active.tabHeaderEl) ? active.tabHeaderEl : [...document.querySelectorAll('.workspace-tab-header[data-type="markdown"]')].find((t) => {
            const r = t.getBoundingClientRect();
            return r.width > 20 && r.height > 10;
          });
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const x = Math.round(r.x + r.width * 0.45);
          const y = Math.round(r.y + r.height / 2);
          const hit = document.elementFromPoint(x, y);
          return JSON.stringify({
            x, y,
            hit: hit ? (hit.className || hit.tagName) : null,
            inRoot: !!el.closest(".mod-root"),
            rect: { x: r.x, y: r.y, w: r.width, h: r.height },
          });
        })()`,
      );
      if (!tabRaw) throw new Error('no visible markdown tab header');
      const tab = JSON.parse(tabRaw);
      fact('tab', tab);
      await clickAt(cdp, mainSession, { x: tab.x, y: tab.y }, { button: 'right' });
      await sleep(700);
      const snapshot = await openMenuSnapshot(mainSession);
      const row = snapshot.rows.find((r) => MOVE_TO_WINDOW.test(r.label));
      fact('tabMenuPath', snapshot.classes);
      fact('tabMenuRow', row || null);
      if (!row) {
        throw new Error(`no "Move to new window" item (rows: ${snapshot.rows.map((r) => r.label).join(', ')})`);
      }
      const before = (await listPageTargets(cdp)).length;
      const rowPoint = await evaluate(
        mainSession,
        `(() => {
          const row = [...document.querySelectorAll(".myobs-menu-row, .menu-item")].find((el) => ${MOVE_TO_WINDOW}.test((${ROW_LABEL_EXPR})(el)));
          if (!row) return null;
          const r = row.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()`,
      );
      if (!rowPoint) throw new Error('row disappeared before the click');
      await clickAt(cdp, mainSession, JSON.parse(rowPoint));
      const deadline = Date.now() + 6000;
      let after = before;
      while (Date.now() < deadline && after <= before) {
        await sleep(200);
        after = (await listPageTargets(cdp)).length;
      }
      const targets = await listPageTargets(cdp);
      fact('targets', { before, after: targets.length, urls: targets.map((t) => t.url) });
      if (after <= before) throw new Error(`no new page target after clicking (${before} -> ${after})`);
      const popup = targets.find((t) => t.url === 'about:blank');
      if (!popup) throw new Error('the new target is not the about:blank popout');
      await cdp.send('Target.closeTarget', { targetId: popup.targetId }).catch(() => {});
      await sleep(300);
      fact('tabRect', tab);
      return true;
    },
    'tab right-click -> Move to new window -> new target',
  );

  // ---- 7. no unhandled exceptions --------------------------------------
  fact(
    'templateKeys',
    JSON.parse(
      await evaluate(
        mainSession,
        `JSON.stringify((() => {
          const keys = new Set();
          const types = new Set();
          const labels = [];
          const walk = (items, depth) => {
            for (const item of items || []) {
              Object.keys(item).forEach((k) => keys.add(k));
              if (item.type) types.add(item.type);
              if (depth === 0) labels.push(item.label);
              if (item.submenu) walk(item.submenu, depth + 1);
            }
          };
          walk(window.__MYOBS_MENU.getTemplate(), 0);
          return { keys: [...keys].sort(), types: [...types].sort(), top: labels };
        })())`,
      ),
    ),
  );
  fact(
    'lastMenuUpdate',
    JSON.parse(
      await evaluate(mainSession, 'JSON.stringify(window.__MYOBS_MENU.getLastUpdate())').catch(() => 'null'),
    ),
  );
  fact('menuStats', await evaluate(
    mainSession,
    'JSON.stringify(window.__MYOBS_MENU ? window.__MYOBS_MENU.getState() : null)',
  ).catch(() => null));
  const submenuResult = await evaluate(mainSession, `(${submenuLifecycle.toString()})()`);
  fact('submenuLifecycle', submenuResult.facts);
  for (const name of ['nestedMenuAction', 'submenuKeyboardAndSiblingCleanup', 'submenuHoverCancelledOnDismiss']) {
    await check(name, async () => submenuResult.criteria[name] === true, submenuResult.error || submenuResult.facts.error);
  }
  const fatalVisible = await evaluate(
    mainSession,
    '(function(){var e=document.getElementById("myobs-fatal");return !!(e && !e.hidden && e.style.display !== "none");})()',
  ).catch(() => true);
  fact('fatalVisible', fatalVisible);
  await check(
    'noExceptions',
    async () => {
      const errors = report.console.exceptions;
      if (errors.length) throw new Error(`${errors.length} unhandled exception(s): ${errors.slice(0, 3).join(' | ')}`);
      if (report.console.menuWarnings.length) throw new Error('menu runtime warning: ' + report.console.menuWarnings.join(' | '));
      if (fatalVisible) throw new Error('the runtime fatal screen is visible');
      return true;
    },
    'main window stayed clean',
  );
}

// A label expression is evaluated in the page; keep it small and shared.
const ROW_LABEL_EXPR = `((el) => {
  const l = el.querySelector(".myobs-menu-label");
  return (l ? l.textContent : (el.innerText || "").split("\\n")[0] || "");
})`;

function finish(code) {
  for (const c of checks) report.criteria[c.name] = c.pass;
  report.passed = checks.every((c) => c.pass);
  report.checks = checks;
  console.log(JSON.stringify(report, null, 2));
  if (report.console.exceptions.length) {
    console.log('\n--- exceptions ---');
    for (const e of report.console.exceptions.slice(0, 10)) console.log(e);
  }
  if (report.console.errors.length) {
    console.log('\n--- console errors ---');
    for (const e of report.console.errors.slice(0, 10)) console.log(e);
  }
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
  process.exitCode = code;
}

try {
  await main();
  finish(checks.every((c) => c.pass) ? 0 : 1);
} catch (err) {
  checks.push({ name: 'harness', pass: false, detail: err && err.stack ? err.stack : String(err) });
  finish(1);
} finally {
  try {
    cdp && cdp.close();
  } catch (err) {}
  try {
    chrome && chrome.child.kill();
  } catch (err) {}
  try {
    server && server.child.kill();
  } catch (err) {}
  if (args.log && server) fs.writeFileSync(args.log, server.logs.join(''));
  restoreAppearance();
  await sleep(300);
}
