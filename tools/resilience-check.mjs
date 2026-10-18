#!/usr/bin/env node
/**
 * Backend-restart resilience acceptance harness: zero dependencies.
 *
 * Verifies the failure modes that only exist for a self-hosted backend
 * (docs/DESIGN.md §4, docs/CONTRACTS.md §2/§4/§10):
 *
 *   1. boot + window.__MYOBS_RESILIENCE.online === true
 *   2. killing the server flips online to false within 5 s and emits
 *      "offline" plus a notice
 *   3. app.vault.modify() while offline fails explicitly, emits
 *      "write-blocked", and does NOT touch disk
 *   4. a file written to disk while the server is down is invisible to the app
 *   5. restarting the server brings online back within 15 s and emits
 *      "reconnected"
 *   6. the post-reconnect reconcile makes that file appear in
 *      app.vault.getFiles()
 *   7. saving works again and the bytes on disk match
 *   8. no unhandled exceptions
 *
 * The vault MUST be a copy; this harness writes a note and a temporary file.
 *
 * Usage:
 *   node tools/resilience-check.mjs --vault <copy> [--port 3931]
 *                                   [--timeout 90] [--json <out.json>] [--log <file>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';

import {
  Cdp,
  launchChrome,
  readTermsFromVendor,
  sleep,
  startServer,
} from './lib/cdp.mjs';

// Harnesses write into whichever vault they are pointed at, so they refuse the
// operator's real vault and demand a copy. Point MYOBS_LIVE_VAULT at your own
// vault to keep the guard; forks should set it instead of editing this line.
const LIVE_VAULT =
  process.env.MYOBS_LIVE_VAULT ?? path.join(process.env.HOME ?? '', 'kywk', 'obsidian');
const DEFAULT_PORT = 3931;
const OFFLINE_BUDGET_MS = 5000;
const RECONNECT_BUDGET_MS = 15000;
const RECONCILE_BUDGET_MS = 60000;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = {
    url: null,
    vault: null,
    timeout: 120,
    json: null,
    port: DEFAULT_PORT,
    log: null,
  };
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
  let server = await startServer(args.vault, args.port, terms);
  const serverLogs = [...server.logs];
  const url = args.url ?? `http://127.0.0.1:${args.port}/`;

  const report = {
    url,
    vault: args.vault,
    checks: [],
    facts: {},
    console: { errors: [], warnings: [], exceptions: [] },
  };

  const check = (name, pass, detail) => {
    report.checks.push({ name, pass: pass === true, detail });
    const mark = pass === true ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
  };

  const chrome = await launchChrome(args.port + 1000);
  const cdp = new Cdp(chrome.wsUrl);
  let sessionId;

  async function evaluate(expression, awaitPromise = true) {
    const res = await cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue: true },
      sessionId,
    );
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ?? res.exceptionDetails.text,
      );
    }
    return res.result?.value;
  }

  async function waitFor(expression, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await evaluate(expression).catch((err) => {
        last = `error: ${err.message}`;
        return undefined;
      });
      if (last) return last;
      await sleep(200);
    }
    report.facts[`timeout:${label}`] = last ?? null;
    return undefined;
  }

  try {
    await cdp.connect();
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));

    cdp.on((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args ?? [])
          .map((a) => a.value ?? a.description ?? a.type)
          .join(' ');
        if (msg.params.type === 'error') report.console.errors.push(text);
        else if (msg.params.type === 'warning') report.console.warnings.push(text);
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

    /*
     * notices.js is a separate workstream and is still a stub in this tree.
     * Wrap push() before any page script runs so the harness can prove the
     * notice was *attempted* without depending on the UI implementation.
     */
    await cdp
      .send(
        'Page.addScriptToEvaluateOnNewDocument',
        {
          source: `(() => {
  window.__obs = { notices: [], rejections: [], errors: [], fetchCount: 0, lastFetchAt: 0 };
  window.addEventListener('unhandledrejection', (e) => {
    window.__obs.rejections.push(String(e.reason && (e.reason.stack || e.reason.message) || e.reason));
  });
  window.addEventListener('error', (e) => {
    window.__obs.errors.push(String(e.message || e.type));
  });
  /*
   * Track backend traffic so the harness can wait for the vault scan to go
   * idle before killing the server. Without this, the outage lands in the
   * middle of the initial walk and "files created during the outage" is
   * confounded with "files the walk never reached".
   */
  if (typeof window.fetch === 'function') {
    const origFetch = window.fetch.bind(window);
    window.fetch = function () {
      window.__obs.fetchCount += 1;
      window.__obs.lastFetchAt = Date.now();
      return origFetch.apply(this, arguments);
    };
  }
  const arm = () => {
    const n = window.__MYOBS_NOTICES;
    if (n && !n.__obsWrapped) {
      const orig = n.push;
      n.push = function (notice) {
        window.__obs.notices.push({ at: Date.now(), notice });
        try { return orig && orig.call(n, notice); } catch (err) { window.__obs.notices.push({ at: Date.now(), threw: String(err) }); }
      };
      n.__obsWrapped = true;
    }
  };
  setInterval(arm, 50);
  arm();
})();`,
        },
        sessionId,
      )
      .catch(() => {});

    // ---------------------------------------------------------------- boot
    const bootStarted = Date.now();
    await cdp.send('Page.navigate', { url }, sessionId);
    const appReady = await waitFor('!!window.app', args.timeout * 1000, 'app');
    if (!appReady) {
      const fatal = await evaluate(
        '(document.getElementById("myobs-fatal-detail")||{}).textContent || ""',
      ).catch(() => '');
      throw new Error(`window.app never appeared${fatal ? `\n${fatal}` : ''}`);
    }
    report.facts.bootMs = Date.now() - bootStarted;

    // Wait for the initial vault walk to finish. If reconcile starts while the
    // scan is still adding files, "did the new file appear?" would be
    // ambiguous.
    await waitFor('app.vault.getFiles().length > 0', args.timeout * 1000, 'initialFiles');
    await waitFor(
      '!!(app.metadataCache && app.metadataCache.initialized)',
      args.timeout * 1000,
      'metadataCache',
    );
    await waitFor(
      '!!(app.workspace && app.workspace.layoutReady)',
      args.timeout * 1000,
      'layoutReady',
    );
    // The vault walk is not over when metadataCache.initialized flips: the
    // adapter keeps reading attachments after the markdown index is ready.
    // Wait for a quiet window before pulling the plug.
    await waitFor(
      'window.__obs.fetchCount > 0 && Date.now() - window.__obs.lastFetchAt > 1500',
      45000,
      'idleBeforeKill',
    );
    await sleep(500);

    const bootState = JSON.parse(
      await evaluate(`JSON.stringify({
        installed: window.__MYOBS_RESILIENCE && window.__MYOBS_RESILIENCE.installed,
        online: window.__MYOBS_RESILIENCE && window.__MYOBS_RESILIENCE.online,
        files: app.vault.getFiles().length,
        loaded: app.vault.getAllLoadedFiles().length,
        watch: window.__MYOBS_WATCH && window.__MYOBS_WATCH.state,
        fatal: (()=>{const e=document.getElementById('myobs-fatal');return !!(e && !e.hidden && e.style.display!=='none');})()
      })`),
    );
    report.facts.boot = bootState;
    check(
      '1. boot + online',
      bootState.installed === true && bootState.online === true,
      { installed: bootState.installed, online: bootState.online, files: bootState.files },
    );

    // Pick a note that exists both in the app and on disk.
    const target = JSON.parse(
      await evaluate(`JSON.stringify((()=>{
        const files = app.vault.getMarkdownFiles();
        const f = files.find((x) => x.path === 'AGENTS.md') || files[0];
        return f ? { path: f.path, mtime: f.stat && f.stat.mtime, size: f.stat && f.stat.size } : null;
      })())`),
    );
    if (!target) throw new Error('no markdown file found in the vault copy');
    report.facts.target = target;
    const targetAbs = path.join(args.vault, ...target.path.split('/'));
    const original = fs.readFileSync(targetAbs, 'utf8');

    // ------------------------------------------------- 2. detect offline
    const killedAt = Date.now();
    server.child.kill('SIGTERM');
    await Promise.race([once(server.child, 'exit'), sleep(5000)]).catch(() => {});

    const wentOffline = await waitFor(
      'window.__MYOBS_RESILIENCE && window.__MYOBS_RESILIENCE.online === false',
      OFFLINE_BUDGET_MS,
      'offline',
    );
    const offlineMs = Date.now() - killedAt;
    const offlineState = JSON.parse(
      await evaluate(`JSON.stringify({
        online: window.__MYOBS_RESILIENCE.online,
        watch: window.__MYOBS_WATCH && window.__MYOBS_WATCH.state,
        events: (window.__MYOBS_RESILIENCE.events || []).map((e) => e.type),
        notices: (window.__obs.notices || []).map((n) => n.notice && { level: n.notice.level, source: n.notice.source, message: n.notice.message, dedupeKey: n.notice.dedupeKey })
      })`),
    );
    report.facts.offline = { offlineMs, ...offlineState };
    const offlineEvent = offlineState.events.includes('offline');
    const offlineNotice = offlineState.notices.some(
      (n) => n && n.source === 'server' && n.level === 'error',
    );
    check(
      '2. offline within 5 s + offline event + notice',
      wentOffline === true && offlineMs <= OFFLINE_BUDGET_MS && offlineEvent && offlineNotice,
      { offlineMs, offlineEvent, offlineNotice, watchConnected: offlineState.watch?.connected },
    );

    // --------------------------------------- 3. offline write must fail
    const marker = `\n\n<!-- myobs-resilience ${Date.now()} -->\n`;
    const writeStart = Date.now();
    const writeOutcome = await evaluate(`(async () => {
      const f = app.vault.getAbstractFileByPath(${JSON.stringify(target.path)});
      if (!f) return { settled: 'missing-file' };
      try {
        await app.vault.modify(f, ${JSON.stringify(original)} + ${JSON.stringify(marker)});
        return { settled: 'resolved' };
      } catch (err) {
        return {
          settled: 'rejected',
          name: err && err.name,
          code: err && err.code,
          message: String(err && (err.message || err)),
          myobs: err && err.myobs ? err.myobs : null
        };
      }
    })()`);
    writeOutcome.elapsedMs = Date.now() - writeStart;
    await sleep(300);

    const writeState = JSON.parse(
      await evaluate(`JSON.stringify({
        events: (window.__MYOBS_RESILIENCE.events || []).map((e) => e.type),
        writeBlocked: (window.__MYOBS_RESILIENCE.events || []).filter((e) => e.type === 'write-blocked'),
        saving: (()=>{const f=app.vault.getAbstractFileByPath(${JSON.stringify(target.path)});return f ? f.saving : null;})(),
        fatal: (()=>{const e=document.getElementById('myobs-fatal');return !!(e && !e.hidden && e.style.display!=='none');})(),
        notices: (window.__obs.notices || []).map((n) => n.notice && { source: n.notice.source, dedupeKey: n.notice.dedupeKey, message: n.notice.message })
      })`),
    );
    const diskAfterOfflineWrite = fs.readFileSync(targetAbs, 'utf8');
    const diskUnchanged =
      diskAfterOfflineWrite === original && !diskAfterOfflineWrite.includes('myobs-resilience');
    const writeBlockedEvent = writeState.writeBlocked.length > 0;
    report.facts.offlineWrite = {
      outcome: writeOutcome,
      events: writeState.events,
      writeBlocked: writeState.writeBlocked,
      saving: writeState.saving,
      fatalOverlayVisible: writeState.fatal,
      diskUnchanged,
      notices: writeState.notices,
    };
    check(
      '3. offline write fails explicitly + write-blocked + disk untouched',
      writeOutcome.settled === 'rejected' &&
        writeOutcome.code === 'EOFFLINE' &&
        writeBlockedEvent &&
        diskUnchanged,
      {
        settled: writeOutcome.settled,
        code: writeOutcome.code,
        elapsedMs: writeOutcome.elapsedMs,
        writeBlockedEvent,
        diskUnchanged,
        fatalOverlayVisible: writeState.fatal,
      },
    );

    // ------------------------------- 4. create a file while server is down
    const offlineRel = `myobs-resilience-offline-${Date.now()}.md`;
    const offlineAbs = path.join(args.vault, ...offlineRel.split('/'));
    const offlineBody = `# created while the backend was down\n\n${Date.now()}\n`;
    fs.writeFileSync(offlineAbs, offlineBody, 'utf8');
    const invisibleBefore = await evaluate(`(()=>{
      return {
        inGetFiles: app.vault.getFiles().some((f) => f.path === ${JSON.stringify(offlineRel)}),
        abstract: !!app.vault.getAbstractFileByPath(${JSON.stringify(offlineRel)})
      };
    })()`);
    report.facts.offlineFile = { rel: offlineRel, ...invisibleBefore };
    check(
      '4. file created on disk while offline is invisible to the app',
      invisibleBefore.inGetFiles === false && invisibleBefore.abstract === false,
      invisibleBefore,
    );

    // -------------------------------------------- 5. restart + reconnect
    const restartAt = Date.now();
    server = await startServer(args.vault, args.port, terms);
    serverLogs.push(...server.logs);
    const backOnline = await waitFor(
      'window.__MYOBS_RESILIENCE && window.__MYOBS_RESILIENCE.online === true',
      RECONNECT_BUDGET_MS,
      'reconnected',
    );
    const reconnectMs = Date.now() - restartAt;
    const reconnectState = JSON.parse(
      await evaluate(`JSON.stringify({
        online: window.__MYOBS_RESILIENCE.online,
        events: (window.__MYOBS_RESILIENCE.events || []).map((e) => e.type),
        watch: window.__MYOBS_WATCH && window.__MYOBS_WATCH.state
      })`),
    );
    const reconnectedEvent = reconnectState.events.includes('reconnected');
    report.facts.reconnect = { reconnectMs, ...reconnectState };
    check(
      '5. online within 15 s + reconnected event',
      backOnline === true && reconnectMs <= RECONNECT_BUDGET_MS && reconnectedEvent,
      { reconnectMs, reconnectedEvent, watchConnected: reconnectState.watch?.connected },
    );

    // ------------------------------------------------ 6. reconcile catches up
    const sawOfflineFile = await waitFor(
      `app.vault.getFiles().some((f) => f.path === ${JSON.stringify(offlineRel)})`,
      RECONCILE_BUDGET_MS,
      'reconcileOfflineFile',
    );
    const reconcileState = JSON.parse(
      await evaluate(`JSON.stringify({
        inGetFiles: app.vault.getFiles().some((f) => f.path === ${JSON.stringify(offlineRel)}),
        abstract: !!app.vault.getAbstractFileByPath(${JSON.stringify(offlineRel)}),
        adapter: !!(app.vault.adapter.files && app.vault.adapter.files[${JSON.stringify(offlineRel)}]),
        reconciling: window.__MYOBS_RESILIENCE.reconciling,
        lastReconcile: window.__MYOBS_RESILIENCE.lastReconcile,
        events: (window.__MYOBS_RESILIENCE.events || []).filter((e) => /reconcile/.test(e.type))
      })`),
    );
    report.facts.reconcile = { sawOfflineFile: sawOfflineFile === true, ...reconcileState };
    check(
      '6. offline file appears in app.vault.getFiles() after reconnect',
      sawOfflineFile === true && reconcileState.inGetFiles === true,
      {
        inGetFiles: reconcileState.inGetFiles,
        abstract: reconcileState.abstract,
        adapter: reconcileState.adapter,
        lastReconcile: reconcileState.lastReconcile,
      },
    );

    // ------------------------------------------------- 7. save works again
    const postMarker = `\n\n<!-- myobs-post-reconnect ${Date.now()} -->\n`;
    const saveOutcome = await evaluate(`(async () => {
      const f = app.vault.getAbstractFileByPath(${JSON.stringify(target.path)});
      if (!f) return { ok: false, why: 'missing-file' };
      try {
        await app.vault.modify(f, ${JSON.stringify(original)} + ${JSON.stringify(postMarker)});
        return { ok: true };
      } catch (err) {
        return { ok: false, code: err && err.code, message: String(err && (err.message || err)) };
      }
    })()`);
    await sleep(400);
    const diskAfterSave = fs.readFileSync(targetAbs, 'utf8');
    report.facts.postReconnectSave = {
      outcome: saveOutcome,
      diskHasMarker: diskAfterSave.includes('myobs-post-reconnect'),
      diskMatches:
        diskAfterSave === `${original}${postMarker}`,
    };
    check(
      '7. save after reconnect succeeds and disk matches',
      saveOutcome.ok === true &&
        diskAfterSave.includes('myobs-post-reconnect') &&
        diskAfterSave === `${original}${postMarker}`,
      {
        ok: saveOutcome.ok,
        diskHasMarker: diskAfterSave.includes('myobs-post-reconnect'),
        exact: diskAfterSave === `${original}${postMarker}`,
      },
    );

    // Restore the note through the adapter (proves the write path twice) and
    // delete the temporary note. No assertion depends on these.
    await evaluate(`(async () => {
      const f = app.vault.getAbstractFileByPath(${JSON.stringify(target.path)});
      if (f) await app.vault.modify(f, ${JSON.stringify(original)});
    })()`).catch(() => {});
    fs.unlinkSync(offlineAbs);
    await sleep(500);

    // ------------------------------------------------ 8. no unhandled errors
    const runtimeErrors = JSON.parse(
      await evaluate(`JSON.stringify({
        rejections: window.__obs.rejections || [],
        errors: window.__obs.errors || [],
        fatal: (()=>{const e=document.getElementById('myobs-fatal');return !!(e && !e.hidden && e.style.display!=='none');})(),
        fatalText: (document.getElementById('myobs-fatal-detail')||{}).textContent || ''
      })`),
    );
    report.facts.runtimeErrors = runtimeErrors;
    check(
      '8. no unhandled exceptions',
      report.console.exceptions.length === 0 &&
        runtimeErrors.rejections.length === 0 &&
        runtimeErrors.errors.length === 0 &&
        runtimeErrors.fatal === false,
      {
        cdpExceptions: report.console.exceptions.length,
        rejections: runtimeErrors.rejections.length,
        windowErrors: runtimeErrors.errors.length,
        fatalOverlayVisible: runtimeErrors.fatal,
      },
    );

    report.diagnostics = JSON.parse(
      await evaluate(`JSON.stringify({
        resilience: {
          installed: window.__MYOBS_RESILIENCE.installed,
          online: window.__MYOBS_RESILIENCE.online,
          probes: window.__MYOBS_RESILIENCE.probes,
          networkFailures: window.__MYOBS_RESILIENCE.networkFailures,
          lastProbe: window.__MYOBS_RESILIENCE.lastProbe,
          reconciling: window.__MYOBS_RESILIENCE.reconciling,
          lastReconcile: window.__MYOBS_RESILIENCE.lastReconcile,
          events: window.__MYOBS_RESILIENCE.events
        },
        watch: window.__MYOBS_WATCH && window.__MYOBS_WATCH.state,
        files: app.vault.getFiles().length,
        notices: (window.__obs.notices || []).map((n) => n.notice).filter(Boolean)
      })`),
    );
  } finally {
    cdp.close();
    chrome.child.kill();
    try {
      server.child.kill();
    } catch {
      /* already dead */
    }
    if (args.log) {
      fs.writeFileSync(args.log, serverLogs.join(''));
      console.log(`[trace] server log written to ${args.log}`);
    }
  }

  const passed = report.checks.every((c) => c.pass);
  report.passed = passed;

  console.log('\n--- report ---');
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
  console.error('resilience-check failed:', err.message);
  process.exitCode = 2;
});
