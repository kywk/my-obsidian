#!/usr/bin/env node
/** Real renderer regression for version-attributed echoes and plugin saveData reloads. */
import fs from 'node:fs';
import path from 'node:path';
import {
  Cdp, assertNotLiveVault, evalInPage, launchChrome, newPage,
  readTermsFromVendor, sleep, startServer, waitForPage,
} from './lib/cdp.mjs';

const id = 'myobs-origin-echo-probe';
const dataRel = `.obsidian/plugins/${id}/data.json`;
const mainRel = `.obsidian/plugins/${id}/main.js`;
const fixture = `const { Plugin } = require('obsidian');
module.exports = class OriginEchoProbe extends Plugin {
  async onload() {
    const probe = window.__originEchoProbe ||= { loads: 0, unloads: 0, writes: 0, values: [] };
    probe.loads++;
    const data = await this.loadData() || { value: 'initial' };
    this.value = data.value;
    probe.values.push(data.value);
    await this.saveData({ value: data.value, load: probe.loads });
    probe.writes++;
  }
  onunload() { window.__originEchoProbe.unloads++; }
};\n`;

function parseArgs(argv) {
  const args = { vault: null, port: 4202, timeout: 120, json: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !Object.hasOwn(args, key) || argv[i + 1] === undefined) {
      throw new Error('Usage: node tools/origin-echo-check.mjs --vault <copy> [--port 4202] [--timeout 120] [--json <report.json>]');
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
  const pluginDir = path.join(args.vault, '.obsidian', 'plugins', id);
  if (fs.existsSync(pluginDir)) throw new Error('Use a fresh vault copy without the origin echo fixture');
  const listPath = path.join(args.vault, '.obsidian', 'community-plugins.json');
  const listBackup = fs.existsSync(listPath) ? fs.readFileSync(listPath) : null;
  const report = { kind: 'origin-echo-check', vault: args.vault, criteria: {}, facts: {} };
  const wire = [];
  let server, chrome, cdp, sessionToken;
  try {
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({ id, name: 'Origin echo probe', version: '1.0.0', minAppVersion: '1.0.0', description: 'Acceptance fixture', author: 'my-obsidian', isDesktopOnly: false }));
    fs.writeFileSync(path.join(pluginDir, 'main.js'), fixture);
    fs.writeFileSync(listPath, JSON.stringify([id]));
    server = await startServer(args.vault, args.port, readTermsFromVendor());
    chrome = await launchChrome(args.port + 1000);
    cdp = new Cdp(chrome.wsUrl);
    await cdp.connect();
    const { sessionId } = await newPage(cdp);
    cdp.on(message => {
      if (message.sessionId !== sessionId || message.method !== 'Network.webSocketFrameReceived') return;
      try {
        const payload = JSON.parse(message.params.response.payloadData);
        if (payload.type !== 'change') return;
        for (const event of payload.events || []) {
          if (event.path === dataRel || event.path === mainRel) wire.push({ at: Date.now(), path: event.path, kind: event.kind, own: !!sessionToken && event.originToken === sessionToken, tagged: !!event.originToken });
        }
      } catch { /* Non-change frames do not describe filesystem writes. */ }
    });
    for (const domain of ['Runtime', 'Page', 'Network']) await cdp.send(`${domain}.enable`, {}, sessionId);
    const evaluate = expression => evalInPage(cdp, sessionId, expression);
    const wait = (expression, ms = 10000) => waitForPage(cdp, sessionId, expression, ms);
    const state = () => evaluate(`({ ...window.__originEchoProbe, filtered: __MYOBS_WATCH.state.filtered, value: app.plugins.plugins[${JSON.stringify(id)}]?.value })`);
    const untilWire = async (start, predicate) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (wire.slice(start).some(predicate)) return true;
        await sleep(100);
      }
      return false;
    };
    const url = `http://127.0.0.1:${args.port}/`;
    await cdp.send('Page.navigate', { url }, sessionId);
    if (!await wait('!!window.app && !!app.plugins', args.timeout * 1000)) throw new Error('renderer did not boot');
    const oldToken = await evaluate('__MYOBS.sessionToken');
    await evaluate('localStorage.setItem("enable-plugin-" + app.appId, "true")');
    await cdp.send('Page.navigate', { url }, sessionId);
    if (!await wait(`!!window.app && __MYOBS.sessionToken !== ${JSON.stringify(oldToken)} && !!window.__originEchoProbe`, args.timeout * 1000)) throw new Error('plugin did not boot');
    sessionToken = await evaluate('__MYOBS.sessionToken');
    report.criteria.normalBoot = await wait(`__MYOBS_PLUGIN_WATCH.outcomes[${JSON.stringify(id)}]?.ok === true && app.metadataCache.initialized && __MYOBS_WATCH.state.connected`, args.timeout * 1000);
    // A positive own-write frame plus a settle interval distinguishes quiet
    // operation from a watcher that never ran.
    report.criteria.createdDataEchoTagged = await untilWire(0, event => event.path === dataRel && event.own);
    await sleep(2200);
    report.facts.initial = await state();
    report.criteria.onloadWriteDoesNotLoop = report.facts.initial.loads === 1 && report.facts.initial.writes === 1 && report.facts.initial.unloads === 0;

    let start = wire.length;
    await evaluate(`app.plugins.plugins[${JSON.stringify(id)}].saveData({ value:'browser-one', load:1 })`);
    const firstEcho = await untilWire(start, event => event.path === dataRel && event.own);
    start = wire.length;
    await evaluate(`app.plugins.plugins[${JSON.stringify(id)}].saveData({ value:'browser-two', load:1 })`);
    const secondEcho = await untilWire(start, event => event.path === dataRel && event.own);
    await sleep(1700);
    report.facts.separateWrites = await state();
    report.criteria.separateBatchEchoesFiltered = firstEcho && secondEcho && report.facts.separateWrites.loads === 1;

    start = wire.length;
    const externalAt = Date.now();
    fs.writeFileSync(path.join(args.vault, dataRel), JSON.stringify({ value: 'external-one', load: 1 }));
    report.criteria.externalDataReloadsWithinTtl = await wait(`__originEchoProbe.loads === 2 && __originEchoProbe.writes === 2 && app.plugins.plugins[${JSON.stringify(id)}]?.value === 'external-one'`) && Date.now() - externalAt < 10000;
    report.facts.externalLatencyMs = Date.now() - externalAt;
    report.criteria.externalDataIsNotTaggedAsOwn = await untilWire(start, event => event.path === dataRel && !event.tagged);
    report.criteria.reloadWriteEchoTagged = await untilWire(start, event => event.path === dataRel && event.own);
    await sleep(2200);
    report.facts.afterExternal = await state();
    report.criteria.reloadWritesConverge = report.facts.afterExternal.loads === 2 && report.facts.afterExternal.writes === 2 && report.facts.afterExternal.unloads === 1;

    fs.writeFileSync(path.join(args.vault, dataRel), JSON.stringify({ value: 'external-two', load: 2 }));
    report.criteria.externalAfterRenewedTokenReloads = await wait(`__originEchoProbe.loads === 3 && __originEchoProbe.writes === 3 && app.plugins.plugins[${JSON.stringify(id)}]?.value === 'external-two'`);
    await sleep(1700);
    start = wire.length;
    await evaluate(`app.vault.adapter.write(${JSON.stringify(mainRel)}, ${JSON.stringify(fixture)})`);
    const mainEcho = await untilWire(start, event => event.path === mainRel && event.own);
    await sleep(1700);
    report.criteria.browserMainWriteDoesNotReload = mainEcho && (await state()).loads === 3;
    fs.appendFileSync(path.join(args.vault, mainRel), '\n// External main update\n');
    report.criteria.externalMainAfterBrowserWriteReloads = await wait(`__originEchoProbe.loads === 4 && __originEchoProbe.writes === 4`);
    await sleep(2200);
    report.facts.final = await state();
    report.facts.diskData = JSON.parse(fs.readFileSync(path.join(args.vault, dataRel), 'utf8'));
    report.criteria.finalWriteAndReloadCountsBounded = report.facts.final.loads === 4 && report.facts.final.writes === 4 && report.facts.final.unloads === 3 && report.facts.diskData.value === 'external-two' && report.facts.diskData.load === 4;
    report.criteria.noFatalOverlay = await evaluate(`document.getElementById('myobs-fatal').hidden`);
  } catch (error) {
    report.facts.error = error.message;
    report.criteria.executionCompleted = false;
  } finally {
    report.facts.wire = wire;
    cdp?.close();
    chrome?.child.kill();
    if (server?.child && server.child.exitCode === null) await new Promise(resolve => { server.child.once('exit', resolve); server.child.kill(); });
    if (listBackup === null) fs.rmSync(listPath, { force: true });
    else fs.writeFileSync(listPath, listBackup);
  }
  report.passed = Object.keys(report.criteria).length === 13 && Object.values(report.criteria).every(Boolean);
  const output = JSON.stringify(report, null, 2);
  if (args.json) fs.writeFileSync(args.json, output + '\n');
  console.log(output);
  if (!report.passed) process.exitCode = 1;
}
main().catch(error => { console.error('origin-echo-check failed:', error.message); process.exitCode = 2; });
