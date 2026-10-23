#!/usr/bin/env node
/** Real renderer lifecycle acceptance; installs fixtures only into a guarded vault copy. */
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, assertNotLiveVault, launchChrome, readTermsFromVendor, startServer,
  newPage, evalInPage, waitForPage, sleep } from './lib/cdp.mjs';

const args = { port: 3312, timeout: 90 };
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
const id = 'myobs-plugin-support-probe';
const dir = path.join(args.vault, '.obsidian', 'plugins', id);
const mainPath = path.join(dir, 'main.js');
const listPath = path.join(args.vault, '.obsidian', 'community-plugins.json');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: 'Plugin support probe', version: '1.0.0', minAppVersion: '1.0.0', author: 'my-obsidian', isDesktopOnly: false }));
fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ value: 'persisted fixture' }));
let enabled = [];
try { enabled = JSON.parse(fs.readFileSync(listPath, 'utf8')); } catch {}
fs.writeFileSync(listPath, JSON.stringify([id, ...enabled.filter(value => value !== id)]));

function source(generation, fail = false, delay = 0) {
  return `const { Plugin } = require('obsidian');
module.exports = class extends Plugin {
  async onload() {
    const state = window.__myobsSupport || (window.__myobsSupport = { loads: 0, unloads: 0, active: 0, maximum: 0, flags: [], completed: [] });
    state.loads++; state.maximum = Math.max(state.maximum, ++state.active); state.loading = ${generation};
    this.addCommand({ id: 'probe', name: 'Probe', callback() {} });
    try {
      await new Promise(resolve => setTimeout(resolve, ${delay}));
      if (${fail}) throw new Error('intentional onload failure ${generation}');
      const fsp = require('node:fs/promises');
      const { EventEmitter } = require('node:events');
      const { Buffer } = require('node:buffer');
      const full = require('node:path').join(this.app.vault.adapter.getBasePath(), this.manifest.dir, 'data.json');
      const emitter = new EventEmitter(); let seen = '';
      emitter.once('probe', value => { seen = value; }); emitter.emit('probe', 'event ok');
      const text = await fsp.readFile(full, 'utf8');
      const bytes = await new Promise((resolve, reject) => require('node:fs').readFile(full, (error, data) => error ? reject(error) : resolve(data)));
      const callbackWorks = Buffer.isBuffer(bytes) && bytes.toString() === text;
      state.modules = callbackWorks && seen === 'event ok' && JSON.parse(text).value === 'persisted fixture' && Buffer.from('probe').toString() === 'probe';
      state.saved = await this.loadData(); state.completed.push(${generation}); this.generation = ${generation};
    } finally { state.active--; state.loading = null; }
  }
  onunload() { window.__myobsSupport.unloads++; window.__myobsSupport.flags.push(this._userDisabled); }
};\n`;
}
fs.writeFileSync(mainPath, source(0, true));
const report = { vault: args.vault, criteria: {}, facts: {} };
let server, chrome, cdp;
try {
  server = await startServer(args.vault, args.port, readTermsFromVendor());
  chrome = await launchChrome(args.port + 1000);
  cdp = new Cdp(chrome.wsUrl); await cdp.connect();
  const { sessionId } = await newPage(cdp);
  const evaluate = expression => evalInPage(cdp, sessionId, expression);
  const wait = async (expression, label, timeout = 20000) => {
    const ok = await waitForPage(cdp, sessionId, expression, timeout);
    if (!ok) report.facts[`timeout:${label}`] = true;
    return ok;
  };
  const url = `http://127.0.0.1:${args.port}/`;
  const reload = async () => {
    const previous = await evaluate('window.__MYOBS && window.__MYOBS.sessionToken').catch(() => null);
    await cdp.send('Page.navigate', { url }, sessionId);
    if (!await wait(`!!window.app && !!window.__MYOBS && window.__MYOBS.sessionToken !== ${JSON.stringify(previous)}`, 'boot', Number(args.timeout) * 1000)) throw new Error('renderer did not boot');
  };
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await reload();
  await evaluate('localStorage.setItem("enable-plugin-" + app.appId, "true")');
  await reload();
  const plugin = `app.plugins.plugins[${JSON.stringify(id)}]`;
  const outcome = `window.__MYOBS_PLUGIN_WATCH.outcomes[${JSON.stringify(id)}]`;
  const notice = `window.__MYOBS_NOTICES.list().find(n => n.dedupeKey === ${JSON.stringify(`plugin:${id}`)})`;
  report.criteria.bootOnloadFailureDetected = await wait(`!!(${plugin}) && !!(${outcome}) && !(${outcome}).ok && !!(${notice})`, 'bootOnloadFailure');
  report.facts.bootFailure = await evaluate(`({ retained: !!(${plugin}), loadedFlag: (${plugin} || {})._loaded, outcome: ${outcome}, notice: ${notice} })`);

  fs.writeFileSync(mainPath, source(1));
  report.criteria.repairRecoversAndClearsNotice = await wait(`(${plugin} || {}).generation === 1 && (${outcome} || {}).ok && !(${notice})`, 'repair');
  report.criteria.nodeModulesInRealPlugin = await evaluate('window.__myobsSupport.modules === true');
  report.criteria.dataPreservedAcrossReload = await evaluate('window.__myobsSupport.saved && window.__myobsSupport.saved.value === "persisted fixture"');

  fs.writeFileSync(mainPath, source(2, false, 1800));
  const loading = await wait('window.__myobsSupport.loading === 2', 'slowReload');
  fs.writeFileSync(mainPath, source(3));
  await sleep(650);
  fs.writeFileSync(mainPath, source(4));
  const latest = await wait(`(${plugin} || {}).generation === 4 && (${outcome} || {}).ok && window.__myobsSupport.active === 0`, 'latestReload');
  report.facts.lifecycle = await evaluate('window.__myobsSupport');
  report.criteria.reloadsNeverOverlap = loading && latest && report.facts.lifecycle.maximum === 1;
  report.criteria.latestRevisionWins = latest;
  report.criteria.hotReloadIsNotUserDisable = report.facts.lifecycle.flags.length > 0 && report.facts.lifecycle.flags.every(value => value === false);

  fs.writeFileSync(mainPath, source(5, true));
  await wait(`!!(${notice}) && (${outcome} || {}).ok === false`, 'secondFailure');
  const clicked = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.myobs-notice')].find(el => el.textContent.includes(${JSON.stringify(id)}));
    const button = card && [...card.querySelectorAll('button')].find(el => el.textContent === '停用此外掛');
    if (!button) return false; button.click(); return true;
  })()`);
  const disabled = await wait(`!app.plugins.enabledPlugins.has(${JSON.stringify(id)}) && !(${plugin})`, 'disabled');
  const deadline = Date.now() + 10000;
  let persisted = false;
  while (Date.now() < deadline) {
    persisted = !JSON.parse(fs.readFileSync(listPath, 'utf8')).includes(id);
    if (persisted) break;
    await sleep(150);
  }
  report.criteria.disableActionPersists = clicked && disabled && persisted;
  await reload();
  await wait('window.__MYOBS_PLUGIN_WATCH.events.some(e => e.action === "boot-scan")', 'finalBoot');
  report.criteria.disabledStaysDisabledAfterBoot = await evaluate(`!app.plugins.enabledPlugins.has(${JSON.stringify(id)}) && !(${plugin}) && !window.__myobsSupport`);
  report.criteria.noFatalOverlay = await evaluate('(() => { const el = document.getElementById("myobs-fatal"); return !el || el.hidden || getComputedStyle(el).display === "none"; })()');
  report.facts.finalEvents = await evaluate('window.__MYOBS_PLUGIN_WATCH.events');
} catch (error) {
  report.error = error.stack || String(error);
} finally {
  cdp?.close(); chrome?.child.kill(); server?.child.kill();
}
report.passed = !report.error && Object.keys(report.criteria).length === 10 && Object.values(report.criteria).every(Boolean);
if (args.json) fs.writeFileSync(args.json, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
