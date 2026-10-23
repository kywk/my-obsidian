#!/usr/bin/env node
/** Feature acceptance for an unmodified installed Templater, using a guarded vault copy. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  Cdp, assertNotLiveVault, evalInPage, launchChrome, newPage,
  readTermsFromVendor, startServer, waitForPage,
} from './lib/cdp.mjs';

const id = 'templater-obsidian';
function parseArgs(argv) {
  const args = { vault: null, port: 3601, timeout: 120, json: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !Object.hasOwn(args, key) || argv[i + 1] === undefined) {
      throw new Error('Usage: node tools/templater-check.mjs --vault <copy> [--port 3601] [--timeout 120] [--json <report.json>]');
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

// Runs through the installed plugin's own parser and function generator. No
// plugin implementation is copied into the test, and no module is injected.
async function exerciseTemplater(root) {
  const plugin = app.plugins.plugins['templater-obsidian'];
  const templater = plugin.templater;
  await app.vault.createFolder(root);
  await app.vault.createFolder(root + '/scripts');
  const target = await app.vault.create(root + '/Input.md', 'Original');
  const config = templater.create_running_config(undefined, target, 2);
  const facts = {};
  facts.date = await templater.parse_template(config,
    '<% tp.date.now("YYYY-MM-DD", 0, "2026-10-24", "YYYY-MM-DD") %>');
  facts.strings = await templater.parse_template(config,
    '<% "hello".toUpperCase() %>|<%* tR += [1,2,3].map(x => x * 2).join(",") %>');
  facts.file = await templater.parse_template(config,
    '<% tp.file.title %>|<% tp.file.path(true) %>|<% await tp.file.exists(' + JSON.stringify(root + '/Input.md') + ') %>');
  const created = await templater.create_new_note_from_template('Made <% "safely".toUpperCase() %>',
    app.vault.getAbstractFileByPath(root), 'Created', false);
  facts.created = created ? { path: created.path, text: await app.vault.read(created) } : null;
  await templater.parse_template(config, '<%* await tp.file.rename("Renamed") %>');
  facts.renamed = { path: target.path, text: await app.vault.read(target) };
  await app.vault.create(root + '/scripts/greet.js', 'module.exports = name => "Hi " + name;');
  await app.vault.create(root + '/scripts/read.js',
    'module.exports = async base => require("fs/promises").readFile(require("path").join(base, ' +
    JSON.stringify(root) + ', "Renamed.md"), "utf8");');
  plugin.settings.user_scripts_folder = root + '/scripts';
  facts.userScript = await templater.parse_template(config,
    '<% await tp.user.greet("Browser") %>|<% await tp.user.read(app.vault.adapter.getBasePath()) %>');
  const marker = app.vault.adapter.getBasePath() + '/' + root + '/SHELL_MUST_NOT_EXIST';
  // Even if the denial regresses, this diagnostic command only creates an
  // empty marker inside the copy. The path is quoted for POSIX shells.
  const quoted = "'" + marker.replace(/'/g, "'\\''") + "'";
  plugin.settings.templates_pairs = [['blocked', 'touch ' + quoted]];
  app.saveLocalStorage('templater-local-settings', { enable_system_commands: true });
  try {
    await templater.parse_template(config, '<% await tp.user.blocked() %>');
    facts.shell = { denied: false };
  } catch (error) {
    facts.shell = { denied: true, message: error.message, detail: error.console_msg || '' };
  }
  facts.shellArtifact = await app.vault.adapter.exists(root + '/SHELL_MUST_NOT_EXIST');
  facts.afterDenial = await templater.parse_template(config, '<% "still works" %>');
  return facts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.join(args.vault, '.obsidian', 'plugins', id);
  const assets = ['manifest.json', 'main.js'];
  const hashes = Object.fromEntries(assets.map(name => [name, digest(path.join(dir, name))]));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (manifest.id !== id || manifest.version !== '2.26.0') {
    throw new Error('Install Templater 2.26.0 in the vault copy before running this version-specific acceptance test');
  }
  const listPath = path.join(args.vault, '.obsidian', 'community-plugins.json');
  const dataPath = path.join(dir, 'data.json');
  const backups = [listPath, dataPath].map(file => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]);
  const report = { kind: 'templater-check', vault: args.vault, version: manifest.version, criteria: {}, facts: {} };
  const root = '_myobs_templater_' + Date.now();
  let server, chrome, cdp;
  try {
    // Startup templates and unrelated plugins from the source vault are not
    // part of this acceptance scenario; restore these copy settings afterward.
    fs.writeFileSync(listPath, JSON.stringify([id]));
    fs.writeFileSync(dataPath, '{}');
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
    await cdp.send('Page.navigate', { url }, sessionId);
    if (!await wait('!!window.app && !!app.plugins')) throw new Error('renderer did not boot');
    const token = await evaluate('window.__MYOBS.sessionToken');
    await evaluate('localStorage.setItem("enable-plugin-" + app.appId, "true")');
    await cdp.send('Page.navigate', { url }, sessionId);
    if (!await wait(`!!window.app && window.__MYOBS.sessionToken !== ${JSON.stringify(token)}`)) throw new Error('renderer did not reload');
    if (!await wait("!!window.__MYOBS_PLUGIN_WATCH && __MYOBS_PLUGIN_WATCH.events.some(event => event.action === 'boot-scan')")) {
      throw new Error('plugin boot scan did not settle');
    }
    report.facts.boot = await evaluate(`({ outcome: __MYOBS_PLUGIN_WATCH.outcomes[${JSON.stringify(id)}], instancePresent: !!app.plugins.plugins[${JSON.stringify(id)}] })`);
    report.criteria.normalBootInitializes = report.facts.boot.outcome?.ok === true && report.facts.boot.instancePresent;
    if (report.criteria.normalBootInitializes) {
      // FileManager rename waits for metadata processing; boot-scan alone
      // does not mean a large vault has finished indexing.
      if (!await wait('!!app.metadataCache && app.metadataCache.initialized === true')) throw new Error('metadata cache did not initialize');
      const facts = await evaluate(`(${exerciseTemplater.toString()})(${JSON.stringify(root)})`);
      report.facts.features = facts;
      report.criteria.dateTemplate = facts.date === '2026-10-24';
      report.criteria.stringAndJavascriptTemplate = facts.strings === 'HELLO|2,4,6';
      report.criteria.noteMetadata = facts.file === `Input|${root}/Input.md|true`;
      report.criteria.createNote = facts.created?.path === root + '/Created.md' && facts.created.text === 'Made SAFELY' &&
        fs.readFileSync(path.join(args.vault, root, 'Created.md'), 'utf8') === 'Made SAFELY';
      report.criteria.renameNote = facts.renamed.path === root + '/Renamed.md' && facts.renamed.text === 'Original' &&
        fs.readFileSync(path.join(args.vault, root, 'Renamed.md'), 'utf8') === 'Original' && !fs.existsSync(path.join(args.vault, root, 'Input.md'));
      report.criteria.javascriptUserScripts = facts.userScript === 'Hi Browser|Original';
      report.criteria.systemCommandExplicitlyDenied = facts.shell.denied === true &&
        /child_process|server.side|shell/i.test(facts.shell.message + ' ' + facts.shell.detail);
      report.criteria.noShellSideEffect = facts.shellArtifact === false && !fs.existsSync(path.join(args.vault, root, 'SHELL_MUST_NOT_EXIST'));
      report.criteria.templateWorksAfterDenial = facts.afterDenial === 'still works';
      report.criteria.noFatalOverlay = await evaluate(`document.getElementById('myobs-fatal').hidden`);
    }
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
  report.passed = Object.keys(report.criteria).length === 12 && Object.values(report.criteria).every(Boolean);
  const output = JSON.stringify(report, null, 2);
  if (args.json) fs.writeFileSync(args.json, output + '\n');
  console.log(output);
  if (!report.passed) process.exitCode = 1;
}
main().catch(error => { console.error('templater-check failed:', error.message); process.exitCode = 2; });
