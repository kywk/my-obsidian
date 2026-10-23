import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../shim/src/watch-shim.js', import.meta.url), 'utf8');

function setup(token = 'tab-a') {
  const sockets = [], errors = [], callbacks = [], notifications = [];
  class WebSocket {
    constructor(url) { this.url = url; sockets.push(this); }
  }
  const window = { __MYOBS: { sessionToken: token, vaultPath: '/vault', platform: 'darwin' } };
  vm.runInNewContext(source, {
    window, WebSocket, location: { protocol: 'http:', host: '127.0.0.1:3000' },
    console: { error: (...args) => errors.push(args), warn() {} },
    setTimeout() { throw new Error('Unexpected reconnect timer'); }, clearTimeout() {},
  });
  const api = window.__MYOBS_WATCH;
  api.watch('/vault', { recursive: true }, (type, filename, event) => callbacks.push({ type, filename, ...event }));
  api.subscribe(event => notifications.push({ ...event }));
  assert.equal(sockets.length, 1);
  sockets[0].onopen();
  const send = events => sockets[0].onmessage({ data: JSON.stringify({ type: 'change', events }) });
  return { api, callbacks, notifications, errors, send };
}
const change = (path, extra = {}) => ({ path, kind: 'change', mtimeMs: 100, size: 4, ...extra });
const own = path => change(path, { originToken: 'tab-a' });

for (const order of ['own-first', 'external-first']) {
  test(`same-path external change reaches both consumers when ${order}`, () => {
    const h = setup(), external = change('notes/same.md', { mtimeMs: 101, size: 9 });
    h.send(order === 'own-first' ? [own('notes/same.md'), external] : [external, own('notes/same.md')]);
    assert.deepEqual(h.callbacks, [{ type: 'change', filename: 'notes/same.md', ...external }]);
    assert.deepEqual(h.notifications, [external]);
    assert.equal(h.api.state.received, 2);
    assert.equal(h.api.state.filtered, 1);
    assert.equal(h.api.state.dispatched, 1);
    assert.deepEqual(h.errors, []);
  });
}

test('a later writer in another tab is delivered for the same path and batch', () => {
  const h = setup();
  h.send([own('same.md'), change('same.md', { originToken: 'tab-b', mtimeMs: 102 })]);
  assert.deepEqual(h.notifications, [change('same.md', { mtimeMs: 102 })]);
  assert.equal(h.callbacks.length, 1);
  assert.equal(h.api.state.filtered, 1);
});

test('each tab suppresses only its own token for a shared batch', () => {
  const a = setup('tab-a'), b = setup('tab-b');
  const events = [own('a.md'), change('b.md', { originToken: 'tab-b' }), change('external.md')];
  a.send(events); b.send(events);
  assert.deepEqual(a.callbacks.map(e => e.filename), ['b.md', 'external.md']);
  assert.deepEqual(b.callbacks.map(e => e.filename), ['a.md', 'external.md']);
  assert.equal(a.api.state.filtered, 1);
  assert.equal(b.api.state.filtered, 1);
});

test('own create/change echoes remain suppressed in later batches without consuming provenance', () => {
  const h = setup();
  h.send([{ ...own('.obsidian/plugins/probe/data.json'), kind: 'create' }]);
  h.send([own('.obsidian/plugins/probe/data.json')]);
  h.send([own('.obsidian/plugins/probe/data.json')]);
  assert.deepEqual(h.callbacks, []);
  assert.deepEqual(h.notifications, []);
  assert.equal(h.api.state.filtered, 3);
  h.send([change('.obsidian/plugins/probe/data.json')]);
  assert.equal(h.callbacks.length, 1);
  assert.equal(h.notifications.length, 1);
});

test('external reload followed by its own saves converges without another reload', () => {
  const h = setup(), path = '.obsidian/plugins/probe/data.json';
  let reloads = 0;
  const echoes = [];
  h.api.subscribe(event => {
    if (event.path !== path) return;
    reloads++;
    echoes.push(own(path), own(path));
  });
  h.send([own(path), change(path, { mtimeMs: 103 })]);
  assert.equal(reloads, 1);
  while (echoes.length) {
    assert.ok(reloads < 3, 'own save must not enter an unbounded reload loop');
    h.send([echoes.shift()]);
  }
  assert.equal(reloads, 1);
  assert.equal(h.callbacks.length, 1);
  assert.equal(h.api.state.filtered, 3);
  assert.deepEqual(h.errors, []);
});

test('filtering preserves watcher-relative paths and external create/delete kinds', () => {
  const h = setup(), nested = [];
  h.api.watch('/vault/notes', {}, (type, filename) => nested.push({ type, filename }));
  h.send([own('notes/ours.md'), change('notes/new.md', { kind: 'create' }), change('notes/deleted.md', { kind: 'delete' }), change('notes-old/external.md')]);
  assert.deepEqual(nested, [{ type: 'rename', filename: 'new.md' }, { type: 'rename', filename: 'deleted.md' }]);
  assert.deepEqual(h.callbacks.map(e => e.filename), ['notes/new.md', 'notes/deleted.md', 'notes-old/external.md']);
  assert.equal(h.api.state.dispatched, 5);
});

test('missing session token cannot suppress external events with missing or empty tokens', () => {
  const h = setup('');
  h.send([change('a.md'), change('b.md', { originToken: '' }), own('c.md')]);
  assert.equal(h.notifications.length, 3);
  assert.equal(h.callbacks.length, 3);
  assert.equal(h.api.state.filtered, 0);
});
