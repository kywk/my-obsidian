#!/usr/bin/env node
/** Exercise the installed, unmodified Geo Story Map through the official renderer. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Cdp, assertNotLiveVault, evalInPage, launchChrome, newPage,
  readTermsFromVendor, startServer, waitForPage } from './lib/cdp.mjs';

const args = { vault: null, port: 3701, timeout: 90, json: null };
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, '');
  if (!Object.hasOwn(args, key) || !process.argv[i].startsWith('--') || process.argv[i + 1] === undefined) {
    throw new Error('Usage: node tools/geo-story-map-check.mjs --vault <copy> [--port 3701] [--timeout 90] [--json <report>]');
  }
  args[key] = ['port', 'timeout'].includes(key) ? Number(process.argv[++i]) : process.argv[++i];
}
if (!args.vault || !Number.isInteger(args.port) || args.port < 1 || args.port > 64535 || !Number.isFinite(args.timeout) || args.timeout <= 0) {
  throw new Error('--vault must be a copy; --port must be 1..64535; --timeout must be positive seconds');
}
args.vault = assertNotLiveVault(args.vault);
if (args.json) args.json = assertNotLiveVault(args.json);
const id = 'geo-story-map';
const dir = path.join(args.vault, '.obsidian', 'plugins', id);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
if (manifest.id !== id || manifest.version !== '0.5.1') {
  throw new Error('This acceptance check requires geo-story-map 0.5.1; install that version in a vault copy before running it');
}
const sourceNames = ['main.js', 'manifest.json', 'styles.css'].filter(name => fs.existsSync(path.join(dir, name)));
const hashes = () => Object.fromEntries(sourceNames.map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')]));
const before = hashes();
const report = { kind: 'geo-story-map-check', vault: args.vault, version: manifest.version, criteria: {}, facts: {} };
// Keep this check independent of unrelated plugins, without editing their bundles or settings.
fs.writeFileSync(path.join(args.vault, '.obsidian', 'community-plugins.json'), JSON.stringify([id]));
const fixture = fs.mkdtempSync(path.join(args.vault, '_myobs_geo_'));
const relative = path.basename(fixture);
const tile = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const story = config => `---\nstory-map: true\n---\n\n~~~story-map\n${JSON.stringify(config)}\n~~~\n`;
fs.writeFileSync(path.join(fixture, 'Inline.md'), story({
  title: 'Geo fixture', map: { tileUrl: tile, attribution: 'Local test tile' },
  slides: [
    { title: 'Taipei fixture', text: 'First fixture', location: { lat: 25.03, lng: 121.56 } },
    { title: 'Tainan fixture', text: 'Second fixture', location: { lat: 23, lng: 120.2 } },
  ],
}));
fs.mkdirSync(path.join(fixture, 'Places'));
fs.writeFileSync(path.join(fixture, 'Places', 'Indexed.md'), '---\nstory-map-note: true\ntitle: Indexed location\nlocation: [25.03, 121.56]\ndate-created: 2026-10-24\n---\n\nBody from the indexed fixture.\n');
fs.writeFileSync(path.join(fixture, 'Folder.md'), story({ noteFolder: `${relative}/Places`, noteDisplay: 'full', map: { tileUrl: tile, attribution: 'Local test tile' } }));
let server, chrome, cdp;
try {
  server = await startServer(args.vault, args.port, readTermsFromVendor());
  chrome = await launchChrome(args.port + 1000);
  cdp = new Cdp(chrome.wsUrl); await cdp.connect();
  const { sessionId } = await newPage(cdp);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  const evaluate = expression => evalInPage(cdp, sessionId, expression);
  const wait = (expression, timeout = 20000) => waitForPage(cdp, sessionId, expression, timeout);
  const url = `http://127.0.0.1:${args.port}/`;
  await cdp.send('Page.navigate', { url }, sessionId);
  if (!await wait('!!(window.app && app.plugins)', args.timeout * 1000)) throw new Error('renderer did not boot');
  const token = await evaluate('window.__MYOBS.sessionToken');
  await evaluate('localStorage.setItem("enable-plugin-" + app.appId, "true")');
  await cdp.send('Page.navigate', { url }, sessionId);
  if (!await wait(`!!window.app && window.__MYOBS.sessionToken !== ${JSON.stringify(token)} && !!window.__MYOBS_PLUGIN_WATCH && __MYOBS_PLUGIN_WATCH.events.some(e => e.action === 'boot-scan')`, args.timeout * 1000)) throw new Error('plugin boot did not settle');
  const plugin = `app.plugins.plugins[${JSON.stringify(id)}]`;
  report.criteria.initialized = await evaluate(`!!(${plugin}?.loaded && __MYOBS_PLUGIN_WATCH.outcomes[${JSON.stringify(id)}]?.ok)`);
  if (!report.criteria.initialized) throw new Error('Geo Story Map did not initialize; check child_process import support');
  report.criteria.commandsRegistered = await evaluate(`['open-as-story-map', 'open-as-markdown', 'find-location-coordinates', 'import-leaflet-settings'].every(name => !!app.commands.commands['geo-story-map:' + name])`);
  const view = `app.workspace.getLeavesOfType('geo-story-map-view')[0]?.view`;
  const openStory = async name => {
    const file = `${relative}/${name}.md`;
    if (!await wait(`!!app.metadataCache.getFileCache(app.vault.getAbstractFileByPath(${JSON.stringify(file)}))?.frontmatter`)) throw new Error(`metadata did not index fixture ${name}`);
    await evaluate(`${plugin}.openAsStoryMap(app.vault.getAbstractFileByPath(${JSON.stringify(file)}))`);
  };
  await openStory('Inline');
  report.criteria.inlineMapMarkersAndPath = await wait(`(${view})?.contentEl.querySelectorAll('.story-map__marker').length === 2 && !!(${view})?.contentEl.querySelector('.story-map__path')`);
  report.criteria.localTilesRendered = await wait(`Array.from((${view})?.contentEl.querySelectorAll('img.leaflet-tile') || []).some(image => image.complete && image.naturalWidth > 0 && image.src.startsWith('data:'))`);
  await evaluate(`(${view})?.contentEl.querySelector('button[aria-label="Next"]').click()`);
  report.criteria.storyNavigation = await wait(`(${view})?.contentEl.querySelector('h2')?.textContent === 'Tainan fixture' && (${view})?.contentEl.querySelector('.story-map__nav')?.textContent.includes('2 / 2')`);
  report.facts.indexedMetadataReady = await wait(`app.metadataCache.getFileCache(app.vault.getAbstractFileByPath(${JSON.stringify(`${relative}/Places/Indexed.md`)}))?.frontmatter?.['story-map-note'] === true`);
  report.facts.indexedMetadata = await evaluate(`app.metadataCache.getFileCache(app.vault.getAbstractFileByPath(${JSON.stringify(`${relative}/Places/Indexed.md`)}))?.frontmatter`);
  await openStory('Folder');
  report.criteria.folderIndexAndMarker = await wait(`(${view})?.file?.path === ${JSON.stringify(`${relative}/Folder.md`)} && (${view})?.contentEl.querySelectorAll('.story-map__marker').length === 1`);
  report.criteria.indexedNoteBody = await wait(`(${view})?.contentEl.textContent.includes('Body from the indexed fixture.')`);
  report.facts.folderView = await evaluate(`({path: (${view})?.file?.path, text: (${view})?.contentEl.innerText, markers: (${view})?.contentEl.querySelectorAll('.story-map__marker').length})`);
  await evaluate(`app.commands.executeCommandById('geo-story-map:open-as-markdown')`);
  report.criteria.returnToMarkdown = await wait(`app.workspace.getLeavesOfType('markdown').some(leaf => leaf.view.file?.path === ${JSON.stringify(`${relative}/Folder.md`)})`);
  // The actual AI controller must fail before it can start a server process.
  report.facts.localAgent = await evaluate(`(async () => {
    try { await ${plugin}.agentController.test({id:'myobs-missing',kind:'custom',name:'Missing fixture',command:'/__myobs_missing_agent__',args:''}); return {rejected:false}; }
    catch(error) { return {rejected:true, message:error.message}; }
  })()`);
  report.criteria.localAgentUnavailable = report.facts.localAgent.rejected && /executable.*not found/i.test(report.facts.localAgent.message);
  report.facts.processBoundary = await evaluate(`(() => {
    try { require('node:child_process').spawn('__myobs_never_execute__', []); return {rejected:false}; }
    catch(error) { return {rejected:true,code:error.code,reason:error.reason,operation:error.operation}; }
  })()`);
  report.criteria.serverProcessDenied = report.facts.processBoundary.rejected && report.facts.processBoundary.code === 'MODULE_NOT_SUPPORTED' && report.facts.processBoundary.operation === 'spawn';
  report.criteria.noFatalOverlay = await evaluate('(() => { const el = document.getElementById("myobs-fatal"); return !el || el.hidden || getComputedStyle(el).display === "none"; })()');
} catch (error) {
  report.error = error.stack || String(error);
} finally {
  cdp?.close(); chrome?.child.kill(); server?.child.kill();
  report.facts.pluginSources = hashes();
  report.criteria.pluginSourcesUnchanged = JSON.stringify(before) === JSON.stringify(report.facts.pluginSources);
}
report.passed = !report.error && Object.keys(report.criteria).length === 12 && Object.values(report.criteria).every(Boolean);
const output = JSON.stringify(report, null, 2);
if (args.json) fs.writeFileSync(args.json, `${output}\n`);
console.log(output);
if (!report.passed) process.exitCode = 1;
