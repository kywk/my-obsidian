import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../runtime/plugin-watch.js', import.meta.url), 'utf8');

function setup(manager, descriptor) {
  let now = 0, next = 0, event, settings = false;
  const timers = new Map(), cards = new Map();
  const window = {
    __MYOBS: { policy: { plugins: true } },
    __MYOBS_WATCH: { subscribe(fn) { event = fn; return () => {}; } },
    __MYOBS_NOTICES: {
      push(card) { cards.set(card.dedupeKey, { ...card, id: card.dedupeKey }); },
      list() { return [...cards.values()]; },
      dismiss(id) { cards.delete(id); },
    },
  };
  if (descriptor) Object.defineProperty(window, 'app', descriptor);
  const add = (fn, delay, repeat) => { const id = ++next; timers.set(id, { fn, at: now + delay, delay, repeat }); return id; };
  const context = vm.createContext({ window, console, WeakSet, Promise,
    Date: { now: () => now }, localStorage: { getItem: () => null },
    document: { querySelector: () => settings ? {} : null },
    setTimeout: (fn, delay) => add(fn, delay, false),
    setInterval: (fn, delay) => add(fn, delay, true),
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
  });
  vm.runInContext(source, context);
  if (!descriptor) window.app = { plugins: manager, workspace: { layoutReady: true } };
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const tick = async (ms) => {
    const end = now + ms;
    while (true) {
      const item = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a,b) => a[1].at - b[1].at)[0];
      if (!item) break;
      const [id,t] = item; now = t.at;
      if (t.repeat) t.at += t.delay; else timers.delete(id);
      t.fn(); await flush();
    }
    now = end; await flush();
  };
  return { window, cards, tick, flush, setSettings: value => { settings = value; }, emit: file => event({ path: `.obsidian/plugins/probe/${file}` }), api: window.__MYOBS_PLUGIN_WATCH };
}
function manager() {
  return {
    enabledPlugins: new Set(['probe']), plugins: {}, manifests: { probe: {} },
    isEnabled: () => true, loadManifests: async () => {},
    async enablePlugin(id) { this.plugins[id] = {}; return true; },
    async disablePlugin(id, user) { this.userDisabled = user; delete this.plugins[id]; },
    async disablePluginAndSave(id) { this.enabledPlugins.delete(id); delete this.plugins[id]; },
  };
}

test('first boot attempt observes false despite a retained loaded instance', async () => {
  const p = manager();
  p.enablePlugin = async function(id) { this.plugins[id] = { _loaded: true }; return false; };
  const h = setup(p);
  assert.equal(await p.enablePlugin('probe'), false);
  await h.tick(4000);
  assert.equal(h.api.outcomes.probe.ok, false);
  assert.ok(h.cards.has('plugin:probe'));
  assert.ok(h.api.events.some(e => e.id === 'probe' && e.action === 'boot' && !e.ok));
  const descriptor = Object.getOwnPropertyDescriptor(h.window, 'app');
  assert.equal(descriptor.writable, true);
  assert.equal(descriptor.get, undefined);
});

test('app accessor owned by another runtime stays intact', async () => {
  const p = manager(), app = { plugins: p, workspace: { layoutReady: true } };
  const get = () => app;
  const h = setup(p, { get, configurable: true, enumerable: false });
  assert.equal(Object.getOwnPropertyDescriptor(h.window, 'app').get, get);
  await p.enablePlugin('probe');
  assert.equal(h.api.outcomes.probe.ok, true);
});

test('overlapping manual reloads serialize and coalesce a trailing refresh', async () => {
  const p = manager(); let release, count = 0, concurrent = 0, maximum = 0;
  p.enablePlugin = async function(id) {
    count++; maximum = Math.max(maximum, ++concurrent);
    if (count === 1) await new Promise(resolve => { release = resolve; });
    this.plugins[id] = { generation: count }; concurrent--; return true;
  };
  const h = setup(p);
  const first = h.api.reloadAll(); await h.flush();
  const second = h.api.reloadAll(), third = h.api.reloadAll(); await h.flush();
  assert.equal(count, 1); release(); await Promise.all([first, second, third]);
  assert.equal(count, 2); assert.equal(maximum, 1);
  assert.equal(p.plugins.probe.generation, 2);
  assert.equal(p.userDisabled, undefined);
});

test('watch reload waits for another reload then applies newest disk state', async () => {
  const p = manager(); let release, count = 0;
  p.enablePlugin = async function(id) {
    count++;
    if (count === 1) await new Promise(resolve => { release = resolve; });
    this.plugins[id] = {}; return true;
  };
  const h = setup(p); await h.tick(100);
  const first = h.api.reloadAll(); await h.flush();
  h.emit('main.js'); await h.tick(500); h.emit('styles.css'); await h.tick(500);
  assert.equal(count, 1); release(); await first;
  assert.equal(count, 2);
});

test('swallowed unload failure cannot be mistaken for a successful reload', async () => {
  const p = manager(); let loads = 0;
  p.plugins.probe = {}; p.disablePlugin = async () => {};
  p.enablePlugin = async () => { loads++; return true; };
  const h = setup(p); await h.api.reloadAll();
  assert.equal(loads, 0);
  assert.ok(h.api.events.some(e => e.action === 'reload' && !e.ok && e.error.includes('卸載未完成')));
});

test('disable during unload prevents resurrection', async () => {
  const p = manager(); let loads = 0;
  p.disablePlugin = async function(id) { this.enabledPlugins.delete(id); delete this.plugins[id]; };
  p.enablePlugin = async () => { loads++; return true; };
  const h = setup(p); await h.api.reloadAll();
  assert.equal(loads, 0); assert.equal(p.enabledPlugins.has('probe'), false);
});

test('repair reload clears failure card and retains enabled preference', async () => {
  const q = manager(); let broken = true;
  q.enablePlugin = async function(id) { this.plugins[id] = {}; return !broken; };
  const k = setup(q); await q.enablePlugin('probe'); await k.tick(4000);
  broken = false; await k.api.reloadAll();
  assert.equal(k.api.outcomes.probe.ok, true);
  assert.equal(k.cards.has('plugin:probe'), false);
  assert.equal(q.enabledPlugins.has('probe'), true);
});

test('disabled plugin changes only refresh manifest inventory', async () => {
  const p = manager(); p.enabledPlugins.clear(); let loads = 0;
  p.enablePlugin = async () => { loads++; return true; };
  const h = setup(p); await h.tick(100); h.emit('main.js'); await h.tick(500);
  assert.equal(loads, 0); assert.ok(h.api.events.some(e => e.action === 'manifest'));
});


test('manager assigned after async app setup is observed before its first load', async () => {
  const h = setup(null);
  const p = manager();
  p.enablePlugin = async function(id) { this.plugins[id] = { _loaded: true }; return false; };
  h.window.app.plugins = p;
  assert.equal(await p.enablePlugin('probe'), false);
  await h.tick(4000);
  assert.equal(h.api.outcomes.probe.ok, false);
  assert.ok(h.cards.has('plugin:probe'));
  assert.equal(Object.getOwnPropertyDescriptor(h.window.app, 'plugins').get, undefined);
});


test('queued watch work honors a disabled watch flag before it runs', async () => {
  const p = manager(); let release, count = 0;
  p.enablePlugin = async function(id) {
    count++;
    if (count === 1) await new Promise(resolve => { release = resolve; });
    this.plugins[id] = {}; return true;
  };
  const h = setup(p); await h.tick(100);
  const first = h.api.reloadAll(); await h.flush();
  h.emit('main.js'); await h.tick(500);
  h.api.enabled = false; release(); await first;
  assert.equal(count, 1);
});

test('queued data refresh defers if settings opened while another load ran', async () => {
  const p = manager(); let release, count = 0;
  p.enablePlugin = async function(id) {
    count++;
    if (count === 1) await new Promise(resolve => { release = resolve; });
    this.plugins[id] = {}; return true;
  };
  const h = setup(p); await h.tick(100);
  const first = h.api.reloadAll(); await h.flush();
  h.emit('data.json'); await h.tick(500);
  h.setSettings(true); release(); await first;
  assert.equal(count, 1);
  h.setSettings(false); await h.tick(500);
  assert.equal(count, 2);
});
