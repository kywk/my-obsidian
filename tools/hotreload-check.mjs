#!/usr/bin/env node
/**
 * Hot reload acceptance harness: zero dependencies.
 *
 * Drives the locally installed Chrome over CDP (via tools/lib/cdp.mjs) and
 * verifies the external-change path of docs/DESIGN.md §4 and the WS contract in
 * docs/CONTRACTS.md §4:
 *
 *   1. /api/watch WebSocket is connected (__MYOBS_WATCH.state.connected).
 *   2. An external note edit on disk reaches app.vault.read() within 5 s.
 *   3. Rewriting a plugin's main.js on disk unloads + reloads it within 10 s.
 *   4. A write made from the browser is echo-filtered and does NOT reload the
 *      plugin (state.filtered grows, the load counter does not).
 *
 * The vault must be a *copy* of the real vault: this script installs a fixture
 * plugin into it. The live vault is refused explicitly.
 *
 * Usage:
 *   node tools/hotreload-check.mjs --vault <dir> [--url ...] [--port 3412]
 *                                  [--timeout 90] [--json <out.json>] [--log <file>]
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  Cdp,
  REPO_ROOT,
  launchChrome,
  readTermsFromVendor,
  sleep,
  startServer,
} from './lib/cdp.mjs';

const PROBE_ID = 'myobs-hotreload-probe';
const FIXTURE_DIR = path.join(REPO_ROOT, 'tools', 'fixtures', 'hotreload-probe');
const PROBE_REL = `.obsidian/plugins/${PROBE_ID}/main.js`;
const LIVE_VAULT = '/Users/kywk/kywk/obsidian';

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = { url: null, vault: null, timeout: 90, json: null, port: 3412, log: null };
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

// ------------------------------------------------------------------ fixture

/**
 * Refuse the live vault before anything writes. The copy lives elsewhere (for
 * example under the session temp dir); a mistyped --vault must not install a
 * test plugin into 5,000 real notes.
 *
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
 * Install the probe plugin and make sure the vault's community-plugins.json
 * lists it, so Obsidian loads it during boot.
 *
 * @param {string} vault
 * @returns {string} absolute probe directory
 */
function installProbePlugin(vault) {
  const dir = path.join(vault, '.obsidian', 'plugins', PROBE_ID);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['manifest.json', 'main.js']) {
    fs.copyFileSync(path.join(FIXTURE_DIR, name), path.join(dir, name));
  }

  const listPath = path.join(vault, '.obsidian', 'community-plugins.json');
  let list = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(listPath, 'utf8'));
    if (Array.isArray(parsed)) list = parsed;
  } catch {
    // Missing or malformed: start from an empty list.
  }
  if (!list.includes(PROBE_ID)) {
    // First, not last: Obsidian loads enabled plugins sequentially, and this
    // harness should not depend on the other 15 plugins finishing.
    list.unshift(PROBE_ID);
    fs.writeFileSync(listPath, `${JSON.stringify(list, null, 2)}\n`);
  }
  return dir;
}

/**
 * NOTE: no policy patch here any more.
 *
 * This harness used to monkey-patch `__MYOBS.policy.plugins = true` through an
 * accessor on `window.__MYOBS`, because CONTRACTS.md §1 injected `policy: {}`
 * and app.js freezes that object at boot
 * (`Hx = Object.freeze(ipcRenderer.sendSync("policy"))`) and then gates every
 * `PluginManager.enablePlugin()` behind `policyAllows(policy.plugins, id)`.
 * An empty policy makes every community plugin fail to load silently.
 *
 * That was a real product bug, not a test artefact, and it is fixed in the
 * server (`DEFAULT_POLICY` in packages/server/src/index.js). The patch is gone
 * on purpose: if the server regresses, the probe plugin stops loading and the
 * pluginHotReload criterion fails.
 */

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
  const probeDir = installProbePlugin(args.vault);
  const server = await startServer(args.vault, args.port, terms);
  const url = args.url ?? `http://127.0.0.1:${args.port}/`;

  const report = {
    url,
    vault: args.vault,
    criteria: {},
    facts: {},
    console: { errors: [], exceptions: [] },
  };

  const chrome = await launchChrome(args.port + 1000);
  const cdp = new Cdp(chrome.wsUrl);

  try {
    await cdp.connect();
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    cdp.on((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args ?? [])
          .map((a) => a.value ?? a.description ?? a.type)
          .join(' ');
        if (msg.params.type === 'error') report.console.errors.push(text);
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

    const evaluate = async (expression, awaitPromise = true) => {
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
    };

    const waitFor = async (expression, timeoutMs, label) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await evaluate(expression).catch(() => undefined);
        if (value) return value;
        await sleep(200);
      }
      report.facts[`timeout:${label}`] = true;
      return undefined;
    };

    const waitForApp = async () => {
      const deadline = Date.now() + args.timeout * 1000;
      while (Date.now() < deadline) {
        const ready = await evaluate(
          'typeof window.app !== "undefined" && !!window.app',
        ).catch(() => false);
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

    const snapshotState = async () =>
      evaluate('JSON.stringify(window.__MYOBS_WATCH.state)')
        .then((v) => JSON.parse(v))
        .catch(() => ({}));

    // ---------------------------------------------------------------- boot
    await cdp.send('Page.navigate', { url }, sessionId);
    await waitForApp();

    /*
     * Community plugins only load when localStorage carries
     * "enable-plugin-<appId>": "true" (restricted mode). A fresh Chrome profile
     * has no such key, so persist it and reload the page: the second boot is the
     * real production path -- PluginManager.initialize() reads the flag and loads
     * every enabled plugin. (Calling app.plugins.setEnable(true) directly races
     * that boot pass and can load a plugin twice; the reload also proves the
     * plugin set survives a normal boot.)
     */
    const appId = await evaluate('window.app.appId');
    report.facts.appId = appId;
    const tokenBefore = await evaluate('String(window.__MYOBS.sessionToken || "")');
    await evaluate(
      `localStorage.setItem(${JSON.stringify(`enable-plugin-${appId}`)}, "true"); "ok"`,
    );

    await cdp.send('Page.navigate', { url }, sessionId);
    const reloaded = await waitFor(
      `!!window.app && String(window.__MYOBS.sessionToken || "") !== ${JSON.stringify(tokenBefore)}`,
      args.timeout * 1000,
      'documentReload',
    );
    report.facts.documentReloaded = reloaded === true;

    /*
     * The vault scan fills in asynchronously; app.vault.getMarkdownFiles() is
     * empty until it finishes, and the note assertions need a real file.
     */
    await waitFor(
      'app.vault.getFiles().length > 0',
      args.timeout * 1000,
      'vaultScanned',
    );
    await sleep(500);

    // 1. /api/watch WS connected -------------------------------------------
    const connected = await waitFor(
      '!!(window.__MYOBS_WATCH && window.__MYOBS_WATCH.state && window.__MYOBS_WATCH.state.connected === true)',
      15000,
      'watchConnected',
    );
    report.criteria.watchConnected = connected === true;
    report.facts.subscribed =
      (await evaluate('!!(window.__MYOBS_PLUGIN_WATCH && window.__MYOBS_PLUGIN_WATCH.subscribed)').catch(
        () => null,
      )) ?? null;

    // 2. external note change ----------------------------------------------
    const notePath = await evaluate(`(function () {
      const files = app.vault.getMarkdownFiles();
      const target = files.find((f) => f.path === 'AGENTS.md') || files[0];
      return target ? target.path : null;
    })()`);
    report.facts.notePath = notePath;

    const fileOnDisk = notePath
      ? path.join(args.vault, ...notePath.split('/'))
      : null;
    const noteOriginal = fileOnDisk ? fs.readFileSync(fileOnDisk, 'utf8') : null;

    const stateBefore = await snapshotState();
    const mtimeBefore = notePath
      ? await evaluate(
          `(function(){var f=app.vault.getAbstractFileByPath(${JSON.stringify(notePath)});return f&&f.stat?f.stat.mtime:null;})()`,
        ).catch(() => null)
      : null;

    const readExpression = `(async function () {
      const f = app.vault.getAbstractFileByPath(${JSON.stringify(notePath)});
      if (!f) return null;
      return await app.vault.read(f);
    })()`;

    let sawExternalContent = false;
    const noteTimeline = [];
    if (notePath && noteOriginal !== null) {
      const marker = `<!-- myobs-hotreload ${Date.now()} -->`;
      const writeAt = Date.now();
      fs.writeFileSync(fileOnDisk, `${noteOriginal}\n\n${marker}\n`);

      // Poll until Obsidian reports the change through the watcher, not just
      // until the file reads back (adapter reads always hit disk, so content
      // alone does not prove the WS event arrived).
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const text = await evaluate(readExpression).catch(() => null);
        if (typeof text === 'string' && text.includes(marker)) sawExternalContent = true;
        const state = await snapshotState();
        noteTimeline.push({
          t: Date.now() - writeAt,
          received: state.received,
          dispatched: state.dispatched,
          connected: state.connected,
        });
        if (state.dispatched > stateBefore.dispatched) break;
        await sleep(200);
      }
    }

    const mtimeAfter = notePath
      ? await evaluate(
          `(function(){var f=app.vault.getAbstractFileByPath(${JSON.stringify(notePath)});return f&&f.stat?f.stat.mtime:null;})()`,
        ).catch(() => null)
      : null;
    const stateAfterNote = await snapshotState();

    report.criteria.noteExternalChange =
      sawExternalContent && stateAfterNote.dispatched > stateBefore.dispatched;
    report.facts.noteExternalChange = {
      sawExternalContent,
      received: { before: stateBefore.received, after: stateAfterNote.received },
      filtered: { before: stateBefore.filtered, after: stateAfterNote.filtered },
      dispatched: {
        before: stateBefore.dispatched,
        after: stateAfterNote.dispatched,
      },
      mtime: { before: mtimeBefore, after: mtimeAfter },
      timeline: noteTimeline.slice(0, 20),
    };

    // Restore the note so later assertions see a clean vault.
    if (fileOnDisk && noteOriginal !== null) {
      fs.writeFileSync(fileOnDisk, noteOriginal);
      await sleep(800);
    }

    // 3. plugin hot reload --------------------------------------------------
    const firstLoad = await waitFor(
      'window.__myobsProbeLoads',
      20000,
      'probeFirstLoad',
    );
    report.facts.probeLoadsInitial = firstLoad ?? null;

    const beforeReload = await evaluate(
      'JSON.stringify({loads: window.__myobsProbeLoads||0, unloads: window.__myobsProbeUnloads||0, state: window.__MYOBS_WATCH.state})',
    )
      .then((v) => JSON.parse(v))
      .catch(() => ({}));

    let hotReloaded = false;
    if (firstLoad === 1) {
      const probeMain = path.join(probeDir, 'main.js');
      const current = fs.readFileSync(probeMain, 'utf8');
      fs.writeFileSync(probeMain, `${current}\n// external touch ${Date.now()}\n`);
      hotReloaded = (await waitFor('window.__myobsProbeLoads === 2', 10000, 'probeReload')) === true;
    }

    const afterReload = await evaluate(
      'JSON.stringify({loads: window.__myobsProbeLoads||0, unloads: window.__myobsProbeUnloads||0, state: window.__MYOBS_WATCH.state})',
    )
      .then((v) => JSON.parse(v))
      .catch(() => ({}));

    report.criteria.pluginHotReload = hotReloaded && afterReload.loads === 2;
    report.facts.pluginHotReload = { before: beforeReload, after: afterReload };

    // 4. echo filtering -----------------------------------------------------
    const filteredBefore = await evaluate('window.__MYOBS_WATCH.state.filtered');
    const loadsBeforeEcho = await evaluate('window.__myobsProbeLoads || 0');

    // (a) app.vault.modify() -> fs-shim stamps the token -> whole batch filtered.
    const modifiedNote = notePath
      ? await evaluate(`(async function () {
          const f = app.vault.getAbstractFileByPath(${JSON.stringify(notePath)});
          if (!f) return false;
          const original = await app.vault.read(f);
          await app.vault.modify(f, original + '\\n\\n<!-- echo probe ' + Date.now() + ' -->\\n');
          await new Promise((r) => setTimeout(r, 200));
          await app.vault.modify(f, original);
          return true;
        })()`)
      : false;
    await sleep(2500);
    const filteredAfterNote = await evaluate('window.__MYOBS_WATCH.state.filtered');

    // (b) rewriting the plugin's own main.js from the browser must NOT reload
    // it. Without echo filtering this is exactly the reload loop.
    const browserWroteProbe = await evaluate(`(async function () {
      const rel = ${JSON.stringify(PROBE_REL)};
      const current = await app.vault.adapter.read(rel);
      await app.vault.adapter.write(rel, current);
      return current.length;
    })()`).catch((err) => `error: ${err.message}`);
    await sleep(2500);
    const filteredAfterProbe = await evaluate('window.__MYOBS_WATCH.state.filtered');
    const loadsAfterEcho = await evaluate('window.__myobsProbeLoads || 0');

    report.criteria.echoFiltered =
      modifiedNote === true &&
      filteredAfterNote > filteredBefore &&
      filteredAfterProbe > filteredAfterNote &&
      loadsAfterEcho === loadsBeforeEcho;
    report.facts.echoFiltered = {
      modifiedNote,
      browserWroteProbe,
      filtered: { before: filteredBefore, afterNote: filteredAfterNote, afterProbe: filteredAfterProbe },
      loads: { before: loadsBeforeEcho, after: loadsAfterEcho },
    };

    // Diagnostics -----------------------------------------------------------
    report.diagnostics = {
      watchState: await evaluate('JSON.stringify(window.__MYOBS_WATCH.state)').catch(() => null),
      pluginWatch: await evaluate(
        'JSON.stringify({enabled: window.__MYOBS_PLUGIN_WATCH.enabled, subscribed: window.__MYOBS_PLUGIN_WATCH.subscribed, events: (window.__MYOBS_PLUGIN_WATCH.events||[]).slice(-12)})',
      ).catch(() => null),
      probe: await evaluate(
        'JSON.stringify({loads: window.__myobsProbeLoads||0, unloads: window.__myobsProbeUnloads||0})',
      ).catch(() => null),
      enabledPlugins: await evaluate(
        'JSON.stringify(Array.from((app.plugins && app.plugins.enabledPlugins) || []))',
      ).catch(() => null),
      loadedPlugins: await evaluate(
        'JSON.stringify(Object.keys((app.plugins && app.plugins.plugins) || {}))',
      ).catch(() => null),
      manifestIds: await evaluate(
        'JSON.stringify(Object.keys((app.plugins && app.plugins.manifests) || {}))',
      ).catch(() => null),
      communityEnabled: await evaluate(
        'String(!!(app.plugins && typeof app.plugins.isEnabled === "function" && app.plugins.isEnabled()))',
      ).catch(() => null),
      sessionToken: await evaluate('String(window.__MYOBS.sessionToken||"")').catch(() => null),
    };
    report.facts.origin = await evaluate(
      'String(location.origin)',
    ).catch(() => null);
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

  process.exitCode = passed ? 0 : 1;
}

main().catch((err) => {
  console.error('hotreload-check failed:', err.message);
  process.exitCode = 2;
});
