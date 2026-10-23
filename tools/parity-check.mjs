#!/usr/bin/env node
/**
 * Popout parity harness: the popout realm must load its own runtime modules.
 *
 * Zero dependencies; drives the local Chrome over CDP through tools/lib/cdp.mjs
 * (frozen, read-only). See DESIGN.md §11.8 and §11.10.
 *
 * Criteria:
 *   1. mainBooted        — the hosting page booted (window.app exists)
 *   2. popoutOpened      — the command palette's "Open current tab in new
 *                          window" produced a second page target from a real
 *                          gesture (click / Enter on the palette suggestion)
 *   3. popoutRuntime     — the popout realm has its own __MYOBS_MENU and
 *                          __MYOBS_PRINT
 *   4. noPluginWatch     — the popout realm has no __MYOBS_PLUGIN_WATCH (one
 *                          hot-reload cycle per app, not one per window)
 *   5. popoutExport      — opening a *different* note in the popout and
 *                          running Export to PDF there prints that note:
 *                          __MYOBS_PRINT.lastResult.path === popout note
 *   6. hostUntouched     — the host's active file, active view DOM and print
 *                          state are unchanged by the popout export
 *   7. popoutContextMenu — right-clicking inside the popout opens a visible
 *                          menu (native-template fallback or Obsidian's HTML)
 *
 * Usage:
 *   node tools/parity-check.mjs --vault <copy-of-vault> [--port 3937]
 *                               [--timeout 90] [--json <out.json>]
 *
 * Never point --vault at the live vault (AGENTS.md hard rule 4).
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  Cdp,
  assertNotLiveVault,
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


// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = {
    url: null,
    vault: null,
    file: null,
    timeout: 90,
    json: null,
    port: 3937,
    chromePort: null,
    log: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url') out.url = argv[++i];
    else if (arg === '--vault') out.vault = argv[++i];
    else if (arg === '--file') out.file = argv[++i];
    else if (arg === '--timeout') out.timeout = Number(argv[++i]);
    else if (arg === '--json') out.json = argv[++i];
    else if (arg === '--port') out.port = Number(argv[++i]);
    else if (arg === '--chrome-port') out.chromePort = Number(argv[++i]);
    else if (arg === '--log') out.log = argv[++i];
  }
  return out;
}

/** @param {string} vault */

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
      bucket.exceptions.push((ex.description || d.text || ex.className || 'unknown') + where);
    }
  };

  try {
    await cdp.connect();
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
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      mainSession,
    );

    const evaluate = (expression) => evalInPage(cdp, mainSession, expression);
    const key = (type, options) =>
      cdp.send('Input.dispatchKeyEvent', { type, ...options }, mainSession);

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

    /*
     * Obsidian's community-plugin trust prompt covers the whole workspace on a
     * fresh Chrome profile, and its backdrop swallows palette input. Persist
     * the decision and reload, exactly like tools/popout-check.mjs does.
     */
    const appId = await evaluate('window.app.appId');
    const tokenBefore = await evaluate('String((window.__MYOBS||{}).sessionToken || "")');
    report.facts.appId = appId;
    await evaluate(`localStorage.setItem(${JSON.stringify(`enable-plugin-${appId}`)}, "true"); "ok"`);
    await cdp.send('Page.navigate', { url }, mainSession);
    report.facts.documentReloaded = await waitForPage(
      cdp,
      mainSession,
      `!!window.app && String((window.__MYOBS||{}).sessionToken || "") !== ${JSON.stringify(tokenBefore)}`,
      args.timeout * 1000,
    );
    report.criteria.mainBooted = report.facts.documentReloaded === true;

    await waitForPage(
      cdp,
      mainSession,
      '!!(app.workspace && app.workspace.rootSplit && document.querySelector(".workspace-leaf"))',
      30000,
    );
    await waitForPage(cdp, mainSession, 'app.vault.getFiles().length > 0', 30000);
    await sleep(500);

    // Two small notes: one stays in the host, one moves to the popout.
    const notes = await evaluate(`(function () {
      return app.vault
        .getMarkdownFiles()
        .filter(function (f) { return f.stat && f.stat.size > 100 && f.stat.size < 60000; })
        .map(function (f) { return f.path; })
        .slice(0, 40);
    })()`);
    if (!Array.isArray(notes) || notes.length < 2) {
      throw new Error(`need at least two small markdown notes, found ${notes?.length ?? 0}`);
    }
    const hostNote = args.file && notes.includes(args.file) ? args.file : notes[0];
    const popoutNote = notes.find((p) => p !== hostNote);
    if (!popoutNote) throw new Error('no second note available for the popout');
    report.facts.notes = { hostNote, popoutNote };

    await evaluate(`(async function () {
      const file = app.vault.getAbstractFileByPath(${JSON.stringify(hostNote)});
      const leaf = app.workspace.getLeaf(false) || app.workspace.getLeaf(true);
      await leaf.openFile(file, { active: true });
      return true;
    })()`);
    await waitForPage(
      cdp,
      mainSession,
      `!!app.workspace.getActiveFile() && app.workspace.getActiveFile().path === ${JSON.stringify(hostNote)}`,
      10000,
    );
    await waitForPage(
      cdp,
      mainSession,
      '!!document.querySelector(".workspace-leaf.mod-active .markdown-preview-view, .workspace-leaf.mod-active .markdown-source-view")',
      15000,
    );

    // Open the popout from the command palette with a real gesture ---------
    const pagesBefore = new Set((await listPageTargets(cdp)).map((p) => p.targetId));
    const modP = {
      modifiers: 4, // Meta; this runtime is exercised on macOS Chrome
      key: 'p',
      code: 'KeyP',
      windowsVirtualKeyCode: 80,
      nativeVirtualKeyCode: 80,
    };
    await cdp.send('Page.bringToFront', {}, mainSession).catch(() => {});
    await key('keyDown', modP);
    await key('keyUp', modP);
    report.facts.paletteOpened = await waitForPage(cdp, mainSession, `!!document.querySelector('.prompt')`, 10000);
    await cdp.send('Input.insertText', { text: 'open in new window' }, mainSession);
    await sleep(700);

    const suggestion = await evaluate(`(function () {
      const items = Array.from(document.querySelectorAll('.suggestion-item'));
      const labels = items.map(function (el) { return (el.textContent || '').trim(); });
      const index = labels.findIndex(function (text) { return /new window|新視窗|新窗口/i.test(text); });
      if (index === -1) return { labels, index };
      const r = items[index].getBoundingClientRect();
      return { labels, index, label: labels[index], x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    report.facts.paletteSuggestion = suggestion;
    if (!suggestion || suggestion.index === -1) {
      throw new Error(`no "new window" command in the palette: ${JSON.stringify(suggestion)}`);
    }

    const waitForNewPage = async (known, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const pages = await listPageTargets(cdp);
        const fresh = pages.find((p) => !known.has(p.targetId));
        if (fresh) return fresh;
        await sleep(200);
      }
      return null;
    };

    await clickAt(cdp, mainSession, { x: suggestion.x, y: suggestion.y }, { button: 'left' });
    let popout = await waitForNewPage(pagesBefore, 5000);
    report.facts.trigger = popout ? 'palette-click' : null;
    if (!popout) {
      const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await key('keyDown', enter);
      await key('keyUp', enter);
      popout = await waitForNewPage(pagesBefore, 8000);
      report.facts.trigger = popout ? 'palette-enter' : null;
    }
    report.criteria.popoutOpened = Boolean(popout);
    report.facts.popoutTarget = popout
      ? { targetId: popout.targetId, url: popout.url, title: popout.title }
      : null;
    if (!popout) throw new Error('the command palette never opened a new window');

    // The popout realm ----------------------------------------------------
    popoutSessionId = await attachToPage(cdp, popout.targetId);
    await cdp.send('Runtime.enable', {}, popoutSessionId);
    await cdp.send('Page.enable', {}, popoutSessionId).catch(() => {});
    await activateTarget(cdp, popout.targetId);
    const popoutEvaluate = (expression) => evalInPage(cdp, popoutSessionId, expression);
    report.facts.popoutApp = await waitForPage(
      cdp,
      popoutSessionId,
      'typeof window.app !== "undefined" && !!window.app',
      20000,
    );
    await waitForPage(cdp, popoutSessionId, '!!document.querySelector(".app-container")', 20000);

    const realm = JSON.parse(
      await popoutEvaluate(`JSON.stringify({
        menuInstalled: !!(window.__MYOBS_MENU && window.__MYOBS_MENU.installed === true),
        printInstalled: !!(window.__MYOBS_PRINT && window.__MYOBS_PRINT.installed === true),
        menuHandle: typeof (window.__MYOBS_MENU && window.__MYOBS_MENU.buildContextReply),
        printHandle: typeof (window.__MYOBS_PRINT && window.__MYOBS_PRINT.handleIpc),
        pluginWatch: typeof window.__MYOBS_PLUGIN_WATCH,
        watchShim: typeof window.__MYOBS_WATCH,
        notices: typeof window.__MYOBS_NOTICES,
        modules: Object.keys(window.__MYOBS_MODULES || {}).sort(),
        shims: Object.keys(window.__MYOBS_MODULES || {}).length,
        hasElectron: !!(window.electron && window.electronWindow),
        ownPrintLastResult: window.__MYOBS_PRINT ? window.__MYOBS_PRINT.lastResult : null,
      })`),
    );
    report.facts.popoutRealm = realm;
    report.criteria.popoutRuntime = realm.menuInstalled && realm.printInstalled;
    report.criteria.noPluginWatch = realm.pluginWatch === 'undefined';

    // Open a *different* note inside the popout ---------------------------
    // openFile() resolves before the workspace has swapped the leaf's view;
    // a fixed 600ms sleep was flaky on a cold metadata cache (the leaf was
    // still showing the host note). Poll the leaf paths instead.
    const openResult = await popoutEvaluate(`(async function () {
      const file = app.vault.getAbstractFileByPath(${JSON.stringify(popoutNote)});
      if (!file) return { ok: false, why: 'file missing' };
      let leaf = null;
      app.workspace.iterateAllLeaves(function (candidate) {
        if (leaf || !candidate.containerEl || candidate.containerEl.ownerDocument !== document) return;
        leaf = candidate;
      });
      if (!leaf) return { ok: false, why: 'no leaf in the popout document' };
      await leaf.openFile(file, { active: true });
      return { ok: true };
    })()`);
    if (!openResult?.ok) {
      throw new Error(`could not prepare the popout leaf: ${JSON.stringify(openResult)}`);
    }

    const readPopoutLeaves = () => popoutEvaluate(`(function () {
      var paths = [];
      app.workspace.iterateAllLeaves(function (candidate) {
        if (!candidate.containerEl || candidate.containerEl.ownerDocument !== document) return;
        if (candidate.view && candidate.view.file) paths.push(candidate.view.file.path);
      });
      return { activePath: (app.workspace.getActiveFile() || {}).path || null, paths: paths };
    })()`);
    const openedDeadline = Date.now() + 20000;
    let opened = null;
    while (Date.now() < openedDeadline) {
      opened = await readPopoutLeaves();
      if (opened && opened.paths.includes(popoutNote)) break;
      await sleep(250);
    }
    opened = opened || { activePath: null, paths: [] };
    // The popout can hold more than one leaf (the cloned host tab plus the
    // note opened here), so scan every popout leaf instead of taking the
    // first one. First-leaf ordering made this fail on vaults with fixture
    // copies that share a basename.
    opened.ownedPath = opened.paths.includes(popoutNote) ? popoutNote : (opened.paths[0] || null);
    report.facts.popoutNoteOpened = opened;
    if (opened.ownedPath !== popoutNote) {
      throw new Error(`could not open ${popoutNote} in the popout: ${JSON.stringify(opened)}`);
    }
    const popoutNoteText = await popoutEvaluate(
      `(async function () {
        const file = app.vault.getAbstractFileByPath(${JSON.stringify(popoutNote)});
        return file ? await app.vault.read(file) : null;
      })()`,
    ).catch(() => null);
    report.facts.popoutNoteChars = popoutNoteText ? popoutNoteText.length : null;
    await waitForPage(
      cdp,
      popoutSessionId,
      '!!document.querySelector(".workspace-leaf.mod-active .markdown-preview-view, .workspace-leaf.mod-active .markdown-source-view")',
      20000,
    );

    /*
     * The host document's own views, independent of which leaf is globally
     * "active" (that flips to the popout as soon as it is focused). The export
     * must not move any of them, so identity, containment and count are all
     * compared before/after.
     */
    const HOST_VIEW_STATE = `(function () {
      const views = [];
      app.workspace.iterateAllLeaves(function (leaf) {
        if (!leaf.containerEl || leaf.containerEl.ownerDocument !== document) return;
        const view = leaf.containerEl.querySelector('.markdown-preview-view, .markdown-source-view');
        if (!view) return;
        views.push({
          path: leaf.view && leaf.view.file ? leaf.view.file.path : null,
          inApp: !!(view.closest && view.closest('.app-container')),
          connected: view.isConnected,
        });
      });
      views.sort(function (a, b) { return String(a.path).localeCompare(String(b.path)); });
      return JSON.stringify(views);
    })()`;

    // Host state before the popout export --------------------------------
    const hostBefore = JSON.parse(
      await evaluate(`JSON.stringify({
        activeFile: (app.workspace.getActiveFile() || {}).path || null,
        bodyClass: document.body.className,
        hostViewState: ${HOST_VIEW_STATE},
        printLastResult: window.__MYOBS_PRINT ? window.__MYOBS_PRINT.lastResult : null,
        printEvents: ((window.__MYOBS_PRINT || {}).events || []).length,
        printRoot: !!document.getElementById('myobs-print-root'),
        printStyle: !!document.getElementById('myobs-print-style'),
      })`),
    );
    hostBefore.hostViews = JSON.parse(hostBefore.hostViewState);
    delete hostBefore.hostViewState;
    report.facts.hostBefore = hostBefore;

    // Export to PDF from the popout ---------------------------------------
    const exportTrigger = await popoutEvaluate(`(async function () {
      // Force the synthetic save path: a headless browser has no picker UI.
      window.showSaveFilePicker = undefined;
      const probe = { printCalls: 0, snapshots: [] };
      window.__myobsParityPrint = probe;
      const originalPrint = window.print;
      window.print = function () {
        probe.printCalls += 1;
        const target = document.querySelector('.myobs-print-target');
        const view = target && target.querySelector('.markdown-preview-view, .markdown-source-view');
        probe.snapshots.push({
          realmDocTitle: String(document.title),
          targetPresent: !!target,
          targetPath: target ? target.getAttribute('data-path') : null,
          targetOwnerIsPopoutDoc: target ? target.ownerDocument === document : null,
          text: view ? String(view.innerText || '').replace(/\\s+/g, ' ').slice(0, 200) : null,
        });
        return originalPrint.apply(window, arguments);
      };
      const beforeAt = ((window.__MYOBS_PRINT || {}).lastResult || {}).at || 0;
      const opened = app.commands.executeCommandById('workspace:export-pdf');
      await new Promise(function (resolve) { window.setTimeout(resolve, 300); });
      const containers = Array.from(document.querySelectorAll('.modal-container'));
      const modal = containers.find(function (el) { return /Export to PDF/i.test(el.innerText || ''); }) || null;
      if (!modal) {
        return { ok: false, why: 'modal did not open in the popout document', opened };
      }
      const cta = Array.from(modal.querySelectorAll('button')).find(function (button) {
        return button.classList.contains('mod-cta');
      });
      if (!cta) {
        return {
          ok: false,
          why: 'no primary button',
          labels: Array.from(modal.querySelectorAll('button')).map(function (b) { return b.textContent; }),
        };
      }
      cta.click();
      return { ok: true, beforeAt, label: cta.textContent };
    })()`);
    report.facts.exportTrigger = exportTrigger;
    const printed = exportTrigger?.ok
      ? await waitForPage(
          cdp,
          popoutSessionId,
          `(function () {
            const r = window.__MYOBS_PRINT && window.__MYOBS_PRINT.lastResult;
            return !!(r && r.printed === true && r.at > ${Number(exportTrigger.beforeAt)});
          })()`,
          30000,
        )
      : false;
    await sleep(700);

    const popoutAfter = JSON.parse(
      await popoutEvaluate(`JSON.stringify({
        lastResult: (window.__MYOBS_PRINT || {}).lastResult || null,
        printCalls: (window.__myobsParityPrint || {}).printCalls || 0,
        printSnapshots: (window.__myobsParityPrint || {}).snapshots || [],
        bodyClass: document.body.className,
        activeFile: (app.workspace.getActiveFile() || {}).path || null,
        pdfSurface: !!document.querySelector('iframe[data-myobs-pdf-surface]'),
        modalOpen: Array.from(document.querySelectorAll('.modal-container')).some(function (el) {
          const style = getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0 && /export to pdf/i.test(el.innerText || '');
        }),
        // Failure diagnostics: what the popout's own print module saw.
        printEvents: ((window.__MYOBS_PRINT || {}).events || []).slice(-10),
        printListeners: typeof window.__MYOBS_PRINT.listeners === 'number' ? window.__MYOBS_PRINT.listeners : null,
        dialogCalls: ((window.__MYOBS_DIALOG || {}).calls || []).slice(-3).map(function (call) {
          return { method: call.method, result: call.result };
        }),
        modals: Array.from(document.querySelectorAll('.modal-container')).map(function (el) {
          const style = getComputedStyle(el);
          return { cls: el.className, display: style.display, rects: el.getClientRects().length, text: (el.innerText || '').slice(0, 60) };
        }),
      })`),
    );
    report.facts.popoutAfterExport = popoutAfter;

    /*
     * Content check: the DOM that was actually moved into the popout's print
     * root must show the popout note's text, not an empty host leaf. Markdown
     * syntax is stripped so the needle also exists in reading view output.
     */
    const snapshot = (popoutAfter.printSnapshots || [])[0] || null;
    /*
     * Same normalisation on both sides: strip markdown punctuation, collapse
     * whitespace. Up to three candidate needles are taken from the note's body
     * (YAML frontmatter and short lines skipped) because reading view hides
     * frontmatter while source view shows it, and the snapshot is only the
     * first 200 characters.
     */
    const flat = (value) =>
      String(value || '')
        .replace(/[#*_>`[\]()!-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const needles = [];
    {
      let inFrontmatter = false;
      let frontmatterClosed = false;
      for (const raw of String(popoutNoteText || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!frontmatterClosed && line === '---') {
          inFrontmatter = !inFrontmatter;
          if (!inFrontmatter) frontmatterClosed = true;
          continue;
        }
        if (inFrontmatter) continue;
        const cleaned = flat(line);
        if (cleaned.length >= 12) needles.push(cleaned.slice(0, 14));
        if (needles.length >= 3) break;
      }
    }
    const printedText = flat(snapshot?.text);
    report.facts.printedNote = {
      targetPath: snapshot?.targetPath ?? null,
      textLength: printedText.length,
      needles,
      matchedNeedle: needles.find((needle) => printedText.includes(needle)) ?? null,
    };
    report.facts.printedNote.containsNeedle = report.facts.printedNote.matchedNeedle !== null;

    report.criteria.popoutExport =
      printed === true &&
      popoutAfter.lastResult?.ok === true &&
      popoutAfter.lastResult?.printed === true &&
      popoutAfter.lastResult?.path === popoutNote &&
      popoutAfter.lastResult?.fileWritten === false &&
      snapshot?.targetPath === popoutNote &&
      report.facts.printedNote.containsNeedle === true;

    // Host state after the popout export ----------------------------------
    const hostAfter = JSON.parse(
      await evaluate(`JSON.stringify({
        activeFile: (app.workspace.getActiveFile() || {}).path || null,
        bodyClass: document.body.className,
        hostViewState: ${HOST_VIEW_STATE},
        printLastResult: window.__MYOBS_PRINT ? window.__MYOBS_PRINT.lastResult : null,
        printEvents: ((window.__MYOBS_PRINT || {}).events || []).length,
        printRoot: !!document.getElementById('myobs-print-root'),
        printStyle: !!document.getElementById('myobs-print-style'),
      })`),
    );
    hostAfter.hostViews = JSON.parse(hostAfter.hostViewState);
    delete hostAfter.hostViewState;
    report.facts.hostAfter = hostAfter;

    const hostViewsEqual =
      JSON.stringify(hostAfter.hostViews) === JSON.stringify(hostBefore.hostViews);
    const hostNoteStillInApp = hostAfter.hostViews.some(
      (view) => view.path === hostNote && view.inApp === true && view.connected === true,
    );
    report.criteria.hostUntouched =
      // The global active file stays the popout's note (that is correct: the
      // popout leaf is focused). What must not change is the host document's
      // own view set and the host print module's state.
      hostAfter.activeFile === hostBefore.activeFile &&
      hostAfter.bodyClass === hostBefore.bodyClass &&
      hostAfter.hostViews.length === hostBefore.hostViews.length &&
      hostViewsEqual === true &&
      hostNoteStillInApp === true &&
      hostAfter.printRoot === false &&
      hostAfter.printStyle === false &&
      hostAfter.printEvents === hostBefore.printEvents &&
      hostAfter.printLastResult === null &&
      hostBefore.printLastResult === null;

    /*
     * Regression guard for the routing above: with a popout open but the host
     * focused, the host's own export must still run in the host realm. Focus
     * the host with a real click, then run the same command there.
     */
    await activateTarget(cdp, mainTargetId);
    const hostEditorRect = await evaluate(`(function () {
      const el = document.querySelector('.workspace-leaf .cm-content') || document.querySelector('.cm-content');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 20) return null;
      return { x: r.left + Math.min(80, r.width / 2), y: r.top + Math.min(60, r.height / 2) };
    })()`);
    if (hostEditorRect) {
      await clickAt(cdp, mainSession, hostEditorRect, { button: 'left' });
      await sleep(250);
    }
    /*
     * Switching CDP targets does not deliver a real window focus event in
     * headless Chrome, so Obsidian never flips activeWindow/activeDocument
     * back (app.js @ ~2886206: window "focus" -> activeWindow = window). A
     * real user clicking back into the host page produces exactly this event,
     * so replay it to model that click.
     */
    await evaluate("window.dispatchEvent(new Event('focus')); 'ok'");
    await sleep(250);
    report.facts.hostFocus = JSON.parse(
      await evaluate(`JSON.stringify({
        hasFocus: document.hasFocus(),
        activeDocIsHost: window.activeDocument === document,
        activeWindowIsHost: window.activeWindow === window,
      })`),
    );
    report.facts.popoutFocus = JSON.parse(
      await popoutEvaluate(`JSON.stringify({
        hasFocus: document.hasFocus(),
        activeDocIsPopout: window.activeDocument === document,
      })`),
    );
    const hostExportTrigger = await evaluate(`(async function () {
      window.showSaveFilePicker = undefined;
      const probe = { printCalls: 0, snapshots: [] };
      window.__myobsParityHostPrint = probe;
      const originalPrint = window.print;
      window.print = function () {
        probe.printCalls += 1;
        const target = document.querySelector('.myobs-print-target');
        const view = target && target.querySelector('.markdown-preview-view, .markdown-source-view');
        probe.snapshots.push({
          targetPath: target ? target.getAttribute('data-path') : null,
          ownerIsHostDoc: target ? target.ownerDocument === document : null,
          text: view ? String(view.innerText || '').replace(/\\s+/g, ' ').slice(0, 120) : null,
        });
        return originalPrint.apply(window, arguments);
      };
      const beforeAt = ((window.__MYOBS_PRINT || {}).lastResult || {}).at || 0;
      const opened = app.commands.executeCommandById('workspace:export-pdf');
      await new Promise(function (resolve) { window.setTimeout(resolve, 300); });
      const containers = Array.from(document.querySelectorAll('.modal-container'));
      const modal = containers.find(function (el) { return /Export to PDF/i.test(el.innerText || ''); }) || null;
      if (!modal) return { ok: false, why: 'modal did not open in the host document', opened };
      const cta = Array.from(modal.querySelectorAll('button')).find(function (button) {
        return button.classList.contains('mod-cta');
      });
      if (!cta) return { ok: false, why: 'no primary button' };
      cta.click();
      return { ok: true, beforeAt };
    })()`);
    report.facts.hostExportTrigger = hostExportTrigger;
    const hostPrinted =
      hostExportTrigger?.ok === true &&
      (await waitForPage(
        cdp,
        mainSession,
        `(function () {
          const r = window.__MYOBS_PRINT && window.__MYOBS_PRINT.lastResult;
          return !!(r && r.printed === true && r.at > ${Number(hostExportTrigger.beforeAt)});
        })()`,
        30000,
      ));
    await sleep(500);
    const hostExportState = JSON.parse(
      await evaluate(`JSON.stringify({
        lastResult: (window.__MYOBS_PRINT || {}).lastResult || null,
        snapshots: (window.__myobsParityHostPrint || {}).snapshots || [],
      })`),
    );
    report.facts.hostExport = hostExportState;
    report.facts.popoutAfterHostExport = JSON.parse(
      await popoutEvaluate(`JSON.stringify({
        lastResultAt: ((window.__MYOBS_PRINT || {}).lastResult || {}).at || null,
      })`),
    );
    report.criteria.hostExportUnaffected =
      hostPrinted === true &&
      hostExportState.lastResult?.path === hostNote &&
      hostExportState.snapshots.length > 0 &&
      hostExportState.snapshots[0].ownerIsHostDoc === true &&
      report.facts.popoutAfterHostExport.lastResultAt === popoutAfter.lastResult?.at;

    // Right-click inside the popout ---------------------------------------
    // The export's host-realm modal work can leave the popout unfocused; a
    // user right-clicking always has the window focused first, so put the
    // focus back with a real click before the right-click.
    await activateTarget(cdp, popout.targetId);
    await popoutEvaluate(`(function () {
      var scroller = document.querySelector('.workspace-leaf.mod-active .cm-scroller') ||
        document.querySelector('.cm-scroller');
      if (scroller) scroller.scrollTop = 0;
      return true;
    })()`).catch(() => {});
    await sleep(250);
    const editorRect = await popoutEvaluate(`(function () {
      function usable(el) {
        if (!el) return null;
        if (el.closest && el.closest('.internal-embed, .pdf-embed, .pdf-container')) return null;
        var r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 5) return null;
        var x = r.left + Math.min(30, r.width / 2);
        var offsets = [Math.min(8, r.height / 2), Math.min(r.height / 2, r.height - 2)];
        for (var k = 0; k < offsets.length; k++) {
          var y = r.top + offsets[k];
          var hit = document.elementFromPoint(x, y);
          if (!hit) continue;
          if (hit.closest && (hit.closest('.cm-content') || hit.closest('.markdown-preview-view'))) {
            return { x: x, y: y };
          }
        }
        return null;
      }
      var leaf = document.querySelector('.workspace-leaf.mod-active') || document;
      var lines = leaf.querySelectorAll('.cm-content .cm-line');
      for (var i = 0; i < lines.length; i++) {
        var hit = usable(lines[i]);
        if (hit) return hit;
      }
      var paras = leaf.querySelectorAll('.markdown-preview-view p, .markdown-preview-view li');
      for (var j = 0; j < paras.length; j++) {
        var para = usable(paras[j]);
        if (para) return para;
      }
      return usable(leaf.querySelector('.cm-content')) || usable(leaf.querySelector('.markdown-preview-view'));
    })()`);
    report.facts.popoutEditorRect = editorRect;
    let menuFact = null;
    if (editorRect) {
      // Focus the editor without a mouse click: the popout note has embedded
      // PDFs, and a left-click on a point that later lands on an embed opens
      // the PDF viewer instead of keeping the markdown editor active.
      await popoutEvaluate(`(function () {
        var leaf = app.workspace.activeLeaf;
        if (leaf && leaf.view && leaf.view.editor && typeof leaf.view.editor.focus === 'function') {
          leaf.view.editor.focus();
          return true;
        }
        var el = document.querySelector('.workspace-leaf.mod-active .cm-content');
        if (el && typeof el.focus === 'function') { el.focus(); return true; }
        return false;
      })()`).catch(() => {});
      await sleep(250);
      await clickAt(cdp, popoutSessionId, editorRect, { button: 'right' });
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        menuFact = await popoutEvaluate(`(function () {
          const panels = Array.from(document.querySelectorAll('.myobs-menu-panel')).filter(function (el) {
            return el.getClientRects().length > 0;
          });
          const htmlMenus = Array.from(document.querySelectorAll('.menu, .menu-container')).filter(function (el) {
            return el.getClientRects().length > 0;
          });
          if (!panels.length && !htmlMenus.length) return null;
          const rows = panels.length
            ? panels[0].querySelectorAll('.myobs-menu-row')
            : htmlMenus[0].querySelectorAll('.menu-item');
          return {
            source: panels.length ? 'myobs-menu-panel' : 'obsidian-html-menu',
            panels: panels.length,
            htmlMenus: htmlMenus.length,
            rows: rows.length,
            labels: Array.from(rows).slice(0, 6).map(function (row) { return (row.textContent || '').trim().slice(0, 40); }),
          };
        })()`).catch(() => null);
        if (menuFact) break;
        await sleep(200);
      }
      if (!menuFact) {
        report.facts.popoutMenuDebug = await popoutEvaluate(`JSON.stringify((function () {
          var rect = ${JSON.stringify(editorRect)};
          var hit = document.elementFromPoint(rect.x, rect.y);
          var stack = document.elementsFromPoint ? document.elementsFromPoint(rect.x, rect.y) : [];
          var candidates = [];
          document.querySelectorAll('.workspace-leaf.mod-active .cm-line, .workspace-leaf.mod-active .markdown-preview-view p, .workspace-leaf.mod-active .markdown-preview-view li').forEach(function (el) {
            if (candidates.length >= 8) return;
            var r = el.getBoundingClientRect();
            candidates.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), text: String(el.textContent).slice(0, 40), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), embed: !!(el.closest && el.closest('.internal-embed, .pdf-embed, .pdf-container')) });
          });
          var menu = window.__MYOBS_MENU || {};
          return {
            hasFocus: document.hasFocus(),
            activeTag: document.activeElement ? document.activeElement.tagName : null,
            activeClass: document.activeElement ? String(document.activeElement.className).slice(0, 80) : null,
            hitTag: hit ? hit.tagName : null,
            hitClass: hit ? String(hit.className).slice(0, 120) : null,
            hitText: hit ? String(hit.textContent).slice(0, 80) : null,
            stack: stack.slice(0, 6).map(function (el) { return el.tagName + '.' + String(el.className).slice(0, 50); }),
            candidates: candidates,
            viewType: app.workspace.activeLeaf && app.workspace.activeLeaf.view && app.workspace.activeLeaf.view.getViewType ? app.workspace.activeLeaf.view.getViewType() : null,
            panels: document.querySelectorAll('.myobs-menu-panel').length,
            htmlMenus: document.querySelectorAll('.menu, .menu-container').length,
            menuInstalled: menu.installed === true,
            menuEvents: (menu.events || []).slice(-12),
            lastPopup: menu.lastPopup || null,
            fatal: (function () {
              var el = document.getElementById('myobs-fatal');
              return !!(el && !el.hidden && el.style.display !== 'none');
            })()
          };
        })())`).catch((err) => `debug failed: ${err.message}`);
        // Diagnostics only: if the menu went to the host document, say so.
        report.facts.hostContextMenu = await evaluate(`(function () {
          const panels = Array.from(document.querySelectorAll('.myobs-menu-panel')).filter(function (el) {
            return el.getClientRects().length > 0;
          });
          const htmlMenus = Array.from(document.querySelectorAll('.menu, .menu-container')).filter(function (el) {
            return el.getClientRects().length > 0;
          });
          return { panels: panels.length, htmlMenus: htmlMenus.length };
        })()`).catch(() => null);
      }
      const escape = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...escape }, popoutSessionId);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...escape }, popoutSessionId);
      await sleep(200);
    }
    report.facts.popoutContextMenu = menuFact;
    report.criteria.popoutContextMenu = Boolean(menuFact && menuFact.rows > 0);

    // Host-side record of what was injected -------------------------------
    report.facts.popoutFrames = await evaluate(lastPopoutFrameProbe())
      .then((raw) => JSON.parse(raw))
      .catch(() => null);
    report.diagnostics = {
      pagesAfter: (await listPageTargets(cdp)).map((p) => ({
        targetId: p.targetId,
        url: p.url,
        title: p.title,
      })),
      popoutEvents: await popoutEvaluate(
        'JSON.stringify(((window.__MYOBS_PRINT || {}).events || []).slice(-8))',
      ).catch(() => null),
      hostPrintEvents: await evaluate(
        'JSON.stringify(((window.__MYOBS_PRINT || {}).events || []).slice(-8))',
      ).catch(() => null),
    };
  } catch (err) {
    report.fatal = String(err && err.stack ? err.stack : err);
  } finally {
    cdp.close();
    chrome.child.kill();
    server.child.kill();
  }

  const passed = !report.fatal && Object.values(report.criteria).every(Boolean);
  report.passed = passed;

  if (args.log) {
    fs.writeFileSync(args.log, server.logs.join(''));
    console.log(`[trace] server log written to ${args.log}`);
  }

  console.log(JSON.stringify(report, null, 2));
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(report, null, 2));

  for (const [label, bucket] of [
    ['main', report.console],
    ['popout', report.popoutConsole],
  ]) {
    if (bucket.exceptions.length) {
      console.log(`\n--- ${label} exceptions ---`);
      for (const line of bucket.exceptions.slice(0, 10)) console.log(line);
    }
  }

  process.exitCode = passed ? 0 : 1;
}

/**
 * The host's own record of the popout it opened: which scripts the popout
 * realm received and which note it owns.
 */
function lastPopoutFrameProbe() {
  return `JSON.stringify(((window.__MYOBS_POPOUT || {}).frames || []).map(function (frame) {
    return {
      at: frame.at,
      file: frame.file,
      instrumented: frame.instrumented,
      shims: frame.shims,
      runtime: frame.runtime,
      error: frame.error,
    };
  }))`;
}

main().catch((err) => {
  console.error('parity-check failed:', err.message);
  process.exitCode = 2;
});
