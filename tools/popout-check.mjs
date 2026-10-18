#!/usr/bin/env node
/**
 * Popout acceptance harness: zero dependencies.
 *
 * Drives the locally installed Chrome over CDP (tools/lib/cdp.mjs) and verifies
 * the multi-window path of docs/DESIGN.md §3 item 5 through gestures only:
 * every window.open() under test is reached from a real input event dispatched
 * with Input.dispatchMouseEvent / Input.dispatchKeyEvent, never from a
 * Runtime.evaluate that fakes a click.
 *
 * Criteria:
 *   1. appBooted        — the main window booted (window.app exists)
 *   2. popoutOpened     — the gesture produced a second page target
 *   3. popoutApp        — that target has window.app, and it is the *same* app
 *                         object as the main window's (shared heap, not a copy)
 *   4. popoutFile       — app.workspace.getActiveFile().path is the designated
 *                         note, and the popout window is the one showing it
 *   5. popoutWrite      — editing from the popout changes the file on disk
 *   6. mainWindowIntact — the main window still has window.app and collected no
 *                         new unhandled exceptions
 *
 * Two triggers are exercised, both Obsidian product paths:
 *   A. the command palette (Mod+P -> "Open current tab in new window" -> Enter)
 *      which is `workspace:open-in-new-window` -> openPopoutLeaf().
 *   B. the `#popout=<vault path>` deep link this runtime adds, whose notice
 *      button calls app.workspace.openLinkText(path, "", "window").
 * The tab header context menu ("Move to new window") is *not* usable here: on
 * macOS the bundle switches menus to the native menu bar, which this runtime
 * does not draw yet (GAPS.md §2, "自繪選單列"). The harness records that as
 * evidence instead of pretending to click it.
 *
 * The vault must be a *copy* of the real vault: the harness edits a note and
 * writes a scratch file. The live vault is refused explicitly.
 *
 * Usage:
 *   node tools/popout-check.mjs --vault <dir> [--url ...] [--port 3503]
 *                               [--file <vault-relative note>] [--timeout 90]
 *                               [--json <out.json>] [--log <file>]
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  Cdp,
  activateTarget,
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

// Harnesses write into whichever vault they are pointed at, so they refuse the
// operator's real vault and demand a copy. Point MYOBS_LIVE_VAULT at your own
// vault to keep the guard; forks should set it instead of editing this line.
const LIVE_VAULT =
  process.env.MYOBS_LIVE_VAULT ?? path.join(process.env.HOME ?? '', 'kywk', 'obsidian');
const SCRATCH_REL = '.myobs-popout-probe.txt';

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = {
    url: null,
    vault: null,
    file: null,
    timeout: 90,
    json: null,
    port: 3503,
    chromePort: null,
    log: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--vault') out.vault = argv[++i];
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--chrome-port') out.chromePort = Number(argv[++i]);
    else if (a === '--log') out.log = argv[++i];
  }
  return out;
}

/**
 * @param {string} vault
 */
function assertNotLiveVault(vault) {
  const resolved = path.resolve(vault);
  const real = fs.realpathSync(resolved);
  for (const candidate of [resolved, real]) {
    if (candidate === LIVE_VAULT) {
      throw new Error(
        `refusing to run against the live vault (${LIVE_VAULT}); pass a copy of it instead`,
      );
    }
  }
}

/**
 * Wait until a page target appears that was not in `known`.
 *
 * @param {Cdp} cdp
 * @param {Set<string>} known
 * @param {number} timeoutMs
 * @returns {Promise<{ targetId: string, url: string, title: string } | null>}
 */
async function waitForNewPage(cdp, known, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = await listPageTargets(cdp);
    const fresh = pages.find((p) => !known.has(p.targetId));
    if (fresh) return fresh;
    await sleep(200);
  }
  return null;
}

// ------------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.vault) throw new Error('--vault is required (never point this at the live vault)');
  if (!fs.existsSync(args.vault)) throw new Error(`vault does not exist: ${args.vault}`);
  assertNotLiveVault(args.vault);

  const terms = readTermsFromVendor();
  const server = await startServer(args.vault, args.port, terms);
  const url = args.url ?? `http://127.0.0.1:${args.port}/`;

  const report = {
    url,
    vault: args.vault,
    criteria: {},
    facts: {},
    console: { errors: [], exceptions: [] },
    popoutConsole: { errors: [], exceptions: [] },
  };

  const chromePort = args.chromePort ?? args.port + 1000;
  const chrome = await launchChrome(chromePort);
  const cdp = new Cdp(chrome.wsUrl);

  /** @type {string | null} */
  let popoutSessionId = null;

  const capture = (bucket, msg) => {
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? [])
        .map((a) => a.value ?? a.description ?? a.type)
        .join(' ');
      if (msg.params.type === 'error') bucket.errors.push(text);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      const ex = d.exception ?? {};
      const where = d.url ? ` @ ${d.url}:${d.lineNumber ?? 0}` : '';
      bucket.exceptions.push(
        (ex.description || d.text || ex.className || 'unknown exception') + where,
      );
    }
  };

  try {
    await cdp.connect();
    // One fan-out: events carry the session they came from, so "no new
    // exceptions in the main window" cannot be satisfied by a popout that
    // throws (and vice versa).
    cdp.on((msg) => {
      if (msg.method !== 'Runtime.consoleAPICalled' && msg.method !== 'Runtime.exceptionThrown') {
        return;
      }
      if (popoutSessionId && msg.sessionId === popoutSessionId) capture(report.popoutConsole, msg);
      else capture(report.console, msg);
    });

    // The main page ------------------------------------------------------
    const { targetId: mainTargetId } = await cdp.send('Target.createTarget', {
      url: 'about:blank',
    });
    const mainSession = await attachToPage(cdp, mainTargetId);
    await cdp.send('Runtime.enable', {}, mainSession);
    await cdp.send('Page.enable', {}, mainSession);
    await cdp.send('Log.enable', {}, mainSession).catch(() => {});

    const evaluate = (expression) => evalInPage(cdp, mainSession, expression);
    const waitFor = (expression, timeoutMs) => waitForPage(cdp, mainSession, expression, timeoutMs);

    const waitForApp = async () => {
      const deadline = Date.now() + args.timeout * 1000;
      while (Date.now() < deadline) {
        const ready = await evaluate('typeof window.app !== "undefined" && !!window.app').catch(
          () => false,
        );
        if (ready) return true;
        const fatal = await evaluate(
          '(function(){var e=document.getElementById("myobs-fatal");return !!(e && !e.hidden && e.style.display !== "none");})()',
        ).catch(() => false);
        if (fatal) {
          const detail = await evaluate(
            '(document.getElementById("myobs-fatal-detail")||{}).textContent || ""',
          ).catch(() => '');
          throw new Error(`runtime showed the fatal screen:\n${detail}`);
        }
        await sleep(300);
      }
      throw new Error('window.app never appeared');
    };

    await cdp.send('Page.navigate', { url }, mainSession);
    await waitForApp();
    report.criteria.appBooted = true;

    /*
     * Community plugins are gated by per-vault localStorage state, and on a
     * fresh Chrome profile Obsidian puts its own "Do you trust the author of
     * this vault?" modal in front of everything — its backdrop swallows input.
     * Persist the decision and reload: the second boot is the production path
     * (the same trick tools/hotreload-check.mjs uses for plugin loading).
     */
    const appId = await evaluate('window.app.appId');
    const tokenBefore = await evaluate('String((window.__MYOBS||{}).sessionToken || "")');
    report.facts.appId = appId;
    await evaluate(
      `localStorage.setItem(${JSON.stringify(`enable-plugin-${appId}`)}, "true"); "ok"`,
    );
    await cdp.send('Page.navigate', { url }, mainSession);
    report.facts.documentReloaded = await waitFor(
      `!!window.app && String((window.__MYOBS||{}).sessionToken || "") !== ${JSON.stringify(tokenBefore)}`,
      args.timeout * 1000,
    );

    const coveringModal = await evaluate(`(function () {
      const bg = Array.from(document.querySelectorAll('.modal-bg')).find(function (el) {
        return getComputedStyle(el).display !== 'none' && Number(getComputedStyle(el).opacity) > 0;
      });
      if (!bg) return null;
      const modal = bg.parentElement ? bg.parentElement.querySelector('.modal') : null;
      return {
        modalClass: modal ? String(modal.className) : '',
        title: modal ? String((modal.querySelector('.modal-title') || {}).textContent || '') : '',
      };
    })()`);
    report.facts.coveringModal = coveringModal;

    // The vault scan fills in asynchronously; the note pick below needs it.
    await waitFor('app.vault.getFiles().length > 0', args.timeout * 1000);
    // Layout is built asynchronously too: before it exists rootSplit is null and
    // getLeaf() throws (unlike the vault API, opening a *view* needs the layout).
    report.facts.layoutReady = await waitFor(
      '!!(app.workspace && app.workspace.rootSplit && document.querySelector(".workspace-leaf"))',
      30000,
    );
    await sleep(500);

    // Designated note ----------------------------------------------------
    const notePath =
      args.file ??
      (await evaluate(`(function () {
        const files = app.vault.getMarkdownFiles();
        const target = files.find((f) => f.path === 'AGENTS.md') || files[0];
        return target ? target.path : null;
      })()`));
    if (!notePath) throw new Error('no markdown file found in the vault');
    report.facts.notePath = notePath;

    const noteFile = path.join(args.vault, ...notePath.split('/'));
    const noteOriginal = fs.readFileSync(noteFile, 'utf8');

    report.facts.activeFileBeforePopout = await evaluate(`(async function () {
      const file = app.vault.getAbstractFileByPath(${JSON.stringify(notePath)});
      if (!file) return 'missing';
      let leaf = null;
      try {
        leaf = app.workspace.getLeaf(false);
      } catch (err) {
        leaf = null;
      }
      if (!leaf) leaf = app.workspace.getLeaf(true);
      await leaf.openFile(file, { active: true });
      return app.workspace.getActiveFile() ? app.workspace.getActiveFile().path : null;
    })()`);
    await waitFor(
      `!!app.workspace.getActiveFile() && app.workspace.getActiveFile().path === ${JSON.stringify(notePath)}`,
      10000,
    );

    // Trigger A: command palette -> "Open current tab in new window" -------
    const pagesBefore = new Set((await listPageTargets(cdp)).map((p) => p.targetId));
    report.facts.pagesBefore = [...pagesBefore].length;

    const key = (type, options) => cdp.send('Input.dispatchKeyEvent', { type, ...options }, mainSession);
    // Mod+P: Meta on macOS, Control elsewhere. The bundle's own default hotkey.
    const isMac = await evaluate('/Mac|iPhone|iPad/.test(navigator.platform)');
    const modifiers = isMac ? 4 : 2;
    const modP = {
      modifiers,
      key: 'p',
      code: 'KeyP',
      windowsVirtualKeyCode: 80,
      nativeVirtualKeyCode: 80,
    };
    await cdp.send('Page.bringToFront', {}, mainSession).catch(() => {});
    await key('keyDown', modP);
    await key('keyUp', modP);

    report.facts.paletteOpened = await waitFor(`!!document.querySelector('.prompt')`, 10000);
    await cdp.send('Input.insertText', { text: 'open in new window' }, mainSession);
    await sleep(700);

    const suggestion = await evaluate(`(function () {
      const items = Array.from(document.querySelectorAll('.suggestion-item'));
      const labels = items.map(function (el) { return (el.textContent || '').trim(); });
      const index = labels.findIndex(function (text) {
        return /new window|新視窗|新窗口/i.test(text);
      });
      if (index === -1) return { labels, index };
      const r = items[index].getBoundingClientRect();
      return { labels, index, label: labels[index], x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    report.facts.paletteSuggestions = suggestion;
    if (!suggestion || suggestion.index === -1) {
      throw new Error(`no "new window" command in the palette: ${JSON.stringify(suggestion)}`);
    }

    // Mouse first (a click is the gesture a user performs), Enter as fallback.
    await clickAt(cdp, mainSession, { x: suggestion.x, y: suggestion.y }, { button: 'left' });
    let popout = await waitForNewPage(cdp, pagesBefore, 5000);
    report.facts.trigger = popout ? 'palette-click' : null;
    if (!popout) {
      const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await key('keyDown', enter);
      await key('keyUp', enter);
      popout = await waitForNewPage(cdp, pagesBefore, 8000);
      report.facts.trigger = popout ? 'palette-enter' : null;
    }

    report.criteria.popoutOpened = Boolean(popout);
    report.facts.popoutTarget = popout
      ? { targetId: popout.targetId, url: popout.url, title: popout.title }
      : null;
    report.facts.popoutEvents = await evaluate(
      'JSON.stringify(((window.__MYOBS_POPOUT||{}).events||[]).slice(-12))',
    ).catch(() => null);
    report.facts.popoutFrames = await evaluate(
      `JSON.stringify(((window.__MYOBS_POPOUT||{}).frames||[]).map(function (f) {
        return { at: f.at, file: f.file, instrumented: f.instrumented, error: f.error, features: f.features, requested: f.requested, background: f.background, closed: !!(f.win && f.win.closed) };
      }))`,
    ).catch(() => null);

    /** Verify one popout window end to end. */
    const inspectPopout = async (target, index) => {
      const startedAt = Date.now();
      const sessionId = await attachToPage(cdp, target.targetId);
      if (index === 0) popoutSessionId = sessionId;
      await cdp.send('Runtime.enable', {}, sessionId);
      await activateTarget(cdp, target.targetId);
      const ready = await waitForPage(
        cdp,
        sessionId,
        'typeof window.app !== "undefined" && !!window.app',
        15000,
      );
      const appReadyMs = Date.now() - startedAt;
      /*
       * window.open() returns before Obsidian has moved the leaf in, and the
       * file view itself loads asynchronously (vault read -> render), so the
       * popout owns its file only a moment later. Wait for that instead of
       * sampling a window that is still being filled.
       */
      const showsFile = await waitForPage(
        cdp,
        sessionId,
        `(function () {
          let owned = null;
          app.workspace.iterateAllLeaves(function (leaf) {
            if (owned || !leaf.containerEl || leaf.containerEl.ownerDocument !== document) return;
            if (leaf.view && leaf.view.file) owned = leaf.view.file.path;
          });
          return owned === ${JSON.stringify(notePath)};
        })()`,
        20000,
      );
      const showsFileMs = Date.now() - startedAt;
      const probe = await evalInPage(
        cdp,
        sessionId,
        `(function () {
          const host = window.__MYOBS_POPOUT_WINDOW;
          return {
            ready: typeof window.app !== 'undefined' && !!window.app,
            showsFile: ${showsFile === true},
            instrumented: !!host,
            openerIsHost: !!(host && window.opener === host.host),
            documentIsAboutBlank: String(location.href).indexOf('about:blank') === 0,
            shims: Object.keys(window.__MYOBS_MODULES || {}).length,
            requireNames: Object.keys(window.__MYOBS_MODULES || {}).sort(),
            electronAttached: !!(window.electron && window.electronWindow),
            hasEnhance: typeof window.createEl === 'function',
            hostAppIsSameObject: !!(host && host.host && host.host.app === window.app),
            hostWorkspaceIsSameObject: !!(host && host.host && host.host.app && host.host.app.workspace === app.workspace),
            activePath: app.workspace.getActiveFile() ? app.workspace.getActiveFile().path : null,
            ownedPath: (function () {
              let owned = null;
              app.workspace.iterateAllLeaves(function (leaf) {
                if (owned || !leaf.containerEl || leaf.containerEl.ownerDocument !== document) return;
                if (leaf.view && leaf.view.file) owned = leaf.view.file.path;
              });
              return owned;
            })(),
            ownToken: String((window.__MYOBS || {}).sessionToken || ''),
            hostToken: String((host && host.host && host.host.__MYOBS && host.host.__MYOBS.sessionToken) || ''),
            bodyClassCount: String(document.body.className).split(' ').filter(Boolean).length,
            isPopoutWindowClass: document.body.classList.contains('is-popout-window'),
            headHrefs: Array.from(document.head.querySelectorAll('link[rel=stylesheet]')).map(function (el) { return el.getAttribute('href'); }).slice(0, 4),
            size: { innerWidth: window.innerWidth, innerHeight: window.innerHeight, screenX: window.screenX, screenY: window.screenY },
            backgroundVeil: !!document.querySelector('[data-myobs-popout-background]'),
            containerPresent: !!document.querySelector('.app-container'),
            leafCount: document.querySelectorAll('.workspace-leaf').length,
            editorPresent: !!document.querySelector('.cm-content'),
            editorText: String((document.querySelector('.cm-content') || {}).textContent || '').slice(0, 60),
            title: document.title,
          };
        })()`,
      ).catch((err) => ({ error: err.message }));

      return { sessionId, ready, showsFile, timings: { appReadyMs, showsFileMs }, probe };
    };

    if (popout) {
      const { sessionId, ready, probe, timings } = await inspectPopout(popout, 0);
      report.facts.popoutTimings = timings;
      report.criteria.popoutApp =
        ready && probe.instrumented === true && probe.hostAppIsSameObject === true;
      report.facts.popoutRecord = await evalInPage(
        cdp,
        sessionId,
        'JSON.stringify({hostedBy:(window.__MYOBS_POPOUT_WINDOW||{}).hostedBy, at:(window.__MYOBS_POPOUT_WINDOW||{}).at, file:(window.__MYOBS_POPOUT_WINDOW||{}).file})',
      ).catch(() => null);
      report.facts.popoutRealm = probe;
      report.facts.popoutTokens = {
        own: probe.ownToken,
        host: probe.hostToken,
        distinct: Boolean(probe.ownToken) && probe.ownToken !== probe.hostToken,
      };

      // 4. the designated note ------------------------------------------
      // The host-side tracker polls (200 ms) for the leaf this popout owns, so
      // it can land just after the popout itself is up.
      report.facts.hostFileTracked = await waitFor(
        `!!(window.__MYOBS_POPOUT && window.__MYOBS_POPOUT.frames[0] && window.__MYOBS_POPOUT.frames[0].file === ${JSON.stringify(notePath)})`,
        15000,
      );
      const hostTrackedFile = await evaluate(
        'JSON.stringify((((window.__MYOBS_POPOUT||{}).frames||[])[0]||{}).file || null)',
      )
        .then((v) => JSON.parse(v))
        .catch(() => null);
      report.facts.popoutFile = {
        activePath: probe.activePath,
        ownedByPopout: probe.ownedPath,
        hostTrackedFile,
      };
      report.criteria.popoutFile =
        probe.activePath === notePath &&
        probe.ownedPath === notePath &&
        hostTrackedFile === notePath;

      // 5. writing from the popout reaches the disk ----------------------
      const marker = `<!-- myobs-popout ${Date.now()} -->`;
      const writeResult = await evalInPage(
        cdp,
        sessionId,
        `(async function () {
          const file = app.vault.getAbstractFileByPath(${JSON.stringify(notePath)});
          if (!file) return 'missing';
          const original = await app.vault.read(file);
          await app.vault.modify(file, original + '\\n\\n' + ${JSON.stringify(marker)} + '\\n');
          return 'written';
        })()`,
      ).catch((err) => `error: ${err.message}`);

      // The marker has to be visible on disk *before* the original content is
      // restored, otherwise this proves nothing.
      let sawMarkerOnDisk = false;
      const writeDeadline = Date.now() + 5000;
      while (Date.now() < writeDeadline) {
        if (fs.readFileSync(noteFile, 'utf8').includes(marker)) {
          sawMarkerOnDisk = true;
          break;
        }
        await sleep(150);
      }

      const restoreResult = await evalInPage(
        cdp,
        sessionId,
        `(async function () {
          const file = app.vault.getAbstractFileByPath(${JSON.stringify(notePath)});
          await app.vault.modify(file, ${JSON.stringify(noteOriginal)});
          return 'restored';
        })()`,
      ).catch((err) => `error: ${err.message}`);
      await sleep(500);

      report.facts.popoutWrite = {
        writeResult,
        sawMarkerOnDisk,
        restoreResult,
        restored: fs.readFileSync(noteFile, 'utf8') === noteOriginal,
      };
      report.criteria.popoutWrite =
        writeResult === 'written' && sawMarkerOnDisk && report.facts.popoutWrite.restored;

      // Extra fact: the popout realm's own fs shim, its own document token.
      const scratchAbs = `${args.vault}/${SCRATCH_REL}`;
      const realmWrite = await evalInPage(
        cdp,
        sessionId,
        `(async function () {
          const fs = window.__MYOBS_MODULES.fs;
          const abs = ${JSON.stringify(scratchAbs)};
          await fs.promises.writeFile(abs, 'popout-realm ' + Date.now());
          const back = await fs.promises.readFile(abs, 'utf8');
          await fs.promises.unlink(abs);
          return back;
        })()`,
      ).catch((err) => `error: ${err.message}`);
      report.facts.popoutRealmWrite = {
        result: typeof realmWrite === 'string' ? realmWrite.slice(0, 40) : realmWrite,
        scratchLeftOnDisk: fs.existsSync(path.join(args.vault, SCRATCH_REL)),
      };

      /*
       * "The popout is usable" is not the same as "the popout has a leaf": type
       * into its editor with real input events and see whether the character
       * reaches the disk. This is the one assertion that covers the whole chain
       * (popout DOM is alive -> CM6 receives input -> adapter writes -> server
       * writes the file) instead of the API around it.
       */
      const editorRect = await evalInPage(
        cdp,
        sessionId,
        `(function () {
          const el = document.querySelector('.cm-content');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left + 40, y: r.top + 24, text: String(el.textContent || '').slice(0, 40) };
        })()`,
      ).catch(() => null);
      const typing = { editorRect };
      if (editorRect) {
        const typingMarker = `<!-- myobs-popout-typing ${Date.now()} -->`;
        await clickAt(cdp, sessionId, { x: editorRect.x, y: editorRect.y }, { button: 'left' });
        await sleep(300);
        await cdp.send('Input.insertText', { text: `\n\n${typingMarker}\n` }, sessionId);
        let typedToDisk = false;
        const typeDeadline = Date.now() + 10000;
        while (Date.now() < typeDeadline) {
          if (fs.readFileSync(noteFile, 'utf8').includes(typingMarker)) {
            typedToDisk = true;
            break;
          }
          await sleep(250);
        }
        typing.typedToDisk = typedToDisk;
        // Restore through the vault API (the same path a view reload triggers)
        // and confirm the file is byte-identical again.
        typing.restoreResult = await evalInPage(
          cdp,
          sessionId,
          `(async function () {
            const file = app.vault.getAbstractFileByPath(${JSON.stringify(notePath)});
            await app.vault.modify(file, ${JSON.stringify(noteOriginal)});
            return 'restored';
          })()`,
        ).catch((err) => `error: ${err.message}`);
        await sleep(1200);
        typing.restored = fs.readFileSync(noteFile, 'utf8') === noteOriginal;
        report.criteria.popoutTyping = typedToDisk === true && typing.restored === true;
      }
      report.facts.popoutTyping = typing;

      /*
       * Closing the popout is not part of the acceptance list, but its
       * beforeunload path is the one place the bundle touches
       * `popout.electron` unguarded (x3: `c.electron.ipcRenderer.sendSync(
       * "is-quitting") ? e.preventDefault() : r.close()`), so a missing electron
       * in the popout realm shows up here and nowhere else.
       */
      const closeResult = await evalInPage(cdp, sessionId, 'window.close(); "closing"').catch(
        (err) => `error: ${err.message}`,
      );
      let closed = false;
      const closeDeadline = Date.now() + 8000;
      while (Date.now() < closeDeadline) {
        const pages = await listPageTargets(cdp);
        if (!pages.some((p) => p.targetId === popout.targetId)) {
          closed = true;
          break;
        }
        await sleep(200);
      }
      await sleep(1500);
      report.facts.popoutClose = {
        closeResult,
        targetGone: closed,
        proxyReportsClosed: await evaluate(
          '((window.__MYOBS_POPOUT||{}).frames[0]||{}).win ? window.__MYOBS_POPOUT.frames[0].win.closed : "no-proxy"',
        ).catch((err) => `error: ${err.message}`),
      };
    }

    // Trigger B: the #popout deep link, confirmed by a click ---------------
    const pagesBeforeB = new Set((await listPageTargets(cdp)).map((p) => p.targetId));
    await evaluate(`location.hash = "#popout=" + encodeURIComponent(${JSON.stringify(notePath)}); "ok"`);
    const noticeShown = await waitFor(
      `!!(document.getElementById('myobs-popout-notice') && Array.from(document.querySelectorAll('#myobs-popout-notice button')).some(function (b) { return b.textContent.indexOf('開啟') !== -1; }))`,
      10000,
    );
    report.facts.deepLinkNotice = noticeShown;
    let secondPopout = null;
    if (noticeShown) {
      const buttonRect = await evaluate(`(function () {
        const buttons = Array.from(document.querySelectorAll('#myobs-popout-notice button'));
        const open = buttons.find(function (b) { return b.textContent.indexOf('開啟') !== -1; });
        const r = open.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: open.textContent };
      })()`);
      await clickAt(cdp, mainSession, buttonRect, { button: 'left' });
      secondPopout = await waitForNewPage(cdp, pagesBeforeB, 8000);
      report.facts.deepLinkPopout = secondPopout
        ? { targetId: secondPopout.targetId, url: secondPopout.url, title: secondPopout.title }
        : null;
      if (secondPopout) {
        const second = await inspectPopout(secondPopout, 1);
        report.facts.deepLinkTimings = second.timings;
        report.facts.deepLinkFile = {
          ready: second.probe.ready === true,
          ownedByPopout: second.probe.ownedPath,
          activePath: second.probe.activePath,
        };
        report.criteria.deepLinkPopout =
          second.probe.ready === true && second.probe.ownedPath === notePath;
      } else {
        report.criteria.deepLinkPopout = false;
      }
    }

    // Evidence for the menu-bar gap (not a criterion: menus are a separate
    // DESIGN.md §3 item 5 feature, tracked in GAPS.md §2).
    const headerRect = await evaluate(`(function () {
      const header =
        Array.from(document.querySelectorAll('.mod-root .workspace-tab-header.mod-active')).pop() ||
        Array.from(document.querySelectorAll('.workspace-tab-header.mod-active')).pop();
      if (!header) return null;
      const r = header.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (headerRect) {
      await clickAt(cdp, mainSession, headerRect, { button: 'right' });
      await sleep(900);
      report.facts.tabHeaderMenu = await evaluate(`JSON.stringify({
        menuInDom: document.querySelectorAll('.menu').length,
        headerHasActiveMenu: Array.from(document.querySelectorAll('.workspace-tab-header')).some(function (h) { return h.classList.contains('has-active-menu'); }),
        nativeMenuTemplateRecorded: !!(window.__MYOBS_IPC && window.__MYOBS_IPC.lastMenuItems && window.__MYOBS_IPC.lastMenuItems()),
        nativeMenuUseFlag: (function () { try { return app.vault.getConfig('nativeMenus'); } catch (e) { return 'n/a'; } })()
      })`).catch((err) => `error: ${err.message}`);
      await key('keyDown', { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await key('keyUp', { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    }

    // Blocked-popup UX: every block must surface a notice (boot-time restore of
    // a saved popout window is the common case, since it has no user gesture).
    report.facts.blockedNotice = await evaluate(`(function () {
      const blocked = ((window.__MYOBS_POPOUT || {}).blocked) || 0;
      const root = document.getElementById('myobs-popout-notice');
      return {
        blocked,
        noticeVisible: !!root,
        text: root ? String(root.textContent).slice(0, 120) : null,
        hasRetryButton: !!(root && Array.from(root.querySelectorAll('button')).some(function (b) { return b.textContent.indexOf('新視窗') !== -1; })),
      };
    })()`);

    // 6. the main window survived -----------------------------------------
    const mainState = await evaluate(`(function () {
      return {
        app: typeof window.app !== 'undefined' && !!window.app,
        activeFile: app.workspace && app.workspace.getActiveFile() ? app.workspace.getActiveFile().path : null,
        fatalVisible: (function () {
          const el = document.getElementById('myobs-fatal');
          return !!(el && !el.hidden && el.style.display !== 'none');
        })(),
        popoutFrames: (((window.__MYOBS_POPOUT || {}).frames) || []).length,
        popoutBlocked: ((window.__MYOBS_POPOUT || {}).blocked) || 0,
      };
    })()`);
    report.facts.mainWindow = mainState;
    report.criteria.mainWindowIntact =
      mainState.app === true && mainState.fatalVisible === false && report.console.exceptions.length === 0;

    report.diagnostics = {
      pagesAfter: (await listPageTargets(cdp)).map((p) => ({
        targetId: p.targetId,
        url: p.url,
        title: p.title,
      })),
      hostEvents: await evaluate(
        'JSON.stringify(((window.__MYOBS_POPOUT||{}).events||[]).slice(-20))',
      ).catch(() => null),
    };

    // Leave the vault as it was found.
    if (fs.existsSync(path.join(args.vault, SCRATCH_REL))) {
      fs.unlinkSync(path.join(args.vault, SCRATCH_REL));
    }
    if (fs.readFileSync(noteFile, 'utf8') !== noteOriginal) {
      fs.writeFileSync(noteFile, noteOriginal);
    }
  } finally {
    cdp.close();
    chrome.child.kill();
    server.child.kill();
  }

  const passed = Object.values(report.criteria).every(Boolean);
  report.passed = passed;

  if (args.log) {
    fs.writeFileSync(args.log, server.logs.join(''));
    console.log(`[trace] server log written to ${args.log}`);
  }

  console.log(JSON.stringify(report, null, 2));
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(report, null, 2));

  if (report.console.exceptions.length || report.popoutConsole.exceptions.length) {
    console.log('\n--- exceptions (main | popout) ---');
    for (const e of report.console.exceptions.slice(0, 10)) console.log(`main: ${e}`);
    for (const e of report.popoutConsole.exceptions.slice(0, 10)) console.log(`popout: ${e}`);
  }

  process.exitCode = passed ? 0 : 1;
}

main().catch((err) => {
  console.error('popout-check failed:', err.message);
  process.exitCode = 2;
});
