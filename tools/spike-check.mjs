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

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

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

// ------------------------------------------------------------------- helper

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHttp(url, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(150);
  }
  throw new Error(`server did not become ready at ${url}: ${lastErr?.message}`);
}

/**
 * Pull the acknowledgement literal out of the shipped bundle. It is compared
 * against sendSync("terms") immediately before window.close(); the string sits
 * on the left of that comparison.
 */
function readTermsFromVendor() {
  const p = path.join(REPO_ROOT, 'vendor/obsidian/app.js');
  const src = fs.readFileSync(p, 'utf8');
  const marker = '.ipcRenderer.sendSync("terms")';
  const at = src.indexOf(marker);
  if (at < 0) throw new Error('terms gate not found in vendor/obsidian/app.js');
  const open = src.lastIndexOf('"', at - 2);
  const close = src.lastIndexOf('"', open - 1);
  const value = src.slice(close + 1, open);
  if (!value || value.length < 40) {
    throw new Error('extracted terms literal looks wrong; refusing to continue');
  }
  return value;
}

async function startServer(vault, port, terms) {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(REPO_ROOT, 'packages/server'),
    env: {
      ...process.env,
      VAULT_PATH: vault,
      PORT: String(port),
      HOST: '127.0.0.1',
      TERMS_ACK: terms,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  child.on('exit', (code) => logs.push(`[server exited ${code}]`));
  await waitForHttp(`http://127.0.0.1:${port}/`, 20000);
  return { child, logs };
}

// -------------------------------------------------------------------- CDP

class Cdp {
  /** @param {string} wsUrl */
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('ws error')), {
        once: true,
      });
    });
    this.ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      for (const fn of this.listeners) fn(msg);
    });
  }

  on(fn) {
    this.listeners.add(fn);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

async function launchChrome(port) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myobs-chrome-'));
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const info = await res.json();
        return { child, userDataDir, wsUrl: info.webSocketDebuggerUrl };
      }
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error('Chrome did not expose a debugging endpoint');
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

  const terms = readTermsFromVendor();
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

    // 2. vault file count
    report.facts.fileCount = await evaluate('app.vault.getFiles().length');
    report.criteria.fileCountOver5000 = report.facts.fileCount > 5000;

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
    report.criteria.fileCountOver5000 =
      (report.facts.fileCountAfterCacheWait ?? report.facts.fileCount) > 5000;

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

    // 5. cold start budget
    report.criteria.coldStartUnder5s = report.timings.coldStartMs < 5000;

    // 6. workspace isolation. The vault copy already carries workspace.json
    // (Obsidian wrote it on the host), so existence alone proves nothing --
    // what matters is that the server session never touches it and keeps its
    // own file instead (docs/DESIGN.md §4).
    const wsJson = path.join(args.vault, '.obsidian', 'workspace.json');
    const wsServer = path.join(args.vault, '.obsidian', 'workspace-server.json');
    const wsAfter = fs.existsSync(wsJson) ? fs.statSync(wsJson).mtimeMs : null;
    report.facts.workspaceJsonMtime = { before: wsBefore, after: wsAfter };
    report.facts.workspaceServerCreated = fs.existsSync(wsServer);
    report.criteria.workspaceIsolated =
      fs.existsSync(wsServer) && wsBefore === wsAfter;

    // 7. no unhandled exceptions
    report.criteria.noExceptions = report.console.exceptions.length === 0;

    report.facts.vaultName = await evaluate('app.vault.getName()').catch(() => null);
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
