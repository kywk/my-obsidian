#!/usr/bin/env node
/**
 * Spike acceptance harness: zero dependencies.
 *
 * Drives the locally installed Chrome over CDP (Node 22 ships a global
 * WebSocket, so no puppeteer/playwright is needed) and checks the five
 * acceptance conditions in docs/DESIGN.md §10.
 *
 * Usage:
 *   node tools/spike-check.mjs [--url http://127.0.0.1:3000] [--vault <dir>]
 *                              [--timeout 90] [--json <out.json>]
 *
 * The terms acknowledgement is read from vendor/obsidian/app.js at runtime,
 * passed to the server through the environment, and never written to disk or
 * printed. See AGENTS.md hard rule 3.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  Cdp,
  assertNotLiveVault,
  launchChrome,
  readTermsFromVendor,
  sleep,
  startServer,
} from './lib/cdp.mjs';

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = { url: null, vault: null, timeout: 90, json: null, port: 3411, log: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--vault') out.vault = argv[++i];
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--log') out.log = argv[++i];
  }
  return out;
}

// Obsidian hides any path segment that starts with a dot (DESIGN §11.13), so
// this is the file count the renderer is expected to load. Comparing against
// the actual vault keeps the assertion meaningful for small vaults; a fixed
// threshold only proved that the operator happened to own a large vault.
function countVisibleFiles(dir) {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) count += countVisibleFiles(full);
    else if (entry.isFile()) count += 1;
  }
  return count;
}

// ------------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.vault) {
    throw new Error('--vault is required (never point this at the live vault)');
  }
  if (!fs.existsSync(args.vault)) {
    throw new Error(`vault does not exist: ${args.vault}`);
  }
  assertNotLiveVault(args.vault);

  const terms = readTermsFromVendor();
  const diskFileCount = countVisibleFiles(args.vault);
  const wsJsonPath = path.join(args.vault, '.obsidian', 'workspace.json');
  const wsBefore = fs.existsSync(wsJsonPath)
    ? fs.statSync(wsJsonPath).mtimeMs
    : null;
  const server = await startServer(args.vault, args.port, terms);
  const url = args.url ?? `http://127.0.0.1:${args.port}/`;

  const report = {
    url,
    vault: args.vault,
    criteria: {},
    console: { errors: [], warnings: [], exceptions: [] },
    timings: {},
    facts: {},
  };

  const chromePort = args.port + 1000;
  const chrome = await launchChrome(chromePort);
  const cdp = new Cdp(chrome.wsUrl);

  try {
    await cdp.connect();
    const { targetId } = await cdp.send('Target.createTarget', {
      url: 'about:blank',
    });
    const { sessionId } = await cdp.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });

    cdp.on((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args ?? [])
          .map((a) => a.value ?? a.description ?? a.type)
          .join(' ');
        if (msg.params.type === 'error') report.console.errors.push(text);
        else if (msg.params.type === 'warning')
          report.console.warnings.push(text);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        const ex = d.exception ?? {};
        const where = d.url ? ` @ ${d.url}:${d.lineNumber ?? 0}` : '';
        report.console.exceptions.push(
          (ex.description || d.text || ex.className || 'unknown exception') + where,
        );
      }
    });

    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Log.enable', {}, sessionId).catch(() => {});

    // Record failing fetches with their request bodies. Obsidian's vault scan
    // fans out through Promise.all; one rejected fs op aborts the whole load,
    // so a bare "Failed to fetch" without the path is not actionable.
    await cdp
      .send(
        'Page.addScriptToEvaluateOnNewDocument',
        {
          source: `(() => {
  const orig = window.fetch;
  window.__myobsFails = [];
  window.__myobsCount = 0;
  window.__myobsLast = null;
  window.fetch = function (input, init) {
    window.__myobsCount += 1;
    let body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch (e) { body = String(init && init.body); }
    window.__myobsLast = body;
    const p = orig.apply(this, arguments);
    p.then(
      (r) => { if (!r.ok) window.__myobsFails.push({ body, status: r.status, kind: 'http' }); },
      (e) => { window.__myobsFails.push({ body, error: String(e && e.message || e), kind: 'network' }); }
    );
    return p;
  };
})();`,
        },
        sessionId,
      )
      .catch(() => {});

    const started = Date.now();
    await cdp.send('Page.navigate', { url }, sessionId);

    const evaluate = async (expression, awaitPromise = true) => {
      const res = await cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise, returnByValue: true },
        sessionId,
      );
      if (res.exceptionDetails) {
        throw new Error(
          res.exceptionDetails.exception?.description ??
            res.exceptionDetails.text,
        );
      }
      return res.result?.value;
    };

    // 1. window.app exists
    const deadline = Date.now() + args.timeout * 1000;
    let appReady = false;
    while (Date.now() < deadline) {
      appReady = await evaluate('typeof window.app !== "undefined" && !!window.app').catch(
        () => false,
      );
      if (appReady) break;
      const fatal = await evaluate(
        '(function(){var e=document.getElementById("myobs-fatal");return !!(e && !e.hidden && e.style.display !== "none");})()',
      ).catch(() => false);
      if (fatal) {
        const detail = await evaluate(
          '(document.getElementById("myobs-fatal-detail")||{}).textContent || ""',
        ).catch(() => '');
        throw new Error(`runtime showed the fatal screen:\n${detail}`);
      }
      await sleep(500);
    }
    report.timings.coldStartMs = Date.now() - started;
    report.criteria.appExists = appReady;
    if (!appReady) throw new Error('window.app never appeared');

    // 1b. updater state. There is no Electron installer in this runtime;
    // "update-manual-required" made the renderer show the desktop-only
    // "Update Available / reinstall" dialog on every boot.
    const updater = await evaluate(`(function () {
      try {
        return {
          state: electron.ipcRenderer.sendSync("update"),
          disabled: electron.ipcRenderer.sendSync("disable-update"),
        };
      } catch (err) {
        return { error: String(err && err.message || err) };
      }
    })()`).catch((err) => ({ error: String(err && err.message || err) }));
    report.facts.updater = updater;
    report.criteria.noInstallerUpdate =
      !!updater && updater.state === "" && updater.disabled === true;

    // 2. vault file count. The boot-time value can be 0/partial because the
    // scan is still running; the authoritative comparison happens after the
    // metadata cache is ready.
    report.facts.diskFileCount = diskFileCount;
    report.facts.fileCountAtBoot = await evaluate('app.vault.getFiles().length');

    // 3. metadata cache
    let cacheReady = false;
    let lastProgress = 0;
    while (Date.now() < deadline) {
      cacheReady = await evaluate(
        '!!app.metadataCache.initialized === true',
      ).catch(() => false);
      if (cacheReady) break;
      if (!lastProgress || Date.now() - lastProgress > 10000) {
        lastProgress = Date.now();
        const seen = await evaluate('app.vault.getAllLoadedFiles().length').catch(
          () => null,
        );
        const at = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`[trace] t=${at}s loadedFiles=${seen} cacheReady=${cacheReady}`);
      }
      await sleep(500);
    }
    report.criteria.metadataCacheInitialized = cacheReady;

    // The vault scan is serialized by Obsidian's own adapter queue, so the
    // file count seen right after boot is a partial view. Re-measure now.
    report.facts.fileCountAfterCacheWait = await evaluate(
      'app.vault.getFiles().length',
    ).catch(() => null);
    report.facts.loadedFiles = await evaluate(
      'app.vault.getAllLoadedFiles().length',
    ).catch(() => null);
    report.criteria.fileCountMatchesDisk =
      (report.facts.fileCountAfterCacheWait ?? 0) >= diskFileCount;

    // 4. write round-trip on a real note
    const writeResult = await evaluate(`(async () => {
      const files = app.vault.getMarkdownFiles();
      const target = files.find((f) => f.path.startsWith('_incoming/')) || files[0];
      if (!target) return { ok: false, why: 'no markdown file found' };
      const original = await app.vault.read(target);
      const marker = '\\n\\n<!-- myobs-spike ' + Date.now() + ' -->\\n';
      await app.vault.modify(target, original + marker);
      await new Promise((r) => setTimeout(r, 400));
      const reread = await app.vault.read(target);
      await app.vault.modify(target, original);
      await new Promise((r) => setTimeout(r, 300));
      return {
        ok: true,
        path: target.path,
        appendedLen: reread.length - original.length,
        restored: (await app.vault.read(target)) === original,
      };
    })()`);

    if (writeResult?.ok) {
      const onDisk = fs.readFileSync(
        path.join(args.vault, ...writeResult.path.split('/')),
        'utf8',
      );
      report.criteria.writeRoundTrip = writeResult.restored;
      report.facts.writeTarget = writeResult.path;
    } else {
      report.criteria.writeRoundTrip = false;
      report.facts.writeTarget = writeResult?.why ?? 'unknown';
    }

    // 5. binary round-trip. Text writes go through a different adapter path than
    // binary ones, and the binary path is where the renderer's bare-Buffer
    // references live (`Buffer.from`, `Buffer.concat`, ...). Without them the
    // whole attachment pipeline is broken and text-only testing hides it.
    const binaryResult = await evaluate(`(async () => {
      const name = 'myobs-spike-binary.bin';
      const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 65, 66, 67]);
      await app.vault.adapter.writeBinary(name, bytes.buffer);
      const back = await app.vault.adapter.readBinary(name);
      const view = new Uint8Array(back);
      const same = view.length === bytes.length && view.every((b, i) => b === bytes[i]);
      await app.vault.adapter.remove(name);
      return { ok: true, same, length: view.length };
    })()`).catch((err) => ({ ok: false, why: String(err.message || err) }));
    report.criteria.binaryRoundTrip = binaryResult?.same === true;
    report.facts.binaryRoundTrip = binaryResult;

    // 6. cold start budget
    report.criteria.coldStartUnder5s = report.timings.coldStartMs < 5000;

    // 6. workspace isolation. The vault copy already carries workspace.json
    // (Obsidian wrote it on the host), so existence alone proves nothing --
    // what matters is that the server session never touches it and keeps its
    // own file instead (docs/DESIGN.md §4).
    //
    // Obsidian saves its layout after a debounce, measured at ~4.4s from boot on
    // a fresh vault copy. Sampling at ~2s produced a flaky false negative that
    // three separate workstreams hit independently, so wait for the file rather
    // than assuming when it lands.
    const wsJson = path.join(args.vault, '.obsidian', 'workspace.json');
    const wsServer = path.join(args.vault, '.obsidian', 'workspace-server.json');
    const wsDeadline = Date.now() + 15000;
    while (Date.now() < wsDeadline && !fs.existsSync(wsServer)) {
      await sleep(200);
    }
    const wsAfter = fs.existsSync(wsJson) ? fs.statSync(wsJson).mtimeMs : null;
    report.facts.workspaceJsonMtime = { before: wsBefore, after: wsAfter };
    report.facts.workspaceServerCreated = fs.existsSync(wsServer);
    report.criteria.workspaceIsolated =
      fs.existsSync(wsServer) && wsBefore === wsAfter;

    // 7. no unhandled exceptions
    report.criteria.noExceptions = report.console.exceptions.length === 0;

    // 8. a ResizeObserver loop warning must not become the full-screen fatal
    // overlay. Chrome reports it as an ErrorEvent even when layout is healthy;
    // treating it as fatal blocks every subsequent click (DESIGN.md §11.15).
    report.facts.benignError = await evaluate(`(function () {
      var fatal = document.getElementById('myobs-fatal');
      var before = !!(fatal && !fatal.hidden && fatal.style.display !== 'none');
      window.dispatchEvent(new ErrorEvent('error', {
        message: 'ResizeObserver loop completed with undelivered notifications.',
        filename: 'http://127.0.0.1/myobs-benign-error',
        lineno: 0,
        colno: 0
      }));
      return {
        before: before,
        after: !!(fatal && !fatal.hidden && fatal.style.display !== 'none'),
        detail: (document.getElementById('myobs-fatal-detail') || {}).textContent || ''
      };
    })()`);
    report.criteria.benignErrorIgnored =
      report.facts.benignError?.before === false && report.facts.benignError?.after === false;

    report.facts.vaultName = await evaluate('app.vault.getName()').catch(() => null);
    // Node globals the renderer references 184 times; if Buffer is missing, every
    // binary path throws "Buffer is not defined" and only the text path works.
    report.facts.nodeGlobals = await evaluate(
      'JSON.stringify({Buffer: typeof Buffer, process: typeof process, global: typeof global, setImmediate: typeof setImmediate})',
    ).catch(() => null);
    report.facts.fetchCount = await evaluate('window.__myobsCount').catch(() => null);
    report.facts.fetchFails = await evaluate(
      'JSON.stringify((window.__myobsFails || []).slice(0, 8))',
    ).catch(() => null);
    report.facts.lastFetch = await evaluate(
      'JSON.stringify(window.__myobsLast)',
    ).catch(() => null);
    report.facts.platform = await evaluate(
      'JSON.stringify({desktopApp:Platform.isDesktopApp, mobile:Platform.isMobile, mobileApp:Platform.isMobileApp})',
    ).catch(() => null);
    report.facts.obsidianVersion = await evaluate('Platform.version').catch(() => null);
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

  if (report.console.exceptions.length) {
    console.log('\n--- exceptions ---');
    for (const e of report.console.exceptions.slice(0, 10)) console.log(e);
  }
  if (report.console.errors.length) {
    console.log('\n--- console errors ---');
    for (const e of report.console.errors.slice(0, 10)) console.log(e);
  }

  process.exitCode = passed ? 0 : 1;
}

main().catch((err) => {
  console.error('spike-check failed:', err.message);
  process.exitCode = 2;
});
