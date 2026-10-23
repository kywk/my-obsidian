#!/usr/bin/env node
/** Audit the existing enabled plugins in a vault copy through the real renderer. */
import fs from 'node:fs';
import path from 'node:path';
import {
  Cdp, assertNotLiveVault, evalInPage, launchChrome, newPage,
  readTermsFromVendor, startServer, waitForPage,
} from './lib/cdp.mjs';

function parseArgs(argv) {
  const args = { vault: null, port: 3401, timeout: 150, json: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!Object.hasOwn(args, key) || !argv[i].startsWith('--') || argv[i + 1] === undefined) {
      throw new Error('Usage: node tools/plugin-audit.mjs --vault <copy> [--port 3401] [--timeout 150] [--json <report.json>]');
    }
    args[key] = ['port', 'timeout'].includes(key) ? Number(argv[++i]) : argv[++i];
  }
  if (!args.vault || !Number.isInteger(args.port) || args.port < 1 || args.port > 64535 || !Number.isFinite(args.timeout) || args.timeout <= 0) {
    throw new Error('--vault must name a copy; --port must be 1..64535 and --timeout must be positive seconds');
  }
  args.vault = assertNotLiveVault(args.vault);
  if (!fs.statSync(args.vault).isDirectory()) throw new Error('--vault must be a directory');
  if (args.json) args.json = assertNotLiveVault(args.json);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = path.join(args.vault, '.obsidian', 'community-plugins.json');
  const configured = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : [];
  if (!Array.isArray(configured) || configured.some((id) => typeof id !== 'string')) {
    throw new Error('community-plugins.json must contain an array of plugin IDs');
  }
  let server;
  let chrome;
  let cdp;
  const report = {
    kind: 'plugin-audit',
    capturedAt: new Date().toISOString(),
    vault: args.vault,
    auditComplete: false,
    definitions: {
      loaded: 'enablePlugin completed successfully and an instance remains; plugin features are not exhaustively tested',
      failed: 'enablePlugin was observed to fail, including failures that leave an instance',
      unobserved: 'no enablePlugin outcome was observed; an instance alone is not proof of success',
    },
    plugins: [],
  };
  try {
    server = await startServer(args.vault, args.port, readTermsFromVendor());
    chrome = await launchChrome(args.port + 1000);
    cdp = new Cdp(chrome.wsUrl);
    await cdp.connect();
    const { sessionId } = await newPage(cdp);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    const evaluate = (expression) => evalInPage(cdp, sessionId, expression);
    const waitFor = (expression) => waitForPage(cdp, sessionId, expression, args.timeout * 1000);
    const url = `http://127.0.0.1:${args.port}/`;
    await cdp.send('Page.navigate', { url }, sessionId);
    if (!(await waitFor('!!(window.app && app.plugins)'))) throw new Error('renderer did not expose app.plugins before timeout');
    const appId = await evaluate('app.appId');
    const token = await evaluate('String(window.__MYOBS.sessionToken || "")');
    // A fresh profile starts in restricted mode. Reloading after the flag lets
    // the normal boot load exactly the configured list, once per document.
    await evaluate(`localStorage.setItem(${JSON.stringify(`enable-plugin-${appId}`)}, 'true')`);
    await cdp.send('Page.navigate', { url }, sessionId);
    if (!(await waitFor(`!!window.app && String(window.__MYOBS.sessionToken || '') !== ${JSON.stringify(token)}`))) {
      throw new Error('renderer reload did not complete before timeout');
    }
    const bootScanned = await waitFor("!!window.__MYOBS_PLUGIN_WATCH && __MYOBS_PLUGIN_WATCH.events.some(event => event.action === 'boot-scan')");
    const snapshot = await evaluate(`(() => {
      const manager = app.plugins;
      const watcher = window.__MYOBS_PLUGIN_WATCH;
      return {
        enabled: Array.from(manager.enabledPlugins || []),
        manifests: Object.fromEntries(Object.entries(manager.manifests || {}).map(([id, manifest]) => [id, {version: manifest.version || null}])),
        instances: Object.keys(manager.plugins || {}),
        outcomes: watcher ? watcher.outcomes || {} : {},
        communityEnabled: typeof manager.isEnabled === 'function' ? manager.isEnabled() : null,
        bootScan: watcher ? watcher.events.find(event => event.action === 'boot-scan') || null : null
      };
    })()`);
    const configuredSet = new Set(configured);
    const enabled = new Set(snapshot.enabled);
    const instances = new Set(snapshot.instances);
    report.plugins = [...new Set([...configured, ...snapshot.enabled])].sort().map((id) => {
      const outcome = snapshot.outcomes[id];
      const instancePresent = instances.has(id);
      return {
        id,
        version: snapshot.manifests[id]?.version ?? null,
        configuredEnabled: configuredSet.has(id),
        enabledAtAudit: enabled.has(id),
        instancePresent,
        observedOutcome: outcome ? { ok: outcome.ok, at: outcome.at } : null,
        status: outcome?.ok === false ? 'failed' : outcome?.ok === true && instancePresent ? 'loaded' : 'unobserved',
      };
    });
    report.auditComplete = bootScanned;
    report.communityEnabled = snapshot.communityEnabled;
    report.bootScan = snapshot.bootScan;
    if (!bootScanned) report.error = 'plugin-watch boot-scan did not settle before timeout; unobserved entries are inconclusive';
  } finally {
    cdp?.close();
    chrome?.child.kill();
    server?.child.kill();
  }
  report.summary = { total: report.plugins.length, loaded: 0, failed: 0, unobserved: 0 };
  for (const plugin of report.plugins) report.summary[plugin.status]++;
  const output = JSON.stringify(report, null, 2);
  if (args.json) fs.writeFileSync(args.json, `${output}\n`);
  console.log(output);
  // Plugin failures are audit findings, not an acceptance-test failure.
  if (!report.auditComplete) process.exitCode = 2;
}

main().catch((error) => {
  console.error('plugin-audit failed:', error.message);
  process.exitCode = 2;
});
