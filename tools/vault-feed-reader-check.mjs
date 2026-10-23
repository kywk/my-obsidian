#!/usr/bin/env node
/** Exercise the installed, unmodified Feed Reader against a same-origin RSS fixture. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Cdp, assertNotLiveVault, evalInPage, launchChrome, newPage,
  readTermsFromVendor, startServer, waitForPage } from './lib/cdp.mjs';

const args = { vault: null, port: 3801, timeout: 90, json: null };
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, '');
  if (!Object.hasOwn(args, key) || process.argv[i + 1] === undefined) throw new Error('Usage: --vault <copy> [--port 3801] [--timeout 90] [--json <report>]');
  args[key] = process.argv[++i];
}
args.port = Number(args.port);
args.timeout = Number(args.timeout);
if (!args.vault || !Number.isInteger(args.port) || args.port < 1 || args.port > 64535 || !Number.isFinite(args.timeout) || args.timeout <= 0) throw new Error('A vault copy, valid port and positive timeout are required');
args.vault = assertNotLiveVault(args.vault);
if (args.json) args.json = assertNotLiveVault(args.json);
const id = 'vault-feed-reader';
const dir = path.join(args.vault, '.obsidian/plugins', id);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
if (manifest.id !== id || manifest.version !== '0.6.1') throw new Error('This acceptance harness requires the installed Vault Feed Reader 0.6.1');
const hashes = () => Object.fromEntries(['main.js', 'manifest.json', 'styles.css'].filter(name => fs.existsSync(path.join(dir, name))).map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')]));
const originalHashes = hashes();
const root = '_myobs_feed_fixture';
if ([root, '_myobs_feed_assets'].some(name => fs.existsSync(path.join(args.vault, name)))) throw new Error('Use a fresh copy: the feed fixture directory already exists');
fs.mkdirSync(path.join(args.vault, '_myobs_feed_assets'));
// Isolate test preferences so copied subscriptions and local-agent settings never run.
fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ rootFolder: root, subscriptionsPath: `${root}/feeds.yaml`, savedArticlesFolder: `${root}/Articles`, language: 'en' }));
fs.writeFileSync(path.join(args.vault, '.obsidian/community-plugins.json'), JSON.stringify([id]));
const rssPath = '_myobs_feed_assets/fixture.xml';
fs.writeFileSync(path.join(args.vault, rssPath), '<?xml version="1.0"?><rss version="2.0"><channel><title>MyObs Feed Fixture</title><link>https://example.invalid/</link><description>Fixture</description><item><guid>myobs-feed-fixture</guid><title>MyObs Fixture Article</title><link>https://example.invalid/article</link><description><![CDATA[<p>Fixture article body for no-shell support.</p>]]></description><pubDate>Fri, 23 Oct 2026 00:00:00 GMT</pubDate></item></channel></rss>');
const htmlPath = '_myobs_feed_assets/article.html';
fs.writeFileSync(path.join(args.vault, htmlPath), '<!doctype html><html><head><title>Original fixture article</title></head><body><article><h1>Original fixture article</h1>' + '<p>Original fixture paragraph describes a browser reader that saves subscriptions, articles, and reading state without executing local programs. This is controlled acceptance content with enough detail for article extraction.</p>'.repeat(8) + '</article></body></html>');
const report = { kind: 'vault-feed-reader', version: manifest.version, vault: args.vault, criteria: {}, facts: { networkScope: 'Same-origin RSS fixture via real requestUrl; arbitrary external feeds and CORS are not covered.' } };
let server, chrome, cdp;
try {
  server = await startServer(args.vault, args.port, readTermsFromVendor());
  chrome = await launchChrome(args.port + 1000);
  cdp = new Cdp(chrome.wsUrl); await cdp.connect();
  const { sessionId } = await newPage(cdp);
  const ev = expression => evalInPage(cdp, sessionId, expression);
  const wait = expression => waitForPage(cdp, sessionId, expression, args.timeout * 1000);
  await cdp.send('Runtime.enable', {}, sessionId);
  const url = `http://127.0.0.1:${args.port}/`;
  const reload = async () => {
    const previous = await ev('window.__MYOBS?.sessionToken').catch(() => null);
    await cdp.send('Page.navigate', { url }, sessionId);
    if (!await wait(`!!window.app && !!window.__MYOBS && window.__MYOBS.sessionToken !== ${JSON.stringify(previous)}`)) throw new Error('Renderer boot timeout');
  };
  await reload();
  await ev('localStorage.setItem("enable-plugin-"+app.appId,"true")');
  await reload();
  const plugin = `app.plugins.plugins[${JSON.stringify(id)}]`;
  if (!await wait(`!!window.__MYOBS_PLUGIN_WATCH?.outcomes[${JSON.stringify(id)}]`)) throw new Error('Plugin outcome timeout');
  if (!await wait(`app.metadataCache.initialized && !!app.vault.getAbstractFileByPath(${JSON.stringify(rssPath)})`)) throw new Error('Vault indexing did not finish');
  if (!await wait('__MYOBS_PLUGIN_WATCH.events.some(e=>e.action==="boot-scan")')) throw new Error('Plugin boot scan did not finish');
  report.facts.boot = await ev(`(()=>{const p=${plugin};const state=p?.subscriptions?.getSnapshot();return {loaded:!!p&&window.__MYOBS_PLUGIN_WATCH.outcomes[${JSON.stringify(id)}].ok===true,writable:state?.writable===true,error:state?.error?.message,cause:state?.error?.cause?.message}})()`);
  report.criteria.initialization = report.facts.boot.loaded && report.facts.boot.writable;
  if (!report.criteria.initialization) throw new Error('Feed Reader initialization failed');
  report.facts.roundTrip = await ev(`(async()=>{
    const p=${plugin};
    const folder=await p.subscriptions.createFolder('Fixture Folder');
    const feed=await p.subscriptions.addFeed({url:new URL(app.vault.adapter.getResourcePath(${JSON.stringify(rssPath)}),location.href).href,title:'MyObs Feed Fixture',folderIds:[folder.id]});
    await p.subscriptions.renameFolder(folder.id,'Fixture Renamed');
    await p.reconcileTail;
    const exported=p.subscriptions.export('opml');
    await p.subscriptions.import(exported,'opml','merge');
    await p.refreshFeeds([feed]);
    const items=(await p.cache.queryMetadata({feedId:feed.id})).items;
    const article=items[0]&&await p.cache.getArticle(feed.id,items[0].id);
    window.__myobsFeedFixture={feed,article};
    const doc=p.subscriptions.getSnapshot().document;
    return {feedId:feed.id,articleId:article?.id,subscribed:doc.feeds.length===1&&doc.feeds[0].folderIds.includes(folder.id),folderRenamed:doc.folders.some(f=>f.id===folder.id&&f.title==='Fixture Renamed'),opml:exported.includes('<opml')&&exported.includes('MyObs Feed Fixture'),article:article?.title==='MyObs Fixture Article'&&article.contentHtml.includes('Fixture article body'),errors:Array.from(p.feedErrors.values())};
  })()`);
  const round = report.facts.roundTrip;
  report.criteria.subscriptionsAndFolders = round.subscribed && round.folderRenamed;
  report.criteria.opmlRoundTrip = round.opml;
  report.criteria.rssRequestParseAndCache = round.article && round.errors.length === 0;
  if (!round.article) throw new Error('RSS did not produce the fixture article');
  await ev(`(async()=>{const p=${plugin};await p.openReader();await p.openManagerLeaf()})()`);
  report.criteria.readerAndManagerViews = await wait(`['sources','articles','manage'].every(s=>app.workspace.getLeavesOfType('vault-feed-reader-'+s).some(l=>l.view.contentEl.textContent.includes(s==='articles'?'MyObs Fixture Article':'MyObs Feed Fixture')))`);
  report.facts.saved = await ev(`(async()=>{const p=${plugin};const {feed,article}=window.__myobsFeedFixture;const result=await p.saves.save(article,feed);const file=app.vault.getAbstractFileByPath(result.note.path);const content=await app.vault.read(file);const read=await p.readState.markRead(feed.id,article.id);await p.openSavedArticle(article);return {path:file.path,content:content.includes('Fixture article body')&&content.includes('MyObs Fixture Article'),read:read.ok&&read.state.readIds.includes(article.id)}})()`);
  report.criteria.articleSavedToMarkdown = report.facts.saved.content && fs.readFileSync(path.join(args.vault, report.facts.saved.path), 'utf8').includes('Fixture article body');
  const readState = JSON.parse(fs.readFileSync(path.join(args.vault, root, 'state', `${round.feedId}.json`), 'utf8'));
  report.criteria.readStatePersisted = report.facts.saved.read && readState.readIds.includes(round.articleId);
  report.facts.fullText = await ev(String.raw`(async()=>{const p=${plugin};const source=new URL(app.vault.adapter.getResourcePath(${JSON.stringify(htmlPath)}),location.href).href;const file=await app.vault.create(${JSON.stringify(`${root}/full-text.md`)},'---\nurl: '+JSON.stringify(source)+'\n---\n# Full text fixture\n');await p.enrichment.run(file,'fetch');return {path:file.path,extracted:(await app.vault.read(file)).includes('Original fixture paragraph')}})()`);
  report.criteria.originalFullTextExtracted = report.facts.fullText.extracted && fs.readFileSync(path.join(args.vault, report.facts.fullText.path), 'utf8').includes('Original fixture paragraph');
  report.facts.summary = await ev(`(async()=>{const p=${plugin};const file=app.vault.getAbstractFileByPath(${JSON.stringify(`${root}/full-text.md`)});const before=await app.vault.read(file);const agent={id:'myobs-unavailable',kind:'codex',name:'Unavailable fixture agent',command:'myobs-unavailable-agent',args:''};let rejected=false,message;try{await p.enrichment.test(agent)}catch(error){rejected=true;message=error.message}p.enrichment.local={agents:[agent],defaultId:agent.id,detected:[]};await p.enrichment.run(file,'summarize');return {rejected,message,commandErrorVisible:[...document.querySelectorAll('.notice')].some(el=>el.textContent.includes('Unavailable fixture agent')),unchanged:before===await app.vault.read(file)}})()`);
  report.criteria.localAgentSummaryFailsWithoutWriting = report.facts.summary.rejected && report.facts.summary.commandErrorVisible && report.facts.summary.unchanged;
  report.criteria.shellExecutionRefused = await ev(`(()=>{try{require('node:child_process').spawn('myobs-unavailable-agent',[]);return false}catch(e){return e.code==='MODULE_NOT_SUPPORTED'&&e.reason==='server-side-module'&&e.operation==='spawn'}})()`);
  await reload();
  if (!await wait(`!!${plugin} && window.__MYOBS_PLUGIN_WATCH?.outcomes[${JSON.stringify(id)}]?.ok === true`)) throw new Error('Reloaded plugin failed');
  if (!await wait(`app.metadataCache.initialized && __MYOBS_PLUGIN_WATCH.events.some(e=>e.action==='boot-scan') && ${plugin}.subscriptions.getSnapshot().writable && ${plugin}.subscriptions.getSnapshot().document.feeds.some(f=>f.id===${JSON.stringify(round.feedId)})`)) throw new Error('Reloaded subscription state did not settle');
  await wait(`${plugin}.saves.isSaved(${JSON.stringify(round.feedId)},${JSON.stringify(round.articleId)})`);
  report.facts.persisted = await ev(`(async()=>{const p=${plugin};const feed=p.subscriptions.getSnapshot().document.feeds.find(f=>f.id===${JSON.stringify(round.feedId)});const article=await p.cache.getArticle(${JSON.stringify(round.feedId)},${JSON.stringify(round.articleId)});const read=await p.readState.load(${JSON.stringify(round.feedId)});return {writable:p.subscriptions.getSnapshot().writable,subscription:!!feed,cache:article?.title==='MyObs Fixture Article',read:read.ok&&read.state.readIds.includes(${JSON.stringify(round.articleId)}),saved:p.saves.isSaved(${JSON.stringify(round.feedId)},${JSON.stringify(round.articleId)})}})()`);
  report.criteria.survivesRendererReload = Object.values(report.facts.persisted).every(Boolean);
  report.criteria.noFatalOverlay = await ev('(()=>{const e=document.getElementById("myobs-fatal");return !e||e.hidden||getComputedStyle(e).display==="none"})()');
} catch (error) { report.error = error.stack || String(error); }
finally { cdp?.close(); chrome?.child.kill(); server?.child.kill(); }
report.criteria.originalPluginUnmodified = JSON.stringify(hashes()) === JSON.stringify(originalHashes);
report.passed = !report.error && Object.keys(report.criteria).length === 13 && Object.values(report.criteria).every(Boolean);
if (args.json) fs.writeFileSync(args.json, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
