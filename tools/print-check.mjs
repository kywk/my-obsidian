#!/usr/bin/env node
/**
 * Desktop-experience acceptance harness: print / PWA / mobile width.
 *
 * Zero dependencies; drives the local Chrome over CDP through tools/lib/cdp.mjs
 * (frozen, read-only). See DESIGN.md §3 items 5 and 13.
 *
 * Usage:
 *   node tools/print-check.mjs --vault <copy-of-vault> [--port 3705]
 *                              [--timeout 90] [--json <out.json>]
 *
 * Never point --vault at the live vault (AGENTS.md hard rule 4).
 */

import fs from 'node:fs';

import {
  Cdp,
  assertNotLiveVault,
  launchChrome,
  readTermsFromVendor,
  sleep,
  startServer,
} from './lib/cdp.mjs';

function parseArgs(argv) {
  const out = { vault: null, port: 3705, timeout: 90, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--vault') out.vault = argv[++i];
    else if (arg === '--port') out.port = Number(argv[++i]);
    else if (arg === '--timeout') out.timeout = Number(argv[++i]);
    else if (arg === '--json') out.json = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.vault) throw new Error('--vault is required (never the live vault)');
if (!fs.existsSync(args.vault)) throw new Error(`vault does not exist: ${args.vault}`);
assertNotLiveVault(args.vault);

const URL_BASE = `http://127.0.0.1:${args.port}`;
const report = {
  url: URL_BASE,
  vault: args.vault,
  criteria: {},
  facts: {},
  console: { warnings: [], errors: [], exceptions: [] },
};

const criteria = report.criteria;
const facts = report.facts;

function check(name, ok, detail) {
  criteria[name] = Boolean(ok);
  if (detail !== undefined) facts[name] = detail;
}

const terms = readTermsFromVendor();
const server = await startServer(args.vault, args.port, terms);
const chrome = await launchChrome(args.port + 1000);
const cdp = new Cdp(chrome.wsUrl);

let sessionId;

/** @param {string} expression */
async function evaluate(expression) {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    const ex = result.exceptionDetails;
    throw new Error(ex.exception?.description || ex.exception?.value || ex.text || 'evaluate failed');
  }
  return result.result?.value;
}

/**
 * Poll until `expression` is truthy, returning the last value.
 *
 * @param {string} expression
 * @param {number} timeoutMs
 */
async function waitForValue(expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(expression).catch(() => undefined);
    if (last) return last;
    await sleep(150);
  }
  return last;
}

try {
  await cdp.connect();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));

  cdp.on((message) => {
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = (message.params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? arg.type)
        .join(' ');
      if (message.params.type === 'error') report.console.errors.push(text);
      else if (message.params.type === 'warning') report.console.warnings.push(text);
    } else if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      const ex = details.exception ?? {};
      report.console.exceptions.push(ex.description || details.text || 'unknown exception');
    }
  });

  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId).catch(() => {});

  // Deterministic desktop viewport: the boot-time branch must be the desktop
  // one, otherwise the >= 768 regression check tests the wrong starting state.
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );

  await cdp.send('Page.navigate', { url: `${URL_BASE}/` }, sessionId);
  const booted = await waitForValue(
    'typeof window.app !== "undefined" && !!window.app && !!(app.workspace && app.workspace.layoutReady)',
    args.timeout * 1000,
  );
  if (!booted) {
    const fatal = await evaluate(
      '(document.getElementById("myobs-fatal-detail")||{}).textContent||""',
    ).catch(() => '');
    throw new Error(`window.app never became ready.\n${fatal}`);
  }

  // ---------------------------------------------------------------- 1. boot
  const printApi = await evaluate(`JSON.stringify({
    installed: !!window.__MYOBS_PRINT && window.__MYOBS_PRINT.installed === true,
    printActiveNote: typeof (window.__MYOBS_PRINT && window.__MYOBS_PRINT.printActiveNote),
    platformCaptured: !!(window.__MYOBS_PLATFORM_BRIDGE && window.__MYOBS_PLATFORM_BRIDGE.captured),
    platformGlobal: typeof window.Platform,
    width: window.innerWidth,
    isPhone: window.Platform && window.Platform.isPhone,
  })`);
  const boot = JSON.parse(printApi);
  check('boot', boot.installed && boot.printActiveNote === 'function', boot);
  check(
    'printApi',
    boot.installed && boot.printActiveNote === 'function',
    boot.printActiveNote,
  );

  // -------------------------------------------------------- 2. open a note
  const opened = await evaluate(`(async () => {
    const files = app.vault.getMarkdownFiles()
      .filter((f) => f.stat && f.stat.size > 0 && f.stat.size < 8000)
      .sort((a, b) => a.stat.size - b.stat.size);
    const file = files[0] || app.vault.getMarkdownFiles()[0];
    if (!file) return { ok: false, why: 'no markdown file' };
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(file);
    await new Promise((resolve) => setTimeout(resolve, 800));
    return { ok: true, path: file.path, size: file.stat ? file.stat.size : null };
  })()`);
  if (!opened?.ok) throw new Error(`could not open a note: ${opened?.why || 'unknown'}`);
  await waitForValue(
    '!!document.querySelector(".workspace-leaf.mod-active .markdown-preview-view, .workspace-leaf.mod-active .markdown-source-view")',
    15000,
  );
  facts.openedNote = opened;

  // Install a print stub that snapshots computed styles synchronously. This is
  // the only place where the print view is observable: printActiveNote restores
  // the body class immediately after window.print() returns.
  await evaluate(`(() => {
    window.__myobsPrintProbe = { calls: 0, snapshots: [] };
    window.__myobsOriginalPrint = window.print;
    const shell = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const style = getComputedStyle(el);
      return { display: style.display, visibility: style.visibility };
    };
    window.print = function () {
      window.__myobsPrintProbe.calls += 1;
      const leaf = document.querySelector('.myobs-print-target');
      const view = leaf && leaf.querySelector('.markdown-preview-view, .markdown-source-view');
      const style = view ? getComputedStyle(view) : null;
      window.__myobsPrintProbe.snapshots.push({
        bodyClass: document.body.className,
        printing: document.body.classList.contains('myobs-printing'),
        leafFound: !!leaf,
        viewKind: view ? (view.classList.contains('markdown-preview-view') ? 'preview' : 'source') : null,
        view: style ? { display: style.display, visibility: style.visibility } : null,
        viewTextLen: view ? (view.innerText || '').trim().length : 0,
        ribbon: shell('.workspace-ribbon'),
        status: shell('.status-bar'),
        side: shell('.workspace-split.mod-sidedock'),
        styleTag: !!document.getElementById('myobs-print-style'),
      });
    };
    return true;
  })()`);

  const printRun = await evaluate(`(() => {
    const before = document.body.className;
    const activePath = (app.workspace.getActiveFile() || {}).path || null;
    const beforeView = document.querySelector('.workspace-leaf.mod-active .markdown-preview-view, .workspace-leaf.mod-active .markdown-source-view');
    const beforeParent = beforeView && beforeView.parentElement ? beforeView.parentElement.className : null;
    const beforeRect = beforeView ? beforeView.getBoundingClientRect() : null;
    const result = window.__MYOBS_PRINT.printActiveNote({
      filepath: '/tmp/myobs-print-check-not-written.pdf',
    });
    const afterView = document.querySelector('.workspace-leaf.mod-active .markdown-preview-view, .workspace-leaf.mod-active .markdown-source-view');
    const afterRect = afterView ? afterView.getBoundingClientRect() : null;
    return {
      before,
      after: document.body.className,
      activePath,
      beforeParent,
      beforeRect: beforeRect ? { width: beforeRect.width, height: beforeRect.height } : null,
      afterRect: afterRect ? { width: afterRect.width, height: afterRect.height } : null,
      afterViewPresent: !!afterView,
      afterParent: afterView && afterView.parentElement ? afterView.parentElement.className : null,
      rootLeft: !!document.getElementById('myobs-print-root'),
      result,
      lastResult: window.__MYOBS_PRINT.lastResult,
      styleLeft: !!document.getElementById('myobs-print-style'),
      probe: window.__myobsPrintProbe,
    };
  })()`);

  const snapshot = printRun.probe.snapshots[printRun.probe.snapshots.length - 1] || {};
  facts.printSnapshot = snapshot;
  facts.printResult = printRun.result;
  check(
    'printActiveNote',
    printRun.result?.ok === true &&
      printRun.result?.reason === 'browser-print-dialog' &&
      printRun.result?.fileWritten === false,
    printRun.result,
  );
  check('printStylesApplied', snapshot.printing === true && snapshot.leafFound === true && snapshot.styleTag === true, {
    printing: snapshot.printing,
    leafFound: snapshot.leafFound,
    styleTag: snapshot.styleTag,
    viewKind: snapshot.viewKind,
  });
  check(
    'printOnlyNote',
    snapshot.view?.visibility === 'visible' &&
      snapshot.view?.display !== 'none' &&
      snapshot.viewTextLen > 0 &&
      (!snapshot.ribbon || snapshot.ribbon.display === 'none') &&
      (!snapshot.status || snapshot.status.display === 'none') &&
      (!snapshot.side || snapshot.side.display === 'none'),
    {
      view: snapshot.view,
      viewTextLen: snapshot.viewTextLen,
      ribbon: snapshot.ribbon,
      status: snapshot.status,
      side: snapshot.side,
    },
  );
  const rectStable =
    printRun.beforeRect &&
    printRun.afterRect &&
    Math.abs(printRun.beforeRect.width - printRun.afterRect.width) <= 1 &&
    Math.abs(printRun.beforeRect.height - printRun.afterRect.height) <= 1;
  check(
    'printStateRestored',
    printRun.before === printRun.after &&
      printRun.styleLeft === false &&
      printRun.rootLeft === false &&
      printRun.afterViewPresent === true &&
      printRun.result?.path === printRun.activePath &&
      rectStable,
    {
      before: printRun.before,
      after: printRun.after,
      styleLeft: printRun.styleLeft,
      rootLeft: printRun.rootLeft,
      activePath: printRun.activePath,
      printedPath: printRun.result?.path,
      beforeParent: printRun.beforeParent,
      afterParent: printRun.afterParent,
      afterViewPresent: printRun.afterViewPresent,
      beforeRect: printRun.beforeRect,
      afterRect: printRun.afterRect,
    },
  );
  facts.printCalls = printRun.probe.calls;

  // ------------------------------------------------ 3. real PDF bytes (CDP)
  const beforePdf = await evaluate('document.body.className');
  const begun = await evaluate('window.__MYOBS_PRINT.beginPrintView({ hold: true })');
  await cdp.send('Emulation.setEmulatedMedia', { media: 'print' }, sessionId);
  const pdf = await cdp
    .send(
      'Page.printToPDF',
      { printBackground: true, preferCSSPageSize: false, displayHeaderFooter: false },
      sessionId,
    )
    .finally(() => cdp.send('Emulation.setEmulatedMedia', { media: '' }, sessionId));
  const pdfBytes = Buffer.from(pdf.data, 'base64');
  const pdfText = pdfBytes.toString('latin1');
  const pageCount = (pdfText.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const ended = await evaluate('window.__MYOBS_PRINT.endPrintView("pdf-check")');
  const afterPdf = await evaluate('document.body.className');
  facts.pdf = {
    begun,
    ended,
    bytes: pdfBytes.length,
    pageCount,
    header: pdfBytes.subarray(0, 5).toString('latin1'),
  };
  check(
    'pdfBytes',
    pdfBytes.length > 1000 && pdfBytes.subarray(0, 5).toString('latin1').startsWith('%PDF'),
    { bytes: pdfBytes.length, pageCount },
  );
  check('pdfRestored', beforePdf === afterPdf, { before: beforePdf, after: afterPdf });

  // --------------------------------------------- 4. IPC ownership of the flow
  const ipcRun = await evaluate(`(async () => {
    const ipc = window.require('electron').ipcRenderer;
    const callsBefore = window.__myobsPrintProbe.calls;
    const result = await new Promise((resolve) => {
      ipc.once('print-to-pdf', (event, payload) => resolve(payload));
      ipc.send('print-to-pdf', { filepath: '/tmp/ipc-not-written.pdf' });
    });
    return { result, calls: window.__myobsPrintProbe.calls - callsBefore };
  })()`);
  facts.ipc = ipcRun;
  check(
    'ipcResult',
    ipcRun.result?.ok === false &&
      ipcRun.result?.reason === 'browser-print-dialog' &&
      ipcRun.result?.fileWritten === false,
    ipcRun.result,
  );
  check('ipcPrinted', ipcRun.calls === 1, { calls: ipcRun.calls });

  // --------------------------------------------------- 5. HTTP manifest / SW
  const manifestResponse = await fetch(`${URL_BASE}/manifest.webmanifest`);
  const manifest = await manifestResponse.json();
  const manifestJsonResponse = await fetch(`${URL_BASE}/manifest.json`);
  const swResponse = await fetch(`${URL_BASE}/sw.js`);
  const swText = await swResponse.text();
  const pageResponse = await fetch(`${URL_BASE}/`);
  const pageHtml = await pageResponse.text();
  const precacheMatch = /const PRECACHE = (\[[^\]]*\]);/.exec(swText);
  const precache = precacheMatch ? JSON.parse(precacheMatch[1]) : [];
  const manifestAt = pageHtml.indexOf('<link rel="manifest"');
  const themeAt = pageHtml.indexOf('<meta name="theme-color"');
  const headEnd = pageHtml.indexOf('</head>');
  facts.pwaHead = { manifestAt, themeAt, headEnd };
  check(
    'pagePwaHead',
    pageResponse.status === 200 &&
      manifestAt > 0 &&
      themeAt > 0 &&
      manifestAt < headEnd &&
      themeAt < headEnd,
    facts.pwaHead,
  );
  facts.manifest = manifest;
  facts.serviceWorker = {
    status: swResponse.status,
    contentType: swResponse.headers.get('content-type'),
    cacheControl: swResponse.headers.get('cache-control'),
    allowed: swResponse.headers.get('service-worker-allowed'),
    precache,
  };
  check(
    'manifest',
    manifestResponse.status === 200 &&
      manifest.start_url === '/' &&
      manifest.display === 'standalone' &&
      manifest.theme_color === '#1e1e1e' &&
      typeof manifest.background_color === 'string' &&
      Array.isArray(manifest.icons) &&
      manifest.icons.length > 0 &&
      manifestResponse.headers.get('cache-control') === 'no-cache',
    {
      status: manifestResponse.status,
      contentType: manifestResponse.headers.get('content-type'),
      start_url: manifest.start_url,
      display: manifest.display,
      theme_color: manifest.theme_color,
      icons: manifest.icons,
    },
  );
  check('manifestJson', manifestJsonResponse.status === 200, {
    status: manifestJsonResponse.status,
    contentType: manifestJsonResponse.headers.get('content-type'),
  });
  check(
    'serviceWorkerRoute',
    swResponse.status === 200 &&
      String(swResponse.headers.get('content-type')).startsWith('text/javascript') &&
      swResponse.headers.get('cache-control') === 'no-cache' &&
      precache.includes('/obsidian/app.css') &&
      precache.every((url) => !url.startsWith('/v/') && !url.startsWith('/api/')),
    {
      status: swResponse.status,
      contentType: swResponse.headers.get('content-type'),
      cacheControl: swResponse.headers.get('cache-control'),
      precache,
    },
  );

  // ---------------------------------------------------- 6. SW registration
  const swCount = await waitForValue(
    'navigator.serviceWorker.getRegistrations().then((list) => list.length)',
    20000,
  );
  const swInfo = await evaluate(
    'navigator.serviceWorker.getRegistrations().then((list) => list.map((r) => r.scope))',
  );
  facts.serviceWorkerRegistrations = { count: swCount, scopes: swInfo };
  check('serviceWorkerRegistered', Number(swCount) > 0, { count: swCount, scopes: swInfo });

  // ------------------------------------------------ 7. width regression
  const wideBefore = JSON.parse(
    await evaluate(`JSON.stringify({
      width: innerWidth,
      isPhone: Platform.isPhone,
      isTablet: Platform.isTablet,
      canDisplayRibbon: Platform.canDisplayRibbon,
      canSplit: Platform.canSplit,
      canStackTabs: Platform.canStackTabs,
      applied: window.__MYOBS_PLATFORM_BRIDGE.applied,
      overrides: window.__MYOBS_PLATFORM_BRIDGE.overrides,
      bodyPhone: document.body.classList.contains('is-phone'),
    })`),
  );

  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 600, height: 900, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await waitForValue('window.Platform && window.Platform.isPhone === true', 10000);
  const narrow = JSON.parse(
    await evaluate(`JSON.stringify({
      width: innerWidth,
      isPhone: Platform.isPhone,
      isTablet: Platform.isTablet,
      canDisplayRibbon: Platform.canDisplayRibbon,
      canSplit: Platform.canSplit,
      canStackTabs: Platform.canStackTabs,
      canPinSidebar: Platform.canPinSidebar,
      applied: window.__MYOBS_PLATFORM_BRIDGE.applied,
      overrides: window.__MYOBS_PLATFORM_BRIDGE.overrides,
      bodyPhone: document.body.classList.contains('is-phone'),
      events: window.__MYOBS_PLATFORM_BRIDGE.events.slice(-4),
    })`),
  );

  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await waitForValue('window.Platform && window.Platform.isPhone === false', 10000);
  const wideAfter = JSON.parse(
    await evaluate(`JSON.stringify({
      width: innerWidth,
      isPhone: Platform.isPhone,
      isTablet: Platform.isTablet,
      canDisplayRibbon: Platform.canDisplayRibbon,
      canSplit: Platform.canSplit,
      canStackTabs: Platform.canStackTabs,
      applied: window.__MYOBS_PLATFORM_BRIDGE.applied,
      overrides: window.__MYOBS_PLATFORM_BRIDGE.overrides,
      bodyPhone: document.body.classList.contains('is-phone'),
    })`),
  );

  facts.platform = { wideBefore, narrow, wideAfter };
  check(
    'widthDesktopDefault',
    wideBefore.width === 1280 &&
      wideBefore.isPhone === false &&
      wideBefore.applied === false &&
      wideBefore.overrides === null,
    wideBefore,
  );
  check(
    'widthPhone',
    narrow.width === 600 &&
      narrow.isPhone === true &&
      narrow.isTablet === false &&
      narrow.applied === true &&
      narrow.overrides?.isPhone === true &&
      narrow.overrides?.isTablet === false &&
      narrow.bodyPhone === true &&
      narrow.canDisplayRibbon === false &&
      narrow.canSplit === false &&
      narrow.canStackTabs === false,
    narrow,
  );
  check(
    'widthRestored',
    wideAfter.width === 1280 &&
      wideAfter.isPhone === false &&
      wideAfter.isTablet === wideBefore.isTablet &&
      wideAfter.canDisplayRibbon === wideBefore.canDisplayRibbon &&
      wideAfter.canSplit === wideBefore.canSplit &&
      wideAfter.canStackTabs === wideBefore.canStackTabs &&
      wideAfter.applied === false &&
      wideAfter.overrides === null &&
      wideAfter.bodyPhone === wideBefore.bodyPhone,
    wideAfter,
  );

  // --------------------------------------- 8. no note must not print blank
  const noNoteRun = await evaluate(`(async () => {
    app.workspace.detachLeavesOfType('markdown');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const callsBefore = window.__myobsPrintProbe.calls;
    const result = window.__MYOBS_PRINT.printActiveNote();
    return {
      callsBefore,
      callsAfter: window.__myobsPrintProbe.calls,
      result,
      activePath: (app.workspace.getActiveFile() || {}).path || null,
      noteViewLeft: !!document.querySelector('.workspace-leaf.mod-active .markdown-preview-view, .workspace-leaf.mod-active .markdown-source-view'),
    };
  })()`);
  facts.printNoNote = noNoteRun;
  check(
    'printNoNote',
    noNoteRun.result?.ok === false &&
      noNoteRun.result?.reason === 'no-active-note' &&
      noNoteRun.result?.error?.code === 'NO_ACTIVE_NOTE' &&
      noNoteRun.callsAfter === noNoteRun.callsBefore,
    noNoteRun,
  );
} catch (err) {
  report.fatal = String(err && err.stack ? err.stack : err);
} finally {
  cdp.close();
  chrome.child.kill();
  server.child.kill();
}

const passed = !report.fatal && Object.values(report.criteria).every(Boolean);
report.passed = passed;

console.log(JSON.stringify(report, null, 2));
if (args.json) fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
if (report.console.exceptions.length) {
  console.log('\n--- exceptions ---');
  for (const line of report.console.exceptions.slice(0, 10)) console.log(line);
}
if (report.console.errors.length) {
  console.log('\n--- console errors ---');
  for (const line of report.console.errors.slice(0, 10)) console.log(line);
}

process.exitCode = passed ? 0 : 1;
