#!/usr/bin/env node
/** Feature acceptance against the installed Tasks plugin and its real query checkboxes. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Cdp, assertNotLiveVault, clickAt, evalInPage, launchChrome, newPage,
  readTermsFromVendor, startServer, waitForPage } from './lib/cdp.mjs';

const args = { vault: null, port: 4001, timeout: 120, json: null };
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, '');
  if (!process.argv[i].startsWith('--') || !Object.hasOwn(args, key) || process.argv[i + 1] === undefined) {
    throw new Error('Usage: node tools/tasks-check.mjs --vault <copy> [--port 4001] [--timeout 120] [--json <report>]');
  }
  args[key] = ['port', 'timeout'].includes(key) ? Number(process.argv[++i]) : process.argv[++i];
}
if (!args.vault || !Number.isInteger(args.port) || args.port < 1 || args.port > 64535 || !Number.isFinite(args.timeout) || args.timeout <= 0) {
  throw new Error('--vault must be a copy; --port must be 1..64535; --timeout must be positive seconds');
}
args.vault = assertNotLiveVault(args.vault);
if (args.json) args.json = assertNotLiveVault(args.json);
const id = 'obsidian-tasks-plugin';
const dir = path.join(args.vault, '.obsidian', 'plugins', id);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
if (manifest.id !== id || manifest.version !== '8.6.0') throw new Error('Install Tasks 8.6.0 in the vault copy before running this version-specific check');
const sources = ['main.js', 'manifest.json', 'styles.css'].filter(name => fs.existsSync(path.join(dir, name)));
const hashes = () => Object.fromEntries(sources.map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')]));
const before = hashes();
const listPath = path.join(args.vault, '.obsidian', 'community-plugins.json');
const dataPath = path.join(dir, 'data.json');
const backups = [listPath, dataPath].map(file => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]);
const fixture = fs.mkdtempSync(path.join(args.vault, '_myobs_tasks_'));
const root = path.basename(fixture);
const sourcePath = root + '/Source.md';
const queryPath = root + '/Query.md';
const original = '# Preserve heading\n\n- [ ] 單次任務 🛫 2026-10-24 📅 2026-10-25\n- [ ] 每日任務 🔁 every day 📅 2026-10-24\n\nPreserve footer\n';
fs.writeFileSync(path.join(fixture, 'Source.md'), original);
fs.writeFileSync(path.join(fixture, 'Other.md'), '- [ ] Excluded task\n');
fs.writeFileSync(path.join(fixture, 'Query.md'), '```tasks\npath includes ' + sourcePath + '\nsort by description\n```\n');
const report = { kind: 'tasks-check', vault: args.vault, version: manifest.version, criteria: {}, facts: {} };
let server, chrome, cdp;
try {
  fs.writeFileSync(listPath, JSON.stringify([id]));
  fs.writeFileSync(dataPath, JSON.stringify({ globalFilter: '', setDoneDate: true }));
  server = await startServer(args.vault, args.port, readTermsFromVendor());
  chrome = await launchChrome(args.port + 1000);
  cdp = new Cdp(chrome.wsUrl); await cdp.connect();
  const { sessionId } = await newPage(cdp);
  const evaluate = expression => evalInPage(cdp, sessionId, expression);
  const wait = expression => waitForPage(cdp, sessionId, expression, args.timeout * 1000);
  const url = `http://127.0.0.1:${args.port}/`;
  await cdp.send('Page.navigate', { url }, sessionId);
  if (!await wait('!!window.app?.plugins')) throw new Error('renderer did not boot');
  await evaluate('localStorage.setItem("enable-plugin-" + app.appId, "true")');
  const reload = async () => {
    const token = await evaluate('window.__MYOBS.sessionToken');
    await cdp.send('Page.navigate', { url }, sessionId);
    if (!await wait(`!!window.app && window.__MYOBS.sessionToken !== ${JSON.stringify(token)} && !!window.__MYOBS_PLUGIN_WATCH?.events.some(e => e.action === 'boot-scan') && app.metadataCache.initialized && app.workspace.layoutReady`)) throw new Error('plugin boot, metadata and layout did not settle');
  };
  await reload();
  report.criteria.normalBootInitializes = await evaluate(`!!app.plugins.plugins[${JSON.stringify(id)}] && __MYOBS_PLUGIN_WATCH.outcomes[${JSON.stringify(id)}]?.ok === true`);
  const readSource = `app.vault.read(app.vault.getAbstractFileByPath(${JSON.stringify(sourcePath)}))`;
  const openQuery = () => evaluate(`app.workspace.getLeaf().openFile(app.vault.getAbstractFileByPath(${JSON.stringify(queryPath)}), {state:{mode:'preview'}})`);
  const rows = `(() => { const view = app.workspace.getMostRecentLeaf()?.view; return view?.file?.path === ${JSON.stringify(queryPath)} ? Array.from(view.containerEl.querySelectorAll('.markdown-preview-view .plugin-tasks-list-item')) : []; })()`;
  const clickTask = async (label, checked) => {
    const selector = `${rows}.find(el => el.innerText.includes(${JSON.stringify(label)}) && el.classList.contains('is-checked') === ${checked})?.querySelector('input[type="checkbox"]')`;
    if (!await wait(`!!(${selector}) && !(${selector}).disabled`)) throw new Error('Tasks checkbox not ready: ' + label);
    const point = await evaluate(`(() => { const el = ${selector}; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await clickAt(cdp, sessionId, point);
  };
  await openQuery();
  report.criteria.queryFiltersSource = await wait(`${rows}.length === 2 && ${rows}.every(el => !el.innerText.includes('Excluded task'))`);
  report.facts.today = await evaluate('moment().format("YYYY-MM-DD")');
  await clickTask('單次任務', false);
  report.criteria.checkboxUpdatesSource = await wait(`${readSource}.then(text => text.includes('- [x] 單次任務'))`);
  report.facts.completed = fs.readFileSync(path.join(fixture, 'Source.md'), 'utf8');
  report.criteria.doneDateRecorded = report.facts.completed.includes('📅 2026-10-25 ✅ ' + report.facts.today);
  report.criteria.unrelatedContentPreserved = report.facts.completed.startsWith('# Preserve heading\n\n') &&
    report.facts.completed.endsWith('\n\nPreserve footer\n') && report.facts.completed.includes('- [ ] 每日任務 🔁 every day 📅 2026-10-24') &&
    fs.readFileSync(path.join(fixture, 'Other.md'), 'utf8') === '- [ ] Excluded task\n';
  await clickTask('每日任務', false);
  report.criteria.recurrenceCompletesOriginal = await wait(`${readSource}.then(text => text.includes('- [x] 每日任務 🔁 every day 📅 2026-10-24 ✅ ' + ${JSON.stringify(report.facts.today)}))`);
  report.facts.recurrence = fs.readFileSync(path.join(fixture, 'Source.md'), 'utf8');
  report.criteria.recurrenceCreatesNextDay = report.facts.recurrence.includes('- [ ] 每日任務 🔁 every day 📅 2026-10-25') &&
    report.facts.recurrence.split('\n').filter(line => line.includes('每日任務')).length === 2;
  report.criteria.queryRefreshesFromWrite = await wait(`${rows}.length === 3 && ${rows}.filter(el => el.classList.contains('is-checked')).length === 2`);
  await reload();
  await openQuery();
  report.criteria.reloadPreservesUpdates = await wait(`${rows}.length === 3 && ${rows}.filter(el => el.classList.contains('is-checked')).length === 2`) &&
    await evaluate(readSource) === report.facts.recurrence;
  await clickTask('單次任務', true);
  report.criteria.uncheckRemovesDoneDate = await wait(`${readSource}.then(text => text.split(String.fromCharCode(10)).some(line => line.startsWith('- [ ] 單次任務') && !line.includes('✅')))`);
  report.facts.finalSource = fs.readFileSync(path.join(fixture, 'Source.md'), 'utf8');
  report.criteria.noFatalOverlay = await evaluate('document.getElementById("myobs-fatal").hidden');
} catch (error) {
  report.error = error.stack || String(error);
} finally {
  cdp?.close(); chrome?.child.kill();
  if (server?.child && server.child.exitCode === null) await new Promise(resolve => { server.child.once('exit', resolve); server.child.kill(); });
  for (const [file, bytes] of backups) { if (bytes === null) fs.rmSync(file, {force:true}); else fs.writeFileSync(file, bytes); }
  report.facts.pluginSources = hashes();
  report.criteria.pluginSourcesUnchanged = JSON.stringify(before) === JSON.stringify(report.facts.pluginSources);
}
report.passed = !report.error && Object.keys(report.criteria).length === 12 && Object.values(report.criteria).every(Boolean);
const output = JSON.stringify(report, null, 2);
if (args.json) fs.writeFileSync(args.json, output + '\n');
console.log(output);
if (!report.passed) process.exitCode = 1;
