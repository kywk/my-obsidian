#!/usr/bin/env node
/** First-visit trust acceptance: no stored decision, modal click, or renderer patch. */
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, assertNotLiveVault, launchChrome, readTermsFromVendor, startServer,
  newPage, evalInPage, waitForPage } from './lib/cdp.mjs';

const args = { port: 4501, timeout: 90 };
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, '');
  if (['vault', 'json', 'port', 'timeout'].includes(key)) args[key] = process.argv[++i];
}
args.port = Number(args.port);
if (!Number.isInteger(args.port) || args.port < 1 || args.port > 64535 || !Number.isFinite(Number(args.timeout)) || Number(args.timeout) <= 0) {
  throw new Error('--port must be 1..64535 and --timeout must be positive seconds');
}
if (!args.vault) throw new Error('--vault <copy> is required');
args.vault = assertNotLiveVault(args.vault);
if (args.json) args.json = assertNotLiveVault(args.json);
const id = 'myobs-auto-trust-probe', disabledId = 'myobs-disabled-trust-probe';
for (const pluginId of [id, disabledId]) {
  const dir = path.join(args.vault, '.obsidian', 'plugins', pluginId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id: pluginId, name: 'Auto trust probe', version: '1.0.0', minAppVersion: '1.0.0',
    author: 'my-obsidian', isDesktopOnly: false,
  }));
  fs.writeFileSync(path.join(dir, 'main.js'), `const { Plugin } = require('obsidian');
module.exports = class extends Plugin {
  onload() { window[${JSON.stringify(pluginId)}] = (window[${JSON.stringify(pluginId)}] || 0) + 1; }
};\n`);
}
const listPath = path.join(args.vault, '.obsidian', 'community-plugins.json');
const enabledIds = [id];
fs.writeFileSync(listPath, JSON.stringify(enabledIds));
const report = { vault: args.vault, criteria: {}, facts: { enabledIdsBefore: enabledIds } };
let server, chrome, cdp;
try {
  server = await startServer(args.vault, args.port, readTermsFromVendor());
  chrome = await launchChrome(args.port + 1000);
  cdp = new Cdp(chrome.wsUrl); await cdp.connect();
  const { sessionId } = await newPage(cdp);
  const evaluate = expression => evalInPage(cdp, sessionId, expression);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__myobsTrustInitialCount = Object.keys(localStorage).filter(key => key.startsWith('enable-plugin-')).length;
    window.__myobsTrustModalSeen = false;
    window.__myobsTrustObserver = new MutationObserver(() => {
      if ([...document.querySelectorAll('.modal-container')].some(el => /Trust author and enable plugins|Do you trust the author of this vault/.test(el.textContent))) {
        window.__myobsTrustModalSeen = true;
      }
    });
    window.__myobsTrustObserver.observe(document, { childList: true, subtree: true });
  ` }, sessionId);
  const boot = async previous => {
    const expression = `!!window.app && !!app.plugins && app.workspace.layoutReady &&
      !!window.__MYOBS && window.__MYOBS.sessionToken !== ${JSON.stringify(previous)}`;
    if (!await waitForPage(cdp, sessionId, expression, Number(args.timeout) * 1000)) {
      throw new Error('renderer did not finish booting');
    }
    return evaluate(`({
      appId: app.appId, vaultId: window.__MYOBS.vaultId,
      initialTrustCount: window.__myobsTrustInitialCount,
      keyValue: localStorage.getItem('enable-plugin-' + app.appId),
      modalSeen: window.__myobsTrustModalSeen,
      modalPresent: [...document.querySelectorAll('.modal-container')].some(el => /Trust author and enable plugins|Do you trust the author of this vault/.test(el.textContent)),
      probeLoads: window[${JSON.stringify(id)}] || 0,
      disabledLoads: window[${JSON.stringify(disabledId)}] || 0,
      fatalVisible: (() => { const el = document.getElementById('myobs-fatal'); return !!el && !el.hidden && getComputedStyle(el).display !== 'none'; })()
    })`);
  };
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${args.port}/` }, sessionId);
  const first = report.facts.firstBoot = await boot(null);
  report.criteria.freshOriginHadNoTrust = first.initialTrustCount === 0;
  report.criteria.trustedPluginsLoadOnFirstBoot = first.keyValue === 'true' && first.appId === first.vaultId && first.probeLoads === 1;
  const previous = await evaluate('window.__MYOBS.sessionToken');
  await evaluate('localStorage.setItem("enable-plugin-" + app.appId, "false")');
  await cdp.send('Page.reload', {}, sessionId);
  const second = report.facts.secondBoot = await boot(previous);
  report.criteria.startupRestoresTrustAfterRestrictedSetting = second.keyValue === 'true' && second.probeLoads === 1;
  report.criteria.trustPromptNeverAppears = !first.modalSeen && !first.modalPresent && !second.modalSeen && !second.modalPresent;
  const enabledIdsAfter = report.facts.enabledIdsAfter = JSON.parse(fs.readFileSync(listPath, 'utf8'));
  report.criteria.disabledPluginListPreserved = first.disabledLoads === 0 && second.disabledLoads === 0 &&
    Array.isArray(enabledIdsAfter) && enabledIdsAfter.length === enabledIds.length &&
    enabledIdsAfter.every((value, index) => value === enabledIds[index]);
  report.criteria.noFatalOverlay = !first.fatalVisible && !second.fatalVisible;
} catch (error) {
  report.error = error.stack || String(error);
} finally {
  cdp?.close(); chrome?.child.kill(); server?.child.kill();
}
report.passed = !report.error && Object.keys(report.criteria).length === 6 && Object.values(report.criteria).every(Boolean);
if (args.json) fs.writeFileSync(args.json, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
