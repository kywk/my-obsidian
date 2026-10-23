#!/usr/bin/env node
/** Exercise installed Kanban card actions through its UI and disk-backed renderer. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Cdp, assertNotLiveVault, clickAt, evalInPage, launchChrome, newPage,
  readTermsFromVendor, sleep, startServer, waitForPage } from './lib/cdp.mjs';

const args = { vault: null, port: 3901, timeout: 90, json: null };
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, '');
  if (!Object.hasOwn(args, key) || !process.argv[i].startsWith('--') || process.argv[i + 1] === undefined) {
    throw new Error('Usage: node tools/kanban-check.mjs --vault <copy> [--port 3901] [--timeout 90] [--json <report>]');
  }
  args[key] = ['port', 'timeout'].includes(key) ? Number(process.argv[++i]) : process.argv[++i];
}
if (!args.vault || !Number.isInteger(args.port) || args.port < 1 || args.port > 64535 || !Number.isFinite(args.timeout) || args.timeout <= 0) {
  throw new Error('--vault must be a copy; --port must be 1..64535; --timeout must be positive seconds');
}
args.vault = assertNotLiveVault(args.vault);
if (args.json) args.json = assertNotLiveVault(args.json);
const id = 'obsidian-kanban';
const dir = path.join(args.vault, '.obsidian', 'plugins', id);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
if (manifest.id !== id || manifest.version !== '2.0.51') {
  throw new Error('This acceptance check requires obsidian-kanban 2.0.51; install that version in a vault copy before running it');
}
const sources = ['main.js', 'manifest.json', 'styles.css'].filter(name => fs.existsSync(path.join(dir, name)));
const hashes = () => Object.fromEntries(sources.map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')]));
const before = hashes();
const criteria = Object.fromEntries(['initialized', 'boardParsed', 'cardCreated', 'cardEdited', 'movedAcrossLists', 'cardCompleted',
  'cardDeleted', 'cardArchived', 'markdownPersisted', 'reloadBoard', 'reloadCompletedAndArchive', 'noFatalOverlay',
  'noMenuErrors', 'pluginSourcesUnchanged'].map(name => [name, false]));
const report = { kind: 'kanban-check', vault: args.vault, version: manifest.version, criteria, facts: { menuErrors: [] } };
fs.writeFileSync(path.join(args.vault, '.obsidian', 'community-plugins.json'), JSON.stringify([id]));
fs.writeFileSync(path.join(dir, 'data.json'), '{}');
const fixture = fs.mkdtempSync(path.join(args.vault, '_myobs_kanban_'));
const relative = `${path.basename(fixture)}/Board.md`;
const disk = path.join(fixture, 'Board.md');
fs.writeFileSync(disk, '---\nkanban-plugin: board\n---\n\n## Todo\n\n- [ ] Seed card\n\n## Done\n\n\n%% kanban:settings\n```\n{"kanban-plugin":"board","show-checkboxes":true}\n```\n%%\n');
let server, chrome, cdp;
try {
  server = await startServer(args.vault, args.port, readTermsFromVendor());
  chrome = await launchChrome(args.port + 1000);
  cdp = new Cdp(chrome.wsUrl); await cdp.connect();
  const { sessionId } = await newPage(cdp);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  cdp.on(message => {
    if (message.sessionId !== sessionId || message.method !== 'Runtime.consoleAPICalled') return;
    const text = message.params.args.map(value => value.value || value.description || '').join(' ');
    if (/menu:.*(?:failed|threw)|Maximum call stack size exceeded/.test(text)) report.facts.menuErrors.push(text.slice(0, 1500));
  });
  const evaluate = expression => evalInPage(cdp, sessionId, expression);
  const wait = (expression, timeout = 20000) => waitForPage(cdp, sessionId, expression, timeout);
  const need = async (expression, label) => { if (!await wait(expression)) throw new Error(label); };
  const click = async expression => {
    await need(`!!(${expression})`, `UI element missing: ${expression}`);
    const point = await evaluate(`(() => { const el = ${expression}; el.scrollIntoView({block:'nearest'}); const r = el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await clickAt(cdp, sessionId, point);
  };
  const key = async (key, code, windowsVirtualKeyCode) => {
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode }, sessionId);
  };
  const boardView = 'window.__myobsKanbanLeaf?.view';
  const boardDom = `(${boardView})?.contentEl`;
  const card = title => `Array.from(${boardDom}?.querySelectorAll('.kanban-plugin__item') || []).find(el => el.innerText.trim() === ${JSON.stringify(title)})`;
  const menu = title => `Array.from(document.querySelectorAll('.myobs-menu-row, .menu-item')).find(el => el.querySelector('.myobs-menu-label, .menu-item-title')?.textContent === ${JSON.stringify(title)})`;
  const openCardMenu = async title => click(`(${card(title)})?.querySelector('.kanban-plugin__item-postfix-button')`);
  const laneCards = index => `Array.from(${boardDom}?.querySelectorAll('.kanban-plugin__lane')[${index}]?.querySelectorAll('.kanban-plugin__item') || []).map(el => el.innerText.trim())`;
  const addCard = async title => {
    await click(`${boardDom}?.querySelector('.kanban-plugin__new-item-button')`);
    await need(`!!${boardDom}?.querySelector('.kanban-plugin__item-input-wrapper .cm-content:focus')`, 'card editor did not focus');
    await cdp.send('Input.insertText', { text: title }, sessionId);
    await key('Enter', 'Enter', 13);
    await need(`!!(${card(title)})`, `card was not added: ${title}`);
    await key('Escape', 'Escape', 27);
  };
  const url = `http://127.0.0.1:${args.port}/`;
  await cdp.send('Page.navigate', { url }, sessionId);
  if (!await wait('!!window.app?.plugins', args.timeout * 1000)) throw new Error('renderer did not boot');
  const token = await evaluate('window.__MYOBS.sessionToken');
  await evaluate('localStorage.setItem("enable-plugin-" + app.appId, "true")');
  await cdp.send('Page.navigate', { url }, sessionId);
  if (!await wait(`!!window.app?.metadataCache?.initialized && app.workspace.layoutReady && window.__MYOBS.sessionToken !== ${JSON.stringify(token)} && !!window.__MYOBS_PLUGIN_WATCH?.events.some(e => e.action === 'boot-scan')`, args.timeout * 1000)) throw new Error('normal plugin boot and metadata did not settle');
  criteria.initialized = await evaluate(`!!app.plugins.plugins[${JSON.stringify(id)}] && __MYOBS_PLUGIN_WATCH.outcomes[${JSON.stringify(id)}]?.ok === true`);
  const openBoard = async () => {
    await need('app.workspace.layoutReady === true', 'workspace layout not restored');
    await need(`!!app.metadataCache.getFileCache(app.vault.getAbstractFileByPath(${JSON.stringify(relative)}))?.frontmatter`, 'board metadata not indexed');
    // Keep a specific leaf: layout restoration and other tabs can change activeLeaf.
    await evaluate(`(async () => {
      const file = app.vault.getAbstractFileByPath(${JSON.stringify(relative)});
      const leaf = app.workspace.getLeavesOfType('kanban').find(leaf => leaf.view.file?.path === file.path)
        || app.workspace.getLeavesOfType('markdown').find(leaf => leaf.view.file?.path === file.path)
        || app.workspace.getLeaf(true);
      window.__myobsKanbanLeaf = leaf;
      if (leaf.view.file?.path !== file.path) await leaf.openFile(file);
      app.workspace.setActiveLeaf(leaf, {focus:true});
    })()`);
    await need(`(${boardView})?.file?.path === ${JSON.stringify(relative)}`, 'board file not open in target leaf');
    if (await evaluate(`(${boardView})?.getViewType() !== 'kanban'`)) {
      await evaluate("app.commands.executeCommandById('obsidian-kanban:toggle-kanban-view')");
    }
    await need(`(${boardView})?.getViewType() === 'kanban' && typeof (${boardView})?.getBoard === 'function' && ${boardDom}?.querySelectorAll('.kanban-plugin__lane').length === 2`, 'target Kanban view did not render');
  };
  await openBoard();
  criteria.boardParsed = await evaluate(`(${laneCards(0)}).includes('Seed card') && (${laneCards(1)}).length === 0`);
  await addCard('Created card');
  criteria.cardCreated = await evaluate(`(${laneCards(0)}).includes('Created card')`);
  await openCardMenu('Created card'); await click(menu('Edit card'));
  await need(`!!${boardDom}?.querySelector('.kanban-plugin__item-input-wrapper .cm-content:focus')`, 'edit card editor did not focus');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, commands: ['selectAll'] }, sessionId);
  await cdp.send('Input.insertText', { text: 'Edited card' }, sessionId);
  await key('Enter', 'Enter', 13); await key('Escape', 'Escape', 27);
  criteria.cardEdited = await wait(`!!(${card('Edited card')}) && !(${card('Created card')})`);
  await openCardMenu('Edited card'); await click(menu('Move to list')); await click(menu('Done'));
  criteria.movedAcrossLists = await wait(`!(${laneCards(0)}).includes('Edited card') && (${laneCards(1)}).includes('Edited card')`);
  if (!criteria.movedAcrossLists) throw new Error('Move to list did not move the card; inspect facts.menuErrors for native-menu failures');
  await click(`(${card('Edited card')})?.querySelector('input[type=checkbox]')`);
  criteria.cardCompleted = await wait(`(${card('Edited card')})?.querySelector('input[type=checkbox]')?.checked === true`);
  await openCardMenu('Seed card'); await click(menu('Delete card'));
  criteria.cardDeleted = await wait(`!(${card('Seed card')})`);
  await addCard('Archived card');
  await openCardMenu('Archived card'); await click(menu('Archive card'));
  criteria.cardArchived = await wait(`!(${card('Archived card')}) && (${boardView}).getBoard().data.archive.some(item => item.data.titleRaw === 'Archived card')`);
  const persisted = text => /## Done\s+- \[x\] Edited card/.test(text) && !text.includes('Seed card') && !text.includes('Created card') && /## Archive[\s\S]*Archived card/.test(text);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !persisted(fs.readFileSync(disk, 'utf8'))) await sleep(150);
  report.facts.markdownBeforeReload = fs.readFileSync(disk, 'utf8');
  criteria.markdownPersisted = persisted(report.facts.markdownBeforeReload);
  const reloadToken = await evaluate('window.__MYOBS.sessionToken');
  await cdp.send('Page.reload', {}, sessionId);
  if (!await wait(`!!window.app?.metadataCache?.initialized && app.workspace.layoutReady && window.__MYOBS.sessionToken !== ${JSON.stringify(reloadToken)} && __MYOBS_PLUGIN_WATCH.outcomes[${JSON.stringify(id)}]?.ok === true`, args.timeout * 1000)) throw new Error('reload did not settle');
  await openBoard();
  criteria.reloadBoard = await wait(`(${laneCards(0)}).length === 0 && (${laneCards(1)}).join('|') === 'Edited card'`);
  criteria.reloadCompletedAndArchive = await evaluate(`!!(${card('Edited card')})?.querySelector('input[type=checkbox]')?.checked && (${boardView}).getBoard().data.archive.some(item => item.data.titleRaw === 'Archived card')`);
  report.facts.boardAfterReload = await evaluate(`(${boardView}).getBoard()`);
  report.facts.markdownAfterReload = fs.readFileSync(disk, 'utf8');
  criteria.markdownPersisted &&= report.facts.markdownBeforeReload === report.facts.markdownAfterReload;
  criteria.noFatalOverlay = await evaluate('(() => { const el = document.getElementById("myobs-fatal"); return !el || el.hidden || getComputedStyle(el).display === "none"; })()');
} catch (error) {
  report.error = error.stack || String(error);
} finally {
  cdp?.close(); chrome?.child.kill(); server?.child.kill();
  criteria.noMenuErrors = report.facts.menuErrors.length === 0;
  report.facts.pluginSources = hashes();
  criteria.pluginSourcesUnchanged = JSON.stringify(before) === JSON.stringify(report.facts.pluginSources);
}
report.passed = !report.error && Object.values(criteria).every(Boolean);
const output = JSON.stringify(report, null, 2);
if (args.json) fs.writeFileSync(args.json, `${output}\n`);
console.log(output);
if (!report.passed) process.exitCode = 1;
