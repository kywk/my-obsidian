#!/usr/bin/env node
/**
 * Attachment acceptance harness (zero dependencies).
 *
 * Two spike rounds recorded 0 requests to /v/* because no test ever rendered a
 * note that has attachments. This script closes that gap end to end: it boots
 * the real renderer against a vault copy, asks the shipped adapter for an
 * attachment URL, and checks the URL shape, the bytes, that the browser really
 * *decodes* the image, that Range works, that the lazy-loaded pdfjs arrives,
 * and that the server never answers 4xx/5xx on /v/*.
 *
 * It deliberately never touches the live vault: --vault must be a copy.
 *
 * Findings it reports rather than hides (see the FAIL diagnostics):
 *   FileSystemAdapter.resourcePathPrefix comes from ipcRenderer.sendSync(
 *   "file-url"), and packages/shim/src/electron-shim.js answers that with
 *   __MYOBS.resourcesPath ("/obsidian") instead of __MYOBS.resourcePrefix
 *   ("/v/"). Every attachment URL therefore reads "/obsidianprivate/var/...",
 *   which lands on the static-asset route and 404s -- it never reaches /v/*.
 *   Returning boot.resourcePrefix from that handler makes all ten checks pass;
 *   that was verified against an isolated copy of this repository.
 * Checks 2-8 still run here against a URL built from the same adapter API
 * after a test-only in-page correction of that one field, so the server side
 * of the contract is verified either way.
 *
 * Usage:
 *   node tools/attachment-check.mjs --vault <dir> [--port 3502] [--chrome-port 4502]
 *                                   [--prepare] [--json <out.json>] [--timeout 90]
 *
 * Without --prepare a --vault that already holds the fixtures is reused; an
 * empty or fixture-less --vault is populated (rsync + fixtures) first.
 *
 * The terms acknowledgement is read from vendor/obsidian/app.js at runtime,
 * passed to the server through the environment, and never written to disk or
 * printed (AGENTS.md hard rule 3).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  Cdp,
  REPO_ROOT,
  assertNotLiveVault,
  launchChrome,
  liveVaultPath,
  readTermsFromVendor,
  sleep,
  startServer,
} from './lib/cdp.mjs';

// The live vault is only ever read: it is the rsync source when --vault does
// not already look like a vault. Harnesses still refuse to run against it.
const SOURCE_VAULT = liveVaultPath();
const FIXTURE_DIR = path.join(REPO_ROOT, 'tools/fixtures/attachments');

/** Vault subdirectories that receive the fixtures. */
const ASSET_DIRS = ['_attach', '_attach 測試'];

/**
 * Filenames whose characters break naive URL handling. Each one gets the real
 * PNG bytes so the browser decode check is meaningful.
 */
const SPECIAL_NAMES = [
  'space 空 白.png',
  'hash#tag.png',
  'q?mark.png',
  'pct%20.png',
  'emoji 😀.png',
];

/**
 * A decoy that exists only to catch a double-decoding server: if the handler
 * runs decodeURIComponent() on the already-decoded router param, the request
 * for "pct%2520.png" resolves here and silently returns the wrong bytes.
 */
const DECOY_NAME = 'pct .png';

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = {
    vault: null,
    port: 3502,
    chromePort: 4502,
    prepare: false,
    json: null,
    log: null,
    timeout: 90,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--vault') out.vault = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--chrome-port') out.chromePort = Number(argv[++i]);
    else if (a === '--prepare') out.prepare = true;
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--log') out.log = argv[++i];
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
  }
  return out;
}

// ---------------------------------------------------------------- processes

/**
 * A leftover server from an earlier run would answer waitForHttp() and serve
 * the page, while this run's own server dies on EADDRINUSE -- the checks would
 * then pass against a process whose logs we never see. Refuse to start.
 *
 * @param {number} port
 * @returns {Promise<string | null>} a description when the port is busy
 */
async function busyPort(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1500),
    });
    return `HTTP ${res.status}`;
  } catch {
    return null;
  }
}

/**
 * SIGTERM, then SIGKILL. The server's own shutdown path awaits app.close(),
 * which is not guaranteed to finish, and a survivor holds the port for the
 * next run.
 *
 * @param {import('node:child_process').ChildProcess | null} child
 */
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exit = new Promise((resolve) => child.once('exit', () => resolve(true)));
  if (!(await Promise.race([exit, sleep(5000).then(() => false)]))) {
    child.kill('SIGKILL');
    await Promise.race([exit, sleep(2000)]);
  }
}

// ------------------------------------------------------------ vault fixtures

/** The four files every asset directory receives. */
const FIXTURE_NAMES = ['pixel.png', 'doc.pdf', 'tone.wav', 'note-with-attachments.md'];

/**
 * The fixtures are what make this check meaningful, so a stale copy in an
 * existing vault is worse than no copy: compare bytes, not existence.
 *
 * @param {string} dest
 * @returns {boolean}
 */
function fixturesUpToDate(dest) {
  const png = fs.readFileSync(path.join(FIXTURE_DIR, 'pixel.png'));
  for (const dir of ASSET_DIRS) {
    for (const name of FIXTURE_NAMES) {
      const target = path.join(dest, dir, name);
      if (!fs.existsSync(target)) return false;
      if (!fs.readFileSync(target).equals(fs.readFileSync(path.join(FIXTURE_DIR, name)))) {
        return false;
      }
    }
    for (const name of SPECIAL_NAMES) {
      const target = path.join(dest, dir, name);
      if (!fs.existsSync(target) || !fs.readFileSync(target).equals(png)) return false;
    }
    const decoy = path.join(dest, dir, DECOY_NAME);
    if (!fs.existsSync(decoy) || fs.readFileSync(decoy, 'utf8') !== 'decoy, not an image\n') {
      return false;
    }
  }
  return true;
}

/**
 * @param {string} dest
 */
function copyFixtures(dest) {
  const png = fs.readFileSync(path.join(FIXTURE_DIR, 'pixel.png'));
  for (const dir of ASSET_DIRS) {
    const target = path.join(dest, dir);
    fs.mkdirSync(target, { recursive: true });
    for (const name of FIXTURE_NAMES) {
      fs.copyFileSync(path.join(FIXTURE_DIR, name), path.join(target, name));
    }
    for (const name of SPECIAL_NAMES) {
      fs.writeFileSync(path.join(target, name), png);
    }
    fs.writeFileSync(path.join(target, DECOY_NAME), Buffer.from('decoy, not an image\n'));
  }
}

/**
 * Build the vault copy this check runs against. The live vault is only read.
 *
 * @param {string} dest
 * @param {boolean} force
 * @returns {{ rsynced: boolean, copied: boolean }}
 */
function prepareVault(dest, force) {
  const looksLikeVault = fs.existsSync(path.join(dest, '.obsidian'));
  let rsynced = false;

  if (force || !looksLikeVault) {
    console.log(`[prep] rsync ${SOURCE_VAULT} -> ${dest}`);
    fs.mkdirSync(dest, { recursive: true });
    execFileSync(
      'rsync',
      [
        '-a',
        '--exclude=.git/',
        '--exclude=.docusaurus/',
        '--exclude=node_modules/',
        `${SOURCE_VAULT.replace(/\/$/, '')}/`,
        `${dest.replace(/\/$/, '')}/`,
      ],
      { stdio: 'inherit' },
    );
    rsynced = true;
  }

  const copied = !fixturesUpToDate(dest);
  if (copied) copyFixtures(dest);
  return { rsynced, copied };
}

// ----------------------------------------------------------------- reporting

const report = {
  vault: null,
  server: null,
  chrome: null,
  checks: {},
  facts: {},
  diagnostics: [],
  network: { vRequests: [], failures: [], bootPhase: [], misprefixed: [] },
  console: { errors: [], exceptions: [] },
};

function record(id, ok, detail) {
  report.checks[id] = { ok, detail };
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`);
  if (!ok) report.diagnostics.push(`${id}: ${detail}`);
  return ok;
}

function note(message) {
  console.log(`[trace] ${message}`);
}

// ------------------------------------------------------------------- helpers

/**
 * @param {Cdp} cdp
 * @param {string} sessionId
 */
function makeEvaluator(cdp, sessionId) {
  return async function evaluate(expression, awaitPromise = true) {
    const res = await cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue: true },
      sessionId,
    );
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(d.exception?.description ?? d.text ?? 'evaluate failed');
    }
    return res.result?.value;
  };
}

/**
 * Read a URL through the page and hand back base64 so the bytes can be
 * compared with the copy on disk.
 *
 * @param {(e: string, a?: boolean) => Promise<any>} evaluate
 * @param {string} url
 * @param {object} [init] extra fetch init, serialised into the page
 */
function fetchInPage(evaluate, url, init) {
  const initJson = JSON.stringify(init ?? {});
  return evaluate(`(async () => {
    const res = await fetch(${JSON.stringify(url)}, ${initJson});
    const buf = new Uint8Array(await res.arrayBuffer());
    let binary = '';
    for (let i = 0; i < buf.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    }
    return {
      status: res.status,
      headers: {
        contentType: res.headers.get('content-type'),
        contentLength: res.headers.get('content-length'),
        contentRange: res.headers.get('content-range'),
        acceptRanges: res.headers.get('accept-ranges'),
      },
      length: buf.length,
      base64: btoa(binary),
    };
  })()`);
}

/**
 * Insert an <img> and report whether the browser decoded it. An HTTP 200 alone
 * only proves the bytes arrived; naturalWidth > 0 proves the decoder accepted
 * them, which is what an attachment preview actually needs.
 *
 * @param {(e: string, a?: boolean) => Promise<any>} evaluate
 * @param {string} url
 */
function decodeImageInPage(evaluate, url) {
  return evaluate(`(async () => {
    const img = new Image();
    // Listeners first: attaching them after src would race the load.
    const settled = new Promise((resolve) => {
      img.addEventListener('load', () => resolve(true), { once: true });
      img.addEventListener('error', () => resolve(false), { once: true });
      setTimeout(() => resolve(false), 8000);
    });
    img.alt = 'attachment-check';
    img.src = ${JSON.stringify(url)};
    document.body.appendChild(img);
    await settled;
    return {
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      src: img.src,
      currentSrc: img.currentSrc,
    };
  })()`);
}

/** @param {string} base64 */
const bytes = (base64) => Buffer.from(base64, 'base64');

/**
 * @param {string} dir
 * @param {string} name
 */
const relative = (dir, name) => `${dir}/${name}`;

/** Characters that force percent-encoding in a URL path segment. */
const ENCODED_CHARS = /[ #?%\u4e00-\u9fff]|[\u{1F300}-\u{1FAFF}]/u;

// ---------------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.vault) {
    throw new Error('--vault is required (point it at a vault copy, never the live vault)');
  }
  assertNotLiveVault(args.vault);
  if (!fs.existsSync(FIXTURE_DIR)) {
    throw new Error(`fixtures missing: ${FIXTURE_DIR}`);
  }

  const prep = prepareVault(args.vault, args.prepare);
  note(
    `vault ${args.vault} (rsync=${prep.rsynced ? 'yes' : 'skipped'}, fixtures=${prep.copied ? 'copied' : 'up to date'})`,
  );
  report.vault = args.vault;
  report.server = { port: args.port, url: `http://127.0.0.1:${args.port}/` };
  report.chrome = { debugPort: args.chromePort };

  const terms = readTermsFromVendor();
  const busy = await busyPort(args.port);
  if (busy !== null) {
    throw new Error(
      `port ${args.port} already answers (${busy}); a leftover server from an earlier run would ` +
        `serve this run's page while its own server dies on EADDRINUSE. Stop it or pass --port.`,
    );
  }
  const server = await startServer(args.vault, args.port, terms, { WATCH_DISABLED: '1' });
  const chrome = await launchChrome(args.chromePort);
  const cdp = new Cdp(chrome.wsUrl);

  /** @type {(e: string, a?: boolean) => Promise<any>} */
  let evaluate = async () => null;

  try {
    await cdp.connect();
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    let bootDone = false;
    cdp.on((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        report.console.errors.push(
          (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' '),
        );
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        report.console.exceptions.push(
          d.exception?.description ?? d.text ?? 'unknown exception',
        );
      } else if (msg.method === 'Network.responseReceived') {
        // Only /v/* is under test; the boot's fs traffic is a different
        // endpoint and a different acceptance script.
        const entry = {
          url: msg.params.response.url,
          status: msg.params.response.status,
        };
        if (entry.url.includes('/v/')) {
          report.network.vRequests.push(entry);
          if (!bootDone) report.network.bootPhase.push(entry);
          if (entry.status >= 400) report.network.failures.push(entry);
        } else {
          // A "/v/*" URL with the prefix missing lands on the static route as
          // "/obsidian<absolute path>". Those are attachments too.
          const pathname = new URL(entry.url).pathname;
          if (pathname.startsWith('/obsidian') && pathname[9] !== '/') {
            report.network.misprefixed.push({ ...entry, phase: bootDone ? 'checks' : 'boot' });
          }
        }
      } else if (msg.method === 'Network.loadingFailed') {
        // Map requestId -> url: several requests are usually in flight, so
        // "last URL seen" is the wrong attribution for a failure.
        const failedUrl = report.network.byRequestId?.[msg.params.requestId] ?? '(unknown)';
        // resilience.js probes the backend every 2s with HEAD /?myobs-probe=…
        // and aborts its own request on timeout. That is a health check, not a
        // vault request, so counting it as a failure here would report a
        // regression that is really the app measuring itself under load.
        if (/[?&]myobs-probe=/.test(failedUrl)) {
          report.network.probeAborts = (report.network.probeAborts ?? 0) + 1;
          return;
        }
        report.network.failures.push({
          url: failedUrl,
          status: 0,
          error: msg.params.errorText,
          type: msg.params.type,
        });
      } else if (msg.method === 'Network.requestWillBeSent') {
        report.network.byRequestId = report.network.byRequestId ?? {};
        report.network.byRequestId[msg.params.requestId] = msg.params.request.url;
        report.network.lastRequestUrl = msg.params.request.url;
      }
    });

    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Log.enable', {}, sessionId).catch(() => {});
    evaluate = makeEvaluator(cdp, sessionId);

    const started = Date.now();
    await cdp.send('Page.navigate', { url: report.server.url }, sessionId);

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
      await sleep(400);
    }
    report.facts.coldStartMs = Date.now() - started;
    if (!appReady) throw new Error('window.app never appeared');

    // The vault tree has to know the fixtures before the adapter can be asked
    // about them.
    for (const dir of ASSET_DIRS) {
      const target = relative(dir, 'pixel.png');
      while (Date.now() < deadline) {
        const found = await evaluate(
          `!!app.vault.getAbstractFileByPath(${JSON.stringify(target)})`,
        ).catch(() => false);
        if (found) break;
        await sleep(300);
      }
    }
    bootDone = true;
    note(
      `boot ${report.facts.coldStartMs} ms; /v/* requests during boot: ${report.network.bootPhase.length}`,
    );

    report.facts.boot = {
      vaultPath: await evaluate('window.__MYOBS.vaultPath'),
      resourcePrefix: await evaluate('window.__MYOBS.resourcePrefix'),
      resourcesPath: await evaluate('window.__MYOBS.resourcesPath'),
      fileCount: await evaluate('app.vault.getFiles().length'),
    };

    // ------------------------------------- 1. the URL the shipped adapter makes
    const sample = await evaluate(`(() => {
      const rel = ${JSON.stringify(relative(ASSET_DIRS[0], 'pixel.png'))};
      return {
        url: app.vault.adapter.getResourcePath(rel),
        adapterPrefix: app.vault.adapter.resourcePathPrefix,
        basePath: app.vault.adapter.getBasePath(),
        absolute: app.vault.adapter.getFullPath(rel),
      };
    })()`);
    report.facts.adapter = sample;

    const prefixOk = sample.url.startsWith(report.facts.boot.resourcePrefix);
    let brokenStatus = null;
    let brokenBody = null;
    if (!prefixOk) {
      // Fetch the URL the shipped pipeline actually produces, so the report
      // shows where those requests land instead of only asserting they are
      // wrong. It is already a plain string, so this runs after any correction.
      const broken = await fetchInPage(evaluate, sample.url).catch(() => null);
      brokenStatus = broken?.status ?? null;
      brokenBody = broken ? bytes(broken.base64).toString('utf8', 0, 200) : null;
    }
    report.facts.brokenAdapterUrl = { url: sample.url, status: brokenStatus, body: brokenBody };
    const prefixDetail = prefixOk
      ? `adapter URL ${sample.url}`
      : `adapter.resourcePathPrefix is ${JSON.stringify(sample.adapterPrefix)} but __MYOBS.resourcePrefix is ` +
        `${JSON.stringify(report.facts.boot.resourcePrefix)}; getResourcePath() returned ` +
        `${JSON.stringify(sample.url)}, which answers HTTP ${brokenStatus} on the static-asset route ` +
        `(body: ${JSON.stringify(brokenBody)}) and can never reach /v/*. Cause: ` +
        `packages/shim/src/electron-shim.js "file-url" returns __MYOBS.resourcesPath; CONTRACTS.md §1 ` +
        `assigns resourcePrefix to exactly this use (adapter.getResourcePath). ` +
        `Returning boot.resourcePrefix there makes all ten checks pass (verified in an isolated copy).`;
    record('1.getResourcePath-shape', prefixOk, prefixDetail);

    if (!prefixOk) {
      // Test-only: correct the single field in the page so checks 2-8 exercise
      // the server contract. No file is modified and the failure above stands.
      await evaluate(`(() => {
        app.vault.adapter.resourcePathPrefix = window.__MYOBS.resourcePrefix;
        return app.vault.adapter.resourcePathPrefix;
      })()`);
      note('corrected adapter.resourcePathPrefix in-page (test only) to continue verifying the server side');
    }

    // From here on every request is ours; a cold cache keeps the network log
    // from hiding a request behind a 200 served from disk cache.
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);

    // ------------------------------------------------- 1b + 2 + 3 + 4 + 4b
    const assets = [];
    for (const dir of ASSET_DIRS) {
      assets.push({ dir, name: 'pixel.png', kind: 'png' });
      assets.push({ dir, name: 'tone.wav', kind: 'wav' });
      assets.push({ dir, name: 'doc.pdf', kind: 'pdf' });
      for (const name of SPECIAL_NAMES) assets.push({ dir, name, kind: 'png' });
    }

    let shapeOk = true;
    let bytesOk = true;
    let decodeOk = true;
    const perAsset = [];

    for (const asset of assets) {
      const rel = relative(asset.dir, asset.name);
      const info = await evaluate(`(() => {
        const rel = ${JSON.stringify(rel)};
        return {
          url: app.vault.adapter.getResourcePath(rel),
          absolute: app.vault.adapter.getFullPath(rel),
          bootPrefix: window.__MYOBS.resourcePrefix,
        };
      })()`);

      const queryAt = info.url.indexOf('?');
      const encodedPath = info.url.slice(3, queryAt);
      const query = info.url.slice(queryAt + 1);
      const decodedPath = encodedPath.split('/').map(decodeURIComponent).join('/');
      const shapeProblems = [];
      if (info.bootPrefix !== '/v/') shapeProblems.push(`resourcePrefix is ${info.bootPrefix}`);
      if (!info.url.startsWith(info.bootPrefix)) shapeProblems.push('no /v/ prefix');
      if (info.url.includes('file://')) shapeProblems.push('still contains file://');
      if (queryAt < 0 || !/^\d+$/.test(query)) shapeProblems.push(`query is not an mtime: ${query}`);
      if (decodedPath !== info.absolute.replace(/^\//, '')) {
        shapeProblems.push(`decoded ${decodedPath} != absolute ${info.absolute}`);
      }

      let fetchResult = null;
      let fetchError = null;
      try {
        fetchResult = await fetchInPage(evaluate, info.url);
      } catch (err) {
        fetchError = String(err.message ?? err);
      }
      const disk = fs.readFileSync(path.join(args.vault, ...rel.split('/')));
      const sameBytes =
        fetchResult !== null &&
        fetchResult.status === 200 &&
        fetchResult.length === disk.length &&
        bytes(fetchResult.base64).equals(disk);

      const decode = asset.kind === 'png' ? await decodeImageInPage(evaluate, info.url) : null;

      perAsset.push({
        rel,
        url: info.url,
        shapeOk: shapeProblems.length === 0,
        shapeProblems,
        httpStatus: fetchResult?.status ?? null,
        fetchError,
        contentType: fetchResult?.headers.contentType ?? null,
        diskBytes: disk.length,
        fetchedBytes: fetchResult?.length ?? null,
        sameBytes,
        naturalWidth: decode?.naturalWidth ?? null,
        decodeOk: decode === null ? null : decode.naturalWidth > 0,
      });

      if (shapeProblems.length > 0) shapeOk = false;
      if (!sameBytes) bytesOk = false;
      if (decode !== null && decode.naturalWidth <= 0) decodeOk = false;
    }
    report.facts.assets = perAsset;

    const shapeFailure = perAsset.find((a) => !a.shapeOk);
    record(
      '1b.url-shape-contract',
      shapeOk,
      shapeOk
        ? `${perAsset.length} URLs are "/v/" + percent-encoded absolute path + "?mtime"`
        : `${shapeFailure.rel}: ${shapeFailure.shapeProblems.join('; ')}`,
    );

    const bytesFailure = perAsset.find((a) => !a.sameBytes);
    record(
      '2.bytes-identical',
      bytesOk,
      bytesOk
        ? `${perAsset.length} assets: HTTP 200 and bit-identical bytes`
        : `${bytesFailure.rel}: status=${bytesFailure.httpStatus} disk=${bytesFailure.diskBytes} ` +
          `fetched=${bytesFailure.fetchedBytes} err=${bytesFailure.fetchError ?? '-'}`,
    );

    const images = perAsset.filter((a) => a.decodeOk !== null);
    const decodeFailure = images.find((a) => !a.decodeOk);
    record(
      '3.image-decoded',
      decodeOk,
      decodeOk
        ? `${images.length} inserted <img> elements decoded (naturalWidth > 0)`
        : `${decodeFailure.rel}: naturalWidth=${decodeFailure.naturalWidth} url=${decodeFailure.url}`,
    );

    // 4. names that need encoding; the directory name counts for everything
    // underneath it, the file name has to carry the character itself.
    const tricky = perAsset.filter((a) => ENCODED_CHARS.test(a.rel));
    const trickyBad = tricky.find((a) => !(a.shapeOk && a.sameBytes && a.decodeOk !== false));
    record(
      '4.encoded-filenames',
      tricky.length > 0 && trickyBad === undefined,
      tricky.length > 0 && trickyBad === undefined
        ? `${tricky.length} assets under names with space/CJK/#/?/%/emoji passed 1b-3`
        : trickyBad
          ? `${trickyBad.rel}: shape=[${trickyBad.shapeProblems.join('; ')}] status=${trickyBad.httpStatus} ` +
            `sameBytes=${trickyBad.sameBytes} naturalWidth=${trickyBad.naturalWidth}`
          : 'no encoded names were exercised',
    );

    // 4b. the decoy proves a double decode is not silently serving other bytes.
    const decoyUrl = await evaluate(
      `app.vault.adapter.getResourcePath(${JSON.stringify(relative(ASSET_DIRS[0], 'pct%20.png'))})`,
    );
    const decoyFetch = await fetchInPage(evaluate, decoyUrl);
    const decoyReal = fs.readFileSync(path.join(args.vault, ASSET_DIRS[0], 'pct%20.png'));
    const decoyOk = bytes(decoyFetch.base64).equals(decoyReal);
    report.facts.decoy = { url: decoyUrl, bytes: decoyFetch.length, expected: decoyReal.length };
    record(
      '4b.percent-name-not-confused',
      decoyOk,
      decoyOk
        ? '"pct%20.png" is served as itself, not as the "pct .png" decoy next to it'
        : `the request for pct%20.png resolved to different bytes (${decoyUrl})`,
    );

    // ------------------------------------------------------------- 5. Range
    const rangeRel = relative(ASSET_DIRS[1], 'tone.wav');
    const rangeUrl = await evaluate(
      `app.vault.adapter.getResourcePath(${JSON.stringify(rangeRel)})`,
    );
    const rangeResult = await fetchInPage(evaluate, rangeUrl, {
      headers: { Range: 'bytes=0-9' },
    });
    const rangeDisk = fs.readFileSync(path.join(args.vault, ...rangeRel.split('/')));
    const rangeBytes = bytes(rangeResult.base64);
    const expectedRange = `bytes 0-9/${rangeDisk.length}`;
    const rangeOk =
      rangeResult.status === 206 &&
      rangeResult.headers.contentRange === expectedRange &&
      rangeResult.headers.acceptRanges === 'bytes' &&
      rangeBytes.length === 10 &&
      rangeBytes.equals(rangeDisk.subarray(0, 10));
    report.facts.range = {
      url: rangeUrl,
      status: rangeResult.status,
      contentRange: rangeResult.headers.contentRange,
      acceptRanges: rangeResult.headers.acceptRanges,
      length: rangeBytes.length,
      expected: expectedRange,
      fileSize: rangeDisk.length,
    };
    record(
      '5.range-request',
      rangeOk,
      rangeOk
        ? `206, Content-Range: ${expectedRange}, 10 bytes identical to the first 10 on disk`
        : `status=${rangeResult.status} content-range=${rangeResult.headers.contentRange} ` +
          `(expected ${expectedRange}) accept-ranges=${rangeResult.headers.acceptRanges} length=${rangeBytes.length}`,
    );

    // --------------------------------------------------- 6. pdfjs lazy load
    const pdfRel = relative(ASSET_DIRS[0], 'doc.pdf');
    const pdfOpened = await evaluate(`(async () => {
      const file = app.vault.getAbstractFileByPath(${JSON.stringify(pdfRel)});
      if (!file) return { ok: false, why: 'file not in the vault tree' };
      const leaf = app.workspace.getLeaf(true);
      await leaf.openFile(file);
      return { ok: true, view: leaf.view && leaf.view.getViewType ? leaf.view.getViewType() : null };
    })()`).catch((err) => ({ ok: false, why: String(err.message ?? err) }));

    let pdfInfo = { type: 'undefined', version: null };
    const pdfDeadline = Date.now() + 25000;
    while (Date.now() < pdfDeadline) {
      const raw = await evaluate(
        'JSON.stringify({type: typeof window.pdfjsLib, version: (window.pdfjsLib && window.pdfjsLib.version) || null})',
      ).catch(() => null);
      if (raw) {
        pdfInfo = JSON.parse(raw);
        if (pdfInfo.type !== 'undefined') break;
      }
      await sleep(400);
    }
    report.facts.pdf = { opened: pdfOpened, pdfjsLib: pdfInfo };
    record(
      '6.pdfjs-lazy-load',
      pdfInfo.type !== 'undefined',
      pdfInfo.type !== 'undefined'
        ? `window.pdfjsLib is ${pdfInfo.type} v${pdfInfo.version} after opening ${pdfRel} ` +
          `(view=${JSON.stringify(pdfOpened.view ?? pdfOpened.why)})`
        : `window.pdfjsLib is undefined after opening ${pdfRel}; leaf=${JSON.stringify(pdfOpened)}`,
    );

    // -------------------------------------------- 8. the note really renders
    //
    // This is the check whose absence produced two rounds of "0 requests to
    // /v/*": rendering a vault note is what makes the renderer call
    // getResourcePath() and load the attachment. `app.renderMarkdown` no
    // longer exists in 1.14.4, so the note is opened in a real preview leaf.
    const renderReport = await evaluate(`(async () => {
      const dirs = ${JSON.stringify(ASSET_DIRS)};
      const out = [];

      await new Promise((resolve) => {
        if (app.workspace.layoutReady) return resolve();
        app.workspace.onLayoutReady(() => resolve());
        setTimeout(resolve, 15000);
      });

      for (const dir of dirs) {
        const rel = dir + '/note-with-attachments.md';
        const file = app.vault.getAbstractFileByPath(rel);
        if (!file) { out.push({ rel, error: 'not in the vault tree' }); continue; }
        const entry = { rel, images: [], media: [] };
        try {
          const leaf = app.workspace.getLeaf(true);
          await leaf.openFile(file, { state: { mode: 'preview' } });
          entry.view = leaf.view.getViewType();
          entry.mode = (leaf.view.getState() || {}).mode;
          const el = leaf.view.containerEl;
          // Poll until every /v/ image has settled (loaded or errored).
          const deadline = Date.now() + 20000;
          while (Date.now() < deadline) {
            const pending = Array.from(el.querySelectorAll('img')).filter(
              (i) => (i.currentSrc || i.src || '').includes('/v/') && !i.complete,
            );
            if (pending.length === 0) break;
            await new Promise((r) => setTimeout(r, 400));
          }
          entry.images = Array.from(el.querySelectorAll('img')).map((i) => ({
            src: i.getAttribute('src'),
            resolved: i.currentSrc || i.src || null,
            naturalWidth: i.naturalWidth,
            complete: i.complete,
          }));
          entry.media = Array.from(el.querySelectorAll('audio, video, embed, iframe')).map((m) => ({
            tag: m.tagName,
            src: m.getAttribute('src'),
            resolved: m.currentSrc || m.src || null,
          }));
        } catch (err) {
          entry.error = 'openFile threw: ' + String(err && err.message || err);
        }
        out.push(entry);
      }
      return out;
    })()`).catch((err) => [{ error: String(err.message ?? err) }]);

    report.facts.renderedNotes = renderReport;
    const renderEntries = Array.isArray(renderReport) ? renderReport : [];
    const vImages = renderEntries.flatMap((e) =>
      (e.images ?? []).filter((i) => (i.resolved ?? '').includes('/v/')),
    );
    const loadedV = vImages.filter((i) => i.naturalWidth > 0);
    const perNote = renderEntries.map(
      (e) =>
        `${e.rel}: ${(e.images ?? []).filter((i) => (i.resolved ?? '').includes('/v/')).length} /v/ imgs, ` +
        `${(e.images ?? []).filter((i) => (i.resolved ?? '').includes('/v/') && i.naturalWidth > 0).length} decoded, ` +
        `${(e.media ?? []).filter((m) => (m.resolved ?? '').includes('/v/')).length} media`,
    );
    const renderFailure =
      renderEntries.find((e) => e.error) ??
      (renderEntries.length !== ASSET_DIRS.length
        ? { rel: 'all', error: `expected ${ASSET_DIRS.length} notes, got ${renderEntries.length}` }
        : null) ??
      // Two decodable images per note: "![[pixel.png]]" and "![pixel](pixel.png)".
      (loadedV.length < renderEntries.length * 2
        ? {
            rel: 'all',
            error: `only ${loadedV.length} /v/ images decoded, expected at least ${renderEntries.length * 2} (${perNote.join(' | ')})`,
          }
        : null) ??
      (vImages.length !== loadedV.length
        ? { rel: 'all', error: `${vImages.length - loadedV.length} /v/ images failed to decode (${perNote.join(' | ')})` }
        : null);
    record(
      '8.note-renders-attachments',
      renderFailure === null,
      renderFailure === null
        ? `${renderEntries.length} notes rendered in preview mode; ${loadedV.length} /v/ images decoded (${perNote.join(' | ')})`
        : `${renderFailure.rel}: ${renderFailure.error}`,
    );

    // ------------------------------------------------------ 7. no /v/ errors
    await sleep(1500);
    const seen = report.network.vRequests;
    const cdpFailures = report.network.failures;

    // Cross-check against the server's own log. pino writes two lines per
    // request: "incoming request" carries the URL, "request completed" carries
    // only the reqId and the status, so they have to be joined on reqId.
    // reqId is base-36 (req-1, ..., req-a, req-g11), so it is not numeric.
    const serverLog = server.logs.join('');
    const logUrls = new Map();
    for (const m of serverLog.matchAll(/"reqId":"(req-[0-9a-z]+)","req":\{[^}]*?"url":"([^"]*)"/g)) {
      logUrls.set(m[1], m[2]);
    }
    const logStatus = new Map();
    for (const m of serverLog.matchAll(/"reqId":"(req-[0-9a-z]+)","res":\{"statusCode":(\d+)/g)) {
      logStatus.set(m[1], Number(m[2]));
    }
    const logged = [...logUrls].map(([reqId, url]) => ({ url, status: logStatus.get(reqId) ?? null }));
    const loggedV = logged.filter((r) => r.url.startsWith('/v/'));
    const loggedFailures = loggedV.filter((r) => r.status === null || r.status >= 400);
    const loggedMisprefixed = logged.filter(
      (r) => r.url.startsWith('/obsidian') && r.url[9] !== '/',
    );
    const misprefixed = report.network.misprefixed;

    report.facts.vRequests = {
      seenByCdp: seen.length,
      duringBoot: report.network.bootPhase.length,
      statuses: seen.map((r) => r.status),
      loggedByServer: loggedV.length,
      loggedStatuses: loggedV.map((r) => r.status),
      urls: seen.map((r) => r.url),
    };
    report.facts.misprefixedRequests = misprefixed;
    report.facts.loggedMisprefixed = loggedMisprefixed;
    report.network.failures = cdpFailures;

    const noErrors = cdpFailures.length === 0 && loggedFailures.length === 0;
    record(
      '7.no-v-errors',
      noErrors,
      noErrors
        ? `${seen.length} /v/ requests (${report.network.bootPhase.length} during boot), all < 400; ` +
          `server log agrees on ${loggedV.length} of them` +
          (misprefixed.length > 0 || loggedMisprefixed.length > 0
            ? `; separately, ${misprefixed.length} attachment request(s) were sent to "obsidian<abs path>" ` +
              `(HTTP ${misprefixed[0]?.status}; server log: ${loggedMisprefixed.length}) because of the prefix bug in check 1`
            : '')
        : `${cdpFailures.length} CDP failures ${JSON.stringify(cdpFailures.slice(0, 3))}; ` +
          `${loggedFailures.length} server-log 4xx/5xx ${JSON.stringify(loggedFailures.slice(0, 3))}`,
    );
  } finally {
    cdp.close();
    await stopChild(chrome.child);
    await stopChild(server.child);
    if (args.log) {
      fs.writeFileSync(args.log, server.logs.join(''));
      console.log(`[trace] server log written to ${args.log}`);
    }
  }

  const failed = Object.entries(report.checks).filter(([, v]) => !v.ok);
  const passed = failed.length === 0;
  report.passed = passed;

  console.log('');
  console.log(
    passed
      ? `attachment-check: all ${Object.keys(report.checks).length} checks passed`
      : `attachment-check: ${failed.length} of ${Object.keys(report.checks).length} checks failed`,
  );
  if (!passed) {
    console.log('--- diagnostics ---');
    for (const d of report.diagnostics) console.log(`  ${d}`);
  }
  if (report.console.errors.length) {
    console.log('--- console errors (first 5) ---');
    for (const e of report.console.errors.slice(0, 5)) console.log(`  ${e}`);
  }
  if (report.console.exceptions.length) {
    console.log('--- uncaught exceptions (first 5) ---');
    for (const e of report.console.exceptions.slice(0, 5)) console.log(`  ${e}`);
  }

  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
    console.log(`[trace] report written to ${args.json}`);
  }
  console.log(JSON.stringify(report, null, 2));

  process.exitCode = passed ? 0 : 1;
}

main().catch((err) => {
  console.error('attachment-check failed:', err?.stack ?? err);
  process.exitCode = 2;
});
