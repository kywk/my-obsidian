#!/usr/bin/env node
/** Feature acceptance for the installed Dataview, using a guarded vault copy. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  Cdp, assertNotLiveVault, clickAt, evalInPage, launchChrome, newPage,
  readTermsFromVendor, startServer, waitForPage,
} from './lib/cdp.mjs';

const id = 'dataview';
function parseArgs(argv) {
  const args = { vault: null, port: 3951, timeout: 120, json: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !Object.hasOwn(args, key) || argv[i + 1] === undefined) {
      throw new Error('Usage: node tools/dataview-check.mjs --vault <copy> [--port 3951] [--timeout 120] [--json <report.json>]');
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
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function note(status, score, owner, tasks) {
  return `---\nstatus: ${status}\nscore: ${score}\n---\nowner:: ${owner}\n\n${tasks}\n`;
}
function readView() {
  const root = app.workspace.getMostRecentLeaf()?.view?.containerEl.querySelector('.markdown-preview-view');
  return {
    rows: [...root.querySelectorAll('table.dataview tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent.trim())),
    list: [...root.querySelectorAll('ul.dataview.list-view-ul > li')].map(item => item.textContent.trim()),
    tasks: [...root.querySelectorAll('li.dataview.task-list-item')].map(item => item.textContent.trim()),
    text: root.textContent,
  };
}
async function queries(root) {
  const api = app.plugins.plugins.dataview.api;
  const from = ' FROM ' + JSON.stringify(root);
  const list = await api.tryQuery('LIST WITHOUT ID file.name' + from + ' WHERE status = "active" SORT score DESC');
  const table = await api.tryQuery('TABLE WITHOUT ID file.name AS Name, owner AS Owner, score AS Score' + from + ' WHERE status = "active" SORT score DESC');
  const tasks = await api.tryQuery('TASK' + from + ' WHERE !completed SORT text ASC');
  return { list: list.values, headers: table.headers, rows: table.values, tasks: tasks.values.map(task => ({ text: task.text, completed: task.completed, path: task.path })) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.join(args.vault, '.obsidian', 'plugins', id);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (manifest.id !== id || manifest.version !== '0.5.68') {
    throw new Error('Install Dataview 0.5.68 in the vault copy before running this version-specific acceptance test');
  }
  const assets = ['manifest.json', 'main.js', 'styles.css'].filter(name => fs.existsSync(path.join(dir, name)));
  const hashes = Object.fromEntries(assets.map(name => [name, digest(path.join(dir, name))]));
  const listPath = path.join(args.vault, '.obsidian', 'community-plugins.json');
  const dataPath = path.join(dir, 'data.json');
  const backups = [listPath, dataPath].map(file => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]);
  const report = { kind: 'dataview-check', vault: args.vault, version: manifest.version, criteria: {}, facts: {} };
  const root = path.basename(fs.mkdtempSync(path.join(args.vault, '_myobs_dataview_')));
  const from = ' FROM ' + JSON.stringify(root);
  const dashboard = [
    '# Dataview acceptance',
    '```dataview\nLIST WITHOUT ID file.name' + from + ' WHERE status = "active" SORT score DESC\n```',
    '```dataview\nTABLE WITHOUT ID file.name AS Name, owner AS Owner, score AS Score' + from + ' WHERE status = "active" SORT score DESC\n```',
    '```dataview\nTASK' + from + ' WHERE !completed SORT text ASC\n```',
    '```dataviewjs\ndv.paragraph("JS total: " + dv.pages(' + JSON.stringify(JSON.stringify(root)) + ').where(p => p.status === "active").score.sum());\n```',
  ].join('\n\n');
  const files = {
    'Alpha.md': note('active', 20, 'Alice', '- [ ] Alpha pending\n- [x] Alpha complete'),
    'Beta.md': note('active', 10, 'Bob', '- [ ] Beta pending'),
    'Gamma.md': note('archived', 99, 'Carol', '- [x] Gamma complete'),
    'Dashboard.md': dashboard,
  };
  let server, chrome, cdp;
  try {
    fs.writeFileSync(listPath, JSON.stringify([id]));
    // JS queries are explicitly enabled in the copy; automatic refresh keeps
    // the installed plugin's normal default interval and event behavior.
    fs.writeFileSync(dataPath, JSON.stringify({ enableDataviewJs: true, refreshEnabled: true, showResultCount: false }));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(args.vault, root, name), text);
    server = await startServer(args.vault, args.port, readTermsFromVendor());
    chrome = await launchChrome(args.port + 1000);
    cdp = new Cdp(chrome.wsUrl);
    await cdp.connect();
    const { sessionId } = await newPage(cdp);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    const evaluate = expression => evalInPage(cdp, sessionId, expression);
    const wait = expression => waitForPage(cdp, sessionId, expression, args.timeout * 1000);
    const url = `http://127.0.0.1:${args.port}/`;
    const rootJson = JSON.stringify(root);
    const queryExpression = `(${queries.toString()})(${rootJson})`;
    const viewExpression = `(${readView.toString()})()`;
    const indexedExpression = `!!window.app && app.metadataCache?.initialized === true && app.plugins.plugins.dataview?.index?.initialized === true && !!app.plugins.plugins.dataview.api.page(${JSON.stringify(root + '/Alpha.md')})`;
    await cdp.send('Page.navigate', { url }, sessionId);
    if (!await wait('!!window.app && !!app.plugins')) throw new Error('renderer did not boot');
    let token = await evaluate('window.__MYOBS.sessionToken');
    await evaluate('localStorage.setItem("enable-plugin-" + app.appId, "true")');
    await cdp.send('Page.navigate', { url }, sessionId);
    if (!await wait(`!!window.app && window.__MYOBS.sessionToken !== ${JSON.stringify(token)}`)) throw new Error('renderer did not reload');
    if (!await wait(indexedExpression)) throw new Error('Dataview index did not initialize');
    report.facts.boot = await evaluate(`({ outcome: __MYOBS_PLUGIN_WATCH.outcomes.dataview, indexed: app.plugins.plugins.dataview.index.initialized, page: (() => {const p=app.plugins.plugins.dataview.api.page(${JSON.stringify(root + '/Alpha.md')});return {status:p.status,score:p.score,owner:p.owner};})() })`);
    report.criteria.normalBootAndIndexedFields = report.facts.boot.outcome?.ok === true && report.facts.boot.indexed && equal(report.facts.boot.page, { status: 'active', score: 20, owner: 'Alice' });
    report.facts.initial = await evaluate(queryExpression);
    report.criteria.listFilterAndSort = equal(report.facts.initial.list, ['Alpha', 'Beta']);
    report.criteria.tableFrontmatterAndInlineFields = equal(report.facts.initial.headers, ['Name', 'Owner', 'Score']) && equal(report.facts.initial.rows, [['Alpha', 'Alice', 20], ['Beta', 'Bob', 10]]);
    report.criteria.taskQuery = equal(report.facts.initial.tasks.map(task => [task.text, task.completed]), [['Alpha pending', false], ['Beta pending', false]]);
    const openDashboard = `app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath(${JSON.stringify(root + '/Dashboard.md')}), {state:{mode:'preview'}})`;
    await evaluate(openDashboard);
    if (!await wait(`${viewExpression}.rows.length === 2 && ${viewExpression}.tasks.length === 2 && ${viewExpression}.text.includes('JS total: 30')`)) throw new Error('query blocks did not render');
    report.facts.view = await evaluate(viewExpression);
    report.criteria.markdownQueryBlocks = equal(report.facts.view.list, ['Alpha', 'Beta']) && equal(report.facts.view.rows, [['Alpha', 'Alice', '20'], ['Beta', 'Bob', '10']]) && equal(report.facts.view.tasks, ['Alpha pending', 'Beta pending']);
    report.criteria.dataviewJavascriptBlock = report.facts.view.text.includes('JS total: 30');
    await evaluate(`app.vault.modify(app.vault.getAbstractFileByPath(${JSON.stringify(root + '/Beta.md')}), ${JSON.stringify(note('active', 30, 'Bobby', '- [ ] Beta pending'))})`);
    const betaUpdated = `app.plugins.plugins.dataview.api.page(${JSON.stringify(root + '/Beta.md')})?.score === 30`;
    if (!await wait(betaUpdated)) throw new Error('modified note did not reach Dataview index');
    report.facts.modified = await evaluate(queryExpression);
    report.criteria.vaultWriteUpdatesQuery = equal(report.facts.modified.rows, [['Beta', 'Bobby', 30], ['Alpha', 'Alice', 20]]);
    report.criteria.automaticViewRefresh = await wait(`${viewExpression}.rows[0]?.join('|') === 'Beta|Bobby|30' && ${viewExpression}.text.includes('JS total: 50')`);
    const checkbox = await evaluate(`(() => {const item=[...app.workspace.getMostRecentLeaf().view.containerEl.querySelectorAll('.markdown-preview-view li.dataview.task-list-item')].find(e=>e.textContent.trim()==='Alpha pending');const e=item?.querySelector('input');if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    if (!checkbox) throw new Error('Dataview task checkbox missing');
    const browserAlphaAt = Date.now();
    await clickAt(cdp, sessionId, checkbox);
    const taskWritten = await wait(`app.vault.adapter.read(${JSON.stringify(root + '/Alpha.md')}).then(text=>text.includes('- [x] Alpha pending'))`);
    report.criteria.taskCheckboxWritesMarkdown = taskWritten && fs.readFileSync(path.join(args.vault, root, 'Alpha.md'), 'utf8').includes('- [x] Alpha pending');
    // The checkbox just wrote Alpha through the browser. Editing that exact
    // file externally must update both index and rendered query before the
    // 30-second origin registry lifetime expires; a fresh path misses the bug.
    const externalAt = Date.now();
    fs.writeFileSync(path.join(args.vault, root, 'Alpha.md'), note('active', 25, 'External', '- [x] Alpha pending\n- [x] Alpha complete'));
    report.criteria.sameFileExternalWithinTtl = externalAt - browserAlphaAt < 10000 && await waitForPage(cdp, sessionId, `app.plugins.plugins.dataview.api.page(${JSON.stringify(root + '/Alpha.md')})?.score === 25 && ${viewExpression}.text.includes('JS total: 55')`, 10000);
    report.facts.sameFileExternal = { browserWriteToExternalMs: externalAt - browserAlphaAt, elapsedMs: Date.now()-externalAt, watch: await evaluate('({...__MYOBS_WATCH.state})'), query: await evaluate(queryExpression), view: await evaluate(viewExpression) };
    fs.writeFileSync(path.join(args.vault, root, 'Gamma.md'), note('active', 15, 'Carol', '- [x] Gamma complete'));
    report.criteria.externalChangeUpdatesIndex = await waitForPage(cdp, sessionId, `app.plugins.plugins.dataview.api.page(${JSON.stringify(root + '/Gamma.md')})?.score === 15 && ${viewExpression}.text.includes('JS total: 70')`, 10000);
    await evaluate(`app.fileManager.renameFile(app.vault.getAbstractFileByPath(${JSON.stringify(root + '/Beta.md')}), ${JSON.stringify(root + '/BetaRenamed.md')})`);
    report.criteria.renameUpdatesIndex = await wait(`!!app.plugins.plugins.dataview.api.page(${JSON.stringify(root + '/BetaRenamed.md')}) && !app.plugins.plugins.dataview.api.page(${JSON.stringify(root + '/Beta.md')})`);
    await evaluate(`app.vault.delete(app.vault.getAbstractFileByPath(${JSON.stringify(root + '/Gamma.md')}))`);
    report.criteria.deleteUpdatesIndex = await wait(`!app.plugins.plugins.dataview.api.page(${JSON.stringify(root + '/Gamma.md')})`);
    token = await evaluate('window.__MYOBS.sessionToken');
    await cdp.send('Page.navigate', { url }, sessionId);
    if (!await wait(`!!window.app && window.__MYOBS.sessionToken !== ${JSON.stringify(token)}`) || !await wait(indexedExpression)) throw new Error('reload did not rebuild Dataview index');
    report.facts.reloaded = await evaluate(queryExpression);
    report.criteria.reloadPreservesResults = equal(report.facts.reloaded.rows, [['BetaRenamed', 'Bobby', 30], ['Alpha', 'External', 25]]) && equal(report.facts.reloaded.tasks.map(task => task.text), ['Beta pending']);
    await evaluate(openDashboard);
    report.criteria.reloadRendersQueries = await wait(`${viewExpression}.rows[0]?.join('|') === 'BetaRenamed|Bobby|30' && ${viewExpression}.tasks.length === 1 && ${viewExpression}.text.includes('JS total: 55')`);
    report.criteria.noFatalOverlay = await evaluate(`document.getElementById('myobs-fatal').hidden`);
  } catch (error) {
    report.facts.error = error.message;
    report.criteria.executionCompleted = false;
  } finally {
    cdp?.close();
    chrome?.child.kill();
    if (server?.child && server.child.exitCode === null) {
      await new Promise(resolve => { server.child.once('exit', resolve); server.child.kill(); });
    }
    for (const [file, bytes] of backups) {
      if (bytes === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, bytes);
    }
    report.facts.assetHashes = Object.fromEntries(assets.map(name => [name, { before: hashes[name], after: digest(path.join(dir, name)) }]));
    report.criteria.installedPluginUnmodified = Object.values(report.facts.assetHashes).every(value => value.before === value.after);
  }
  report.passed = Object.keys(report.criteria).length === 17 && Object.values(report.criteria).every(Boolean);
  const output = JSON.stringify(report, null, 2);
  if (args.json) fs.writeFileSync(args.json, output + '\n');
  console.log(output);
  if (!report.passed) process.exitCode = 1;
}
main().catch(error => { console.error('dataview-check failed:', error.message); process.exitCode = 2; });
