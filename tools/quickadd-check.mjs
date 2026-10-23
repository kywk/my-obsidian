#!/usr/bin/env node
/** Exercise QuickAdd's public executeChoice API, without replacing its write pipeline. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Cdp, assertNotLiveVault, evalInPage, launchChrome, newPage,
  readTermsFromVendor, startServer, waitForPage } from './lib/cdp.mjs';

const args = { vault: null, port: 4011, timeout: 120, json: null };
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, '');
  if (!process.argv[i].startsWith('--') || !Object.hasOwn(args, key) || process.argv[i + 1] === undefined) {
    throw new Error('Usage: node tools/quickadd-check.mjs --vault <copy> [--port 4011] [--timeout 120] [--json <report>]');
  }
  args[key] = ['port', 'timeout'].includes(key) ? Number(process.argv[++i]) : process.argv[++i];
}
if (!args.vault || !Number.isInteger(args.port) || args.port < 1 || args.port > 64535 || !Number.isFinite(args.timeout) || args.timeout <= 0) {
  throw new Error('--vault must be a copy; --port must be 1..64535; --timeout must be positive seconds');
}
args.vault = assertNotLiveVault(args.vault);
if (args.json) args.json = assertNotLiveVault(args.json);
const id = 'quickadd';
const dir = path.join(args.vault, '.obsidian', 'plugins', id);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
if (manifest.id !== id || manifest.version !== '2.32.1') throw new Error('Install QuickAdd 2.32.1 in the vault copy before running this version-specific check');
const sources = ['main.js', 'manifest.json', 'styles.css'].filter(name => fs.existsSync(path.join(dir, name)));
const hashes = () => Object.fromEntries(sources.map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')]));
const before = hashes();
const listPath = path.join(args.vault, '.obsidian', 'community-plugins.json');
const dataPath = path.join(dir, 'data.json');
const backups = [listPath, dataPath].map(file => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]);
const fixture = fs.mkdtempSync(path.join(args.vault, '_myobs_quickadd_'));
const root = path.basename(fixture);
const template = '# {{VALUE:title}}\n\nOwner: {{VALUE:owner}}\nUnicode: 臺灣 🚀\n';
const original = '# Preserve original\n\nExisting content\n';
fs.writeFileSync(path.join(fixture, 'Template.md'), template);
fs.writeFileSync(path.join(fixture, 'Inbox.md'), original);
const common = { command: false, appendLink: false, copyLinkToClipboard: false, openFile: false };
const capture = (name, target, create) => ({ ...common, id: 'myobs-' + name, name, type: 'Capture',
  captureTo: root + '/' + target, captureToActiveFile: false,
  createFileIfItDoesntExist: { enabled: create, createWithTemplate: false, template: '' },
  format: { enabled: true, format: '- {{VALUE:entry}}' },
  insertAfter: { enabled: false, after: '', insertAtEnd: true },
  insertBefore: { enabled: false, before: '' }, newLineCapture: { enabled: false, direction: 'below' },
  // This legacy setting means "Bottom of file" in QuickAdd 2.32.1's own UI.
  prepend: true, task: false, templater: { afterCapture: 'none' },
});
const choices = [{ ...common, id: 'myobs-template', name: 'Myobs Template', type: 'Template',
  templatePath: root + '/Template.md', fileNameFormat: { enabled: true, format: '{{VALUE:title}}' },
  folder: { enabled: true, folders: [root], chooseWhenCreatingNote: false, createInSameFolderAsActiveFile: false, chooseFromSubfolders: false },
  fileExistsBehavior: { kind: 'apply', mode: 'doNothing' },
}, capture('Myobs Append', 'Inbox.md', false), capture('Myobs New capture', '新增紀錄.md', true)];
const report = { kind: 'quickadd-check', vault: args.vault, version: manifest.version, criteria: {}, facts: {} };
let server, chrome, cdp;
try {
  fs.writeFileSync(listPath, JSON.stringify([id]));
  fs.writeFileSync(dataPath, JSON.stringify({ choices, version: manifest.version, announceUpdates: 'none', templateFolderPaths: [root] }));
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
  report.criteria.normalBootInitializes = await evaluate('!!app.plugins.plugins.quickadd && __MYOBS_PLUGIN_WATCH.outcomes.quickadd?.ok === true');
  report.criteria.configuredChoicesAvailable = await evaluate('app.plugins.plugins.quickadd.settings.choices.length === 3 && typeof app.plugins.plugins.quickadd.api.executeChoice === "function"');
  const execute = (name, variables) => evaluate(`app.plugins.plugins.quickadd.api.executeChoice(${JSON.stringify(name)}, ${JSON.stringify(variables)})`);
  const read = name => fs.readFileSync(path.join(fixture, name), 'utf8');
  await execute('Myobs Template', { title: '新筆記', owner: '測試者' });
  report.criteria.templateCreatesUnicodeFilename = fs.existsSync(path.join(fixture, '新筆記.md'));
  report.facts.created = read('新筆記.md');
  report.criteria.templateExpandsVariables = report.facts.created === '# 新筆記\n\nOwner: 測試者\nUnicode: 臺灣 🚀\n';
  report.criteria.templateSourcePreserved = read('Template.md') === template;
  await execute('Myobs Template', { title: '新筆記', owner: 'Do not overwrite' });
  report.criteria.existingNotePreserved = read('新筆記.md') === report.facts.created;
  await execute('Myobs Append', { entry: '第一筆 📘' });
  await execute('Myobs Append', { entry: '第二筆 中文' });
  report.facts.appended = read('Inbox.md');
  report.criteria.captureAppendsInOrder = report.facts.appended.indexOf('- 第一筆 📘') > original.length - 1 &&
    report.facts.appended.indexOf('- 第二筆 中文') > report.facts.appended.indexOf('- 第一筆 📘');
  report.criteria.capturePreservesOriginal = report.facts.appended.startsWith(original) &&
    report.facts.appended.split('Existing content').length === 2;
  await execute('Myobs New capture', { entry: '建立新的 capture 筆記 🌏' });
  report.facts.newCapture = read('新增紀錄.md');
  report.criteria.captureCreatesMissingFile = report.facts.newCapture.trim() === '- 建立新的 capture 筆記 🌏';
  report.criteria.choiceVariablesStayIndependent = !report.facts.appended.includes('{{VALUE:') &&
    !report.facts.appended.includes('測試者') && !report.facts.newCapture.includes('第二筆');
  await reload();
  report.criteria.reloadPreservesFiles = await evaluate(`(async () => {
    const expected = ${JSON.stringify({ '新筆記.md': report.facts.created, 'Inbox.md': report.facts.appended, '新增紀錄.md': report.facts.newCapture })};
    for (const [name, text] of Object.entries(expected)) {
      const file = app.vault.getAbstractFileByPath(${JSON.stringify(root)} + '/' + name);
      if (!file || await app.vault.read(file) !== text) return false;
    }
    return true;
  })()`);
  await execute('Myobs Append', { entry: '重載後寫入 ✅' });
  report.facts.afterReload = read('Inbox.md');
  report.criteria.choiceStillWritesAfterReload = report.facts.afterReload.startsWith(report.facts.appended) &&
    report.facts.afterReload.trimEnd().endsWith('- 重載後寫入 ✅');
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
report.passed = !report.error && Object.keys(report.criteria).length === 14 && Object.values(report.criteria).every(Boolean);
const output = JSON.stringify(report, null, 2);
if (args.json) fs.writeFileSync(args.json, output + '\n');
console.log(output);
if (!report.passed) process.exitCode = 1;
