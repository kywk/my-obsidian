#!/usr/bin/env node
/**
 * remote.dialog + Export-to-PDF acceptance harness.
 *
 * Zero dependencies; drives the local Chrome over CDP through
 * tools/lib/cdp.mjs (frozen, read-only).
 *
 * Usage:
 *   node tools/dialog-check.mjs --vault <copy-of-vault> [--port 3901]
 *                               [--timeout 90] [--json <out.json>]
 *
 * Never point --vault at the live vault (AGENTS.md hard rule 4).
 *
 * What it proves:
 *   1. window.__MYOBS_DIALOG is installed;
 *   2. showMessageBox maps confirm() to the button indices callers expect;
 *   3. showSaveDialog always settles with { canceled, filePath, filePaths },
 *      with and without File System Access, including picker cancel/failure;
 *   4. showOpenDialog returns canceled and explains itself exactly once;
 *   5. the real "Export to PDF" command completes: dialog -> print-to-pdf ->
 *      browser print flow, with a non-blank PDF produced from the same note;
 *   6. a second export still works (no leaked view / body class / style);
 *   7. no unhandled exception is raised along the way.
 */

import fs from 'node:fs';

import {
  Cdp,
  launchChrome,
  listPageTargets,
  readTermsFromVendor,
  sleep,
  startServer,
} from './lib/cdp.mjs';

function parseArgs(argv) {
  const out = { vault: null, port: 3901, timeout: 90, json: null };
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

const URL_BASE = `http://127.0.0.1:${args.port}`;
const CHROME_PORT = args.port + 1000;
const PDF_MIN_BYTES = 10 * 1024;

const report = {
  url: URL_BASE,
  vault: args.vault,
  chromePort: CHROME_PORT,
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
const chrome = await launchChrome(CHROME_PORT);
const cdp = new Cdp(chrome.wsUrl);

let sessionId;

/**
 * @param {string} expression
 * @param {{ userGesture?: boolean }} [options]
 */
async function evaluate(expression, options = {}) {
  const result = await cdp.send(
    'Runtime.evaluate',
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: options.userGesture === true,
    },
    sessionId,
  );
  if (result.exceptionDetails) {
    const ex = result.exceptionDetails;
    throw new Error(ex.exception?.description || ex.exception?.value || ex.text || 'evaluate failed');
  }
  return result.result?.value;
}

/**
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

/**
 * Open the export settings modal and press its "Export to PDF" button.
 * Returns the modal's visible text so the report can show what was clicked.
 */
const DISMISS_TRUST = `(() => {
  const containers = Array.from(document.querySelectorAll('.modal-container'));
  const target =
    containers.find((el) => el.classList.contains('mod-trust-folder')) ||
    containers.find((el) => /trust the author/i.test(el.innerText || ''));
  if (!target) return { found: false };
  const buttons = Array.from(target.querySelectorAll('button'));
  const cancel = buttons.find((button) => button.classList.contains('mod-cancel')) || buttons[0];
  const labels = buttons.map((button) => button.textContent);
  if (cancel) cancel.click();
  return { found: true, labels, clicked: cancel ? cancel.textContent : null };
})()`;

const RUN_EXPORT = `(async () => {
  // The vault copy has community plugins, so Obsidian opens its trust
  // prompt asynchronously during boot. It is unrelated to this test and
  // must not be mistaken for a leaked export modal.
  const trust = ${DISMISS_TRUST};
  if (trust.found) await new Promise((resolve) => setTimeout(resolve, 250));
  const opened = app.commands.executeCommandById('workspace:export-pdf');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const containers = Array.from(document.querySelectorAll('.modal-container'));
  const modal =
    containers.find((el) => /Export to PDF/i.test(el.innerText || '')) ||
    containers[containers.length - 1] ||
    null;
  if (!modal) return { ok: false, why: 'modal did not open', opened };
  const buttons = Array.from(modal.querySelectorAll('button'));
  const cta = buttons.find((button) => button.classList.contains('mod-cta')) || null;
  if (!cta) {
    return {
      ok: false,
      why: 'no primary button',
      opened,
      labels: buttons.map((button) => button.textContent),
      modalText: (modal.innerText || '').slice(0, 300),
    };
  }
  const beforeAt = (window.__MYOBS_PRINT.lastResult || {}).at || 0;
  cta.click();
  return {
    ok: true,
    opened,
    label: cta.textContent,
    beforeAt,
    modalText: (modal.innerText || '').slice(0, 300),
  };
})()`;

const READ_EXPORT_STATE = `(() => {
  const print = window.__MYOBS_PRINT || {};
  const result = print.lastResult || null;
  const probe = window.__myobsDialogPrint || { calls: 0, snapshots: [] };
  const snapshot = probe.snapshots[probe.snapshots.length - 1] || null;
  const activeView = document.querySelector(
    '.workspace-leaf.mod-active .markdown-preview-view, .workspace-leaf.mod-active .markdown-source-view',
  );
  return {
    result,
    bodyClass: document.body.className,
    printRoot: !!document.getElementById('myobs-print-root'),
    printStyle: !!document.getElementById('myobs-print-style'),
    activeView: !!activeView,
    activePath: (app.workspace.getActiveFile() || {}).path || null,
    modalOpen: Array.from(document.querySelectorAll('.modal-container')).some((el) => {
      const style = getComputedStyle(el);
      const visible =
        style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
      return visible && /export to pdf/i.test(el.innerText || '');
    }),
    modals: Array.from(document.querySelectorAll('.modal-container')).map((el) => {
      const style = getComputedStyle(el);
      return {
        cls: el.className,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        rects: el.getClientRects().length,
        text: (el.innerText || '').slice(0, 40),
      };
    }),
    pdfSurface: !!document.querySelector('iframe[data-myobs-pdf-surface]'),
    probeCalls: probe.calls,
    snapshot,
  };
})()`;

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

  // The trust prompt is Obsidian's own first-run gate for community plugins;
  // dismiss it once here so no later assertion confuses it with our modal.
  const trustAtBoot = await waitForValue(`(() => {
    const found = Array.from(document.querySelectorAll('.modal-container')).some(
      (el) => el.classList.contains('mod-trust-folder') || /trust the author/i.test(el.innerText || ''),
    );
    return found ? JSON.stringify(true) : '';
  })()`, 8000);
  const trustDismissed = trustAtBoot ? await evaluate(DISMISS_TRUST) : { found: false };
  facts.trustModal = { appeared: Boolean(trustAtBoot), dismissed: trustDismissed };
  await sleep(500);

  // ------------------------------------------------------- 1. installation
  const install = JSON.parse(
    await evaluate(`JSON.stringify({
      dialogInstalled: !!(window.__MYOBS_DIALOG && window.__MYOBS_DIALOG.installed === true),
      printInstalled: !!(window.__MYOBS_PRINT && window.__MYOBS_PRINT.installed === true),
      handleIpc: typeof (window.__MYOBS_PRINT && window.__MYOBS_PRINT.handleIpc),
      dialogApis: Object.keys((window.require('electron').remote.dialog) || {}).sort(),
      hasSavePicker: typeof window.showSaveFilePicker,
      surfaceHook: !!document.querySelector('iframe[data-myobs-pdf-surface]'),
      pages: 0,
    })`),
  );
  install.pages = (await listPageTargets(cdp)).filter((page) => page.url.startsWith(URL_BASE)).length;
  facts.install = install;
  check(
    'dialogInstalled',
    install.dialogInstalled &&
      install.printInstalled &&
      install.handleIpc === 'function' &&
      install.dialogApis.includes('showSaveDialog') &&
      install.dialogApis.includes('showMessageBox'),
    install,
  );

  // ---------------------------------------------------- 2. showMessageBox
  const messageBox = await evaluate(`(async () => {
      const dialog = window.require('electron').remote.dialog;
      const originalConfirm = window.confirm;
      const out = { accept: null, cancel: null, checkbox: null, sync: null };
      try {
        window.confirm = () => true;
        out.accept = await dialog.showMessageBox({
          title: 't',
          message: 'm',
          buttons: ['OK', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          checkboxLabel: 'remember',
          checkboxChecked: true,
        });
        window.confirm = () => false;
        out.cancel = await dialog.showMessageBox({
          title: 't',
          message: 'm',
          buttons: ['OK', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          checkboxLabel: 'remember',
          checkboxChecked: false,
        });
        window.confirm = () => true;
        out.checkbox = await dialog.showMessageBox({
          message: 'm',
          buttons: ['Yes', 'No'],
          checkboxLabel: 'remember',
          checkboxChecked: true,
        });
        out.sync = dialog.showMessageBoxSync({ message: 'm', buttons: ['OK', 'Cancel'] });
      } finally {
        window.confirm = originalConfirm;
      }
      return out;
    })()`);
  facts.messageBox = messageBox;
  check(
    'messageBoxIndices',
    messageBox.accept?.response === 0 &&
      messageBox.cancel?.response === 1 &&
      messageBox.checkbox?.response === 0 &&
      messageBox.checkbox?.checkboxChecked === true &&
      messageBox.accept?.checkboxChecked === true &&
      messageBox.cancel?.checkboxChecked === false &&
      messageBox.sync === 0,
    messageBox,
  );

  // -------------------------------------------- 3. showSaveDialog (no API)
  const saveSynthetic = await evaluate(`(async () => {
      const dialog = window.require('electron').remote.dialog;
      const original = window.showSaveFilePicker;
      window.showSaveFilePicker = undefined;
      let result;
      let error = null;
      let sync = null;
      let nonPdf = null;
      let nonPdfSync = 'not-run';
      try {
        result = await Promise.race([
          dialog.showSaveDialog({
            defaultPath: '/tmp/notes/My Note.pdf',
            filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
            properties: ['showOverwriteConfirmation'],
          }),
          new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), 5000)),
        ]);
        // Electron's sync variant returns string | undefined, not the object.
        sync = dialog.showSaveDialogSync({ defaultPath: '/tmp/notes/My Note.pdf' });
        // A non-PDF save must stay canceled: the browser has no landing path
        // for it, and a synthetic relative name would be written into the
        // vault root by the fs shim.
        nonPdf = await dialog.showSaveDialog({
          defaultPath: '/tmp/images/canvas.png',
          filters: [{ name: 'PNG Files', extensions: ['png'] }],
        });
        nonPdfSync = dialog.showSaveDialogSync({
          defaultPath: '/tmp/images/canvas.png',
          filters: [{ name: 'PNG Files', extensions: ['png'] }],
        });
      } catch (err) {
        error = String((err && err.message) || err);
      } finally {
        window.showSaveFilePicker = original;
      }
      return { result, error, sync, nonPdf, nonPdfSync };
    })()`);
  const syntheticResult = saveSynthetic.result || {};
  facts.saveSynthetic = {
    ...saveSynthetic,
    shape: {
      canceled: typeof syntheticResult.canceled,
      filePath: typeof syntheticResult.filePath,
      filePaths: Array.isArray(syntheticResult.filePaths),
    },
  };
  check(
    'saveDialogSynthetic',
    !saveSynthetic.error &&
      !syntheticResult.__timeout &&
      syntheticResult.canceled === false &&
      typeof syntheticResult.filePath === 'string' &&
      syntheticResult.filePath === '<browser-print-dialog>' &&
      Array.isArray(syntheticResult.filePaths) &&
      syntheticResult.filePaths[0] === syntheticResult.filePath &&
      saveSynthetic.sync === '<browser-print-dialog>' &&
      saveSynthetic.nonPdf?.canceled === true &&
      Array.isArray(saveSynthetic.nonPdf?.filePaths) &&
      saveSynthetic.nonPdf.filePaths.length === 0 &&
      saveSynthetic.nonPdfSync === undefined,
    facts.saveSynthetic,
  );

  // -------------------------------------------- 4. showSaveDialog (picker)
  const savePicker = await evaluate(`(async () => {
      const dialog = window.require('electron').remote.dialog;
      const original = window.showSaveFilePicker;
      const out = { success: null, options: null, cancel: null, fallback: null };
      try {
        window.showSaveFilePicker = async (options) => {
          window.__myobsPickerOptions = JSON.parse(JSON.stringify(options));
          return { name: 'Chosen.pdf', kind: 'file' };
        };
        out.success = await dialog.showSaveDialog({
          defaultPath: '/tmp/notes/My Note.pdf',
          filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
        });
        out.options = window.__myobsPickerOptions;

        window.showSaveFilePicker = async () => {
          const err = new Error('user canceled');
          err.name = 'AbortError';
          throw err;
        };
        out.cancel = await dialog.showSaveDialog({ defaultPath: 'x.pdf' });

        window.showSaveFilePicker = async () => {
          const err = new Error('no user gesture');
          err.name = 'SecurityError';
          throw err;
        };
        out.fallback = await dialog.showSaveDialog({ defaultPath: 'x.pdf' });
      } finally {
        window.showSaveFilePicker = original;
      }
      return out;
    })()`);
  const pickerOptions = savePicker.options || {};
  const pickerTypes = pickerOptions.types || [];
  facts.savePicker = savePicker;
  check(
    'saveDialogPicker',
    savePicker.success?.canceled === false &&
      savePicker.success?.filePath === 'Chosen.pdf' &&
      savePicker.success?.filePaths?.[0] === 'Chosen.pdf' &&
      pickerOptions.suggestedName === 'My Note.pdf' &&
      Array.isArray(pickerTypes) &&
      pickerTypes[0]?.description === 'PDF Files' &&
      Array.isArray(pickerTypes[0]?.accept?.['application/pdf']) &&
      pickerTypes[0].accept['application/pdf'].includes('.pdf') &&
      savePicker.cancel?.canceled === true &&
      Array.isArray(savePicker.cancel?.filePaths) &&
      savePicker.cancel.filePaths.length === 0 &&
      savePicker.fallback?.canceled === false &&
      savePicker.fallback?.filePath === '<browser-print-dialog>',
    savePicker,
  );

  // ----------------------------------------------------- 5. showOpenDialog
  const openDialog = await evaluate(`(async () => {
      const dialog = window.require('electron').remote.dialog;
      const originalInfo = console.info;
      window.__myobsInfo = [];
      console.info = function () {
        window.__myobsInfo.push(Array.from(arguments).map(String).join(' '));
        return originalInfo.apply(console, arguments);
      };
      let first;
      let second;
      let sync;
      try {
        first = await dialog.showOpenDialog({ properties: ['openFile'] });
        second = await dialog.showOpenDialog({ properties: ['openFile'] });
        sync = dialog.showOpenDialogSync({ properties: ['openFile'] });
      } finally {
        console.info = originalInfo;
      }
      const notes = window.__myobsInfo.filter((line) => line.includes('showOpenDialog'));
      return { first, second, sync, info: window.__myobsInfo, notes };
    })()`);
  facts.openDialog = openDialog;
  check(
    'openDialogCanceled',
    openDialog.first?.canceled === true &&
      Array.isArray(openDialog.first?.filePaths) &&
      openDialog.first.filePaths.length === 0 &&
      openDialog.second?.canceled === true &&
      openDialog.sync === undefined &&
      openDialog.notes.length === 1,
    openDialog,
  );

  // ------------------------------------------------ 6. open a note + probe
  const opened = await evaluate(`(async () => {
    const files = app.vault.getMarkdownFiles()
      .filter((f) => f.stat && f.stat.size > 500 && f.stat.size < 8000)
      .sort((a, b) => b.stat.size - a.stat.size);
    const file = files[0] || app.vault.getMarkdownFiles()[0];
    if (!file) return { ok: false, why: 'no markdown file' };
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(file);
    await new Promise((resolve) => setTimeout(resolve, 800));
    window.__myobsDialogPrint = { calls: 0, snapshots: [] };
    window.__myobsOriginalPrint = window.print;
    window.print = function () {
      window.__myobsDialogPrint.calls += 1;
      const target = document.querySelector('.myobs-print-target');
      const view = target && target.querySelector('.markdown-preview-view, .markdown-source-view');
      window.__myobsDialogPrint.snapshots.push({
        bodyClass: document.body.className,
        printing: document.body.classList.contains('myobs-printing'),
        targetFound: !!target,
        targetPath: target ? target.getAttribute('data-path') : null,
        viewKind: view
          ? (view.classList.contains('markdown-preview-view') ? 'preview' : 'source')
          : null,
        viewTextLen: view ? (view.innerText || '').trim().length : 0,
      });
    };
    // The export chain must take the synthetic save path in this harness:
    // a headless browser has no picker UI to interact with.
    window.__myobsOriginalPicker = window.showSaveFilePicker;
    window.showSaveFilePicker = undefined;
    return { ok: true, path: file.path, size: file.stat ? file.stat.size : null };
  })()`);
  if (!opened?.ok) throw new Error(`could not open a note: ${opened?.why || 'unknown'}`);
  await waitForValue(
    '!!document.querySelector(".workspace-leaf.mod-active .markdown-preview-view, .workspace-leaf.mod-active .markdown-source-view")',
    15000,
  );
  facts.openedNote = opened;

  const baseline = JSON.parse(
    await evaluate(`JSON.stringify({
      bodyClass: document.body.className,
      activePath: (app.workspace.getActiveFile() || {}).path || null,
      modalOpen: Array.from(document.querySelectorAll('.modal-container')).some((el) => {
      const style = getComputedStyle(el);
      const visible =
        style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
      return visible && /export to pdf/i.test(el.innerText || '');
    }),
    modals: Array.from(document.querySelectorAll('.modal-container')).map((el) => {
      const style = getComputedStyle(el);
      return {
        cls: el.className,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        rects: el.getClientRects().length,
        text: (el.innerText || '').slice(0, 40),
      };
    }),
    })`),
  );
  const pagesBefore = (await listPageTargets(cdp)).filter((page) => page.url.startsWith(URL_BASE)).length;

  // ------------------------------------------------------- 7. export #1
  const firstRun = await evaluate(RUN_EXPORT);
  facts.firstExportTrigger = firstRun;
  if (!firstRun?.ok) throw new Error(`export modal: ${firstRun?.why || 'unknown'}`);

  const firstState = await waitForValue(
    `(() => {
      const r = window.__MYOBS_PRINT && window.__MYOBS_PRINT.lastResult;
      return r && r.printed === true && r.at > ${Number(firstRun.beforeAt)} ? JSON.stringify(true) : '';
    })()`,
    30000,
  );
  if (!firstState) throw new Error('export #1 never reported a printed result');
  // Let the caller's finally block and the PDF surface's deferred removal run.
  await sleep(700);
  const first = await evaluate(READ_EXPORT_STATE);
  facts.firstExport = first;
  const saveCalls = await evaluate(
    `JSON.stringify(window.__MYOBS_DIALOG.calls.filter((call) => call.method === 'showSaveDialog').slice(-1))`,
  );
  const lastSaveCall = JSON.parse(saveCalls)[0] || null;
  facts.exportSaveCall = lastSaveCall;
  check(
    'exportDialogCall',
    lastSaveCall?.options?.defaultPath?.endsWith('.pdf') === true &&
      Array.isArray(lastSaveCall.options.filters) &&
      lastSaveCall.options.filters.some((filter) => filter.extensions.includes('pdf')) &&
      lastSaveCall.result?.canceled === false &&
      lastSaveCall.result?.filePath === '<browser-print-dialog>',
    lastSaveCall,
  );
  check(
    'exportPdf',
    first.result?.ok === true &&
      first.result?.printed === true &&
      first.result?.fileWritten === false &&
      first.result?.filepath === '<browser-print-dialog>' &&
      first.result?.path === baseline.activePath &&
      first.result?.reason === 'browser-print-dialog',
    {
      result: first.result,
      activePath: baseline.activePath,
    },
  );
  check(
    'exportPrintView',
    first.probeCalls >= 1 &&
      first.snapshot?.printing === true &&
      first.snapshot?.targetFound === true &&
      first.snapshot?.targetPath === baseline.activePath &&
      first.snapshot?.viewTextLen > 0,
    { probeCalls: first.probeCalls, snapshot: first.snapshot },
  );
  check(
    'exportRestored',
    first.bodyClass === baseline.bodyClass &&
      first.printRoot === false &&
      first.printStyle === false &&
      first.activeView === true &&
      first.pdfSurface === false &&
      first.modalOpen === false,
    {
      before: baseline.bodyClass,
      after: first.bodyClass,
      printRoot: first.printRoot,
      printStyle: first.printStyle,
      activeView: first.activeView,
      pdfSurface: first.pdfSurface,
      modalOpen: first.modalOpen,
    },
  );

  // The browser print dialog cannot be inspected from CDP, so render the
  // same print view through Page.printToPDF. This is the same measurement
  // tools/print-check.mjs uses (DESIGN.md §11.10).
  await evaluate('window.__MYOBS_PRINT.beginPrintView({ hold: true })');
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
  const ended = await evaluate('window.__MYOBS_PRINT.endPrintView("dialog-check-pdf")');
  facts.pdf = {
    bytes: pdfBytes.length,
    pageCount,
    header: pdfBytes.subarray(0, 5).toString('latin1'),
    ended,
  };
  check(
    'exportPdfBytes',
    pdfBytes.length > PDF_MIN_BYTES && pdfBytes.subarray(0, 5).toString('latin1') === '%PDF-',
    { bytes: pdfBytes.length, pageCount, min: PDF_MIN_BYTES },
  );

  const pagesAfter = (await listPageTargets(cdp)).filter((page) => page.url.startsWith(URL_BASE)).length;
  facts.pages = { before: pagesBefore, after: pagesAfter };
  check('noPdfPopup', pagesAfter === pagesBefore, facts.pages);

  // ------------------------------------------------------- 8. export #2
  const secondRun = await evaluate(RUN_EXPORT);
  facts.secondExportTrigger = secondRun;
  if (!secondRun?.ok) throw new Error(`second export modal: ${secondRun?.why || 'unknown'}`);
  const secondState = await waitForValue(
    `(() => {
      const r = window.__MYOBS_PRINT && window.__MYOBS_PRINT.lastResult;
      return r && r.printed === true && r.at > ${Number(secondRun.beforeAt)} ? JSON.stringify(true) : '';
    })()`,
    30000,
  );
  if (!secondState) throw new Error('export #2 never reported a printed result');
  await sleep(700);
  const second = await evaluate(READ_EXPORT_STATE);
  facts.secondExportState = second;
  check(
    'secondExport',
    second.result?.ok === true &&
      second.result?.printed === true &&
      second.result?.fileWritten === false &&
      second.result?.path === baseline.activePath &&
      second.probeCalls > first.probeCalls &&
      second.snapshot?.targetFound === true &&
      second.snapshot?.viewTextLen > 0,
    {
      result: second.result,
      probeCalls: second.probeCalls,
      previousProbeCalls: first.probeCalls,
      snapshot: second.snapshot,
    },
  );
  check(
    'secondExportRestored',
    second.bodyClass === baseline.bodyClass &&
      second.printRoot === false &&
      second.printStyle === false &&
      second.activeView === true &&
      second.pdfSurface === false &&
      second.modalOpen === false,
    {
      before: baseline.bodyClass,
      after: second.bodyClass,
      printRoot: second.printRoot,
      printStyle: second.printStyle,
      activeView: second.activeView,
      pdfSurface: second.pdfSurface,
      modalOpen: second.modalOpen,
    },
  );

  // ------------------------------------------- 9. no unhandled exceptions
  const printFailures = report.console.errors.filter((line) =>
    /Failed to save PDF|print-to-pdf|PDF surface/i.test(line),
  );
  facts.exceptions = report.console.exceptions;
  facts.printFailures = printFailures;
  check(
    'noNewExceptions',
    report.console.exceptions.length === 0 && printFailures.length === 0,
    {
      exceptions: report.console.exceptions,
      printFailures,
      warnings: report.console.warnings.slice(0, 10),
    },
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
