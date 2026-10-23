import assert from 'node:assert/strict';
import { EventEmitter as NodeEventEmitter } from 'node:events';
import fs from 'node:fs';
import test from 'node:test';
import { promisify as nodePromisify } from 'node:util';
import vm from 'node:vm';

function loadShim() {
  const warnings = [];
  const context = vm.createContext({
    console: { warn: (value) => warnings.push(value) },
    TextEncoder, TextDecoder, setTimeout, clearTimeout, btoa, atob,
  });
  context.window = context;
  for (const file of ['node-globals-shim.js', 'require-shim.js']) {
    vm.runInContext(fs.readFileSync(new URL(`../../shim/src/${file}`, import.meta.url), 'utf8'), context);
  }
  return { context, require: context.require, warnings };
}

test('require and resolve share node aliases and built-in subpaths', () => {
  const { context, require } = loadShim();
  const promises = { readFile() {} };
  const posix = {};
  const win32 = {};
  context.__MYOBS_MODULES.fs = { promises };
  context.__MYOBS_MODULES.path = { posix, win32 };
  for (const name of ['util', 'buffer', 'events', 'querystring']) {
    assert.equal(require(`node:${name}`), require(name));
    assert.equal(require.resolve(`node:${name}`), `node:${name}`);
  }
  for (const [name, expected] of [['fs/promises', promises], ['path/posix', posix], ['path/win32', win32]]) {
    assert.equal(require(name), expected);
    assert.equal(require(`node:${name}`), expected);
    assert.equal(require.resolve(name), name);
    assert.equal(require.resolve(`node:${name}`), `node:${name}`);
  }
});

test('require and resolve refuse privileged modules and unsupported builtin subpaths consistently', () => {
  const { require } = loadShim();
  for (const load of [require, require.resolve]) {
    for (const name of ['child_process/promises', 'node:net', 'worker_threads', 'https']) {
      assert.throws(() => load(name), { code: 'MODULE_NOT_SUPPORTED', moduleName: name, reason: 'server-side-module' });
    }
    for (const name of ['stream', 'node:stream/web', 'node:util/types']) {
      assert.throws(() => load(name), { code: 'MODULE_NOT_SUPPORTED', moduleName: name, reason: 'node-builtin' });
    }
    for (const name of ['native-addon.node', './helper.js', '__proto__', 'toString']) {
      assert.throws(() => load(name), (error) => error.code === 'MODULE_NOT_SUPPORTED' && error.reason === undefined);
    }
    for (const name of [null, undefined, '', 5, {}]) {
      assert.throws(() => load(name), { code: 'MODULE_NOT_SUPPORTED', name: 'TypeError' });
    }
  }
});

test('Buffer unsigned integer reads and writes match Node at nonzero offsets', () => {
  const BufferShim = loadShim().require('buffer').Buffer;
  const bytes = [0xaa, 0x01, 0x23, 0x89, 0xef, 0xbb];
  for (const suffix of ['8', '16LE', '16BE', '32LE', '32BE']) {
    const native = Buffer.from(bytes);
    const shim = BufferShim.from(bytes);
    assert.equal(shim[`readUInt${suffix}`](1), native[`readUInt${suffix}`](1), `readUInt${suffix}`);
    const value = suffix === '8' ? 0xf1 : suffix.startsWith('16') ? 0x89ef : 0xf12389ef;
    assert.equal(shim[`writeUInt${suffix}`](value, 1), native[`writeUInt${suffix}`](value, 1));
    assert.deepEqual(Array.from(shim), Array.from(native), `writeUInt${suffix}`);
    assert.equal(shim[`readUInt${suffix}`](1), value);
  }
});

test('EventEmitter export supports direct construction and util.inherits', () => {
  const { require } = loadShim();
  const EventEmitter = require('events');
  assert.equal(EventEmitter.EventEmitter, EventEmitter);
  function Bus() { EventEmitter.call(this); }
  require('util').inherits(Bus, EventEmitter);
  const bus = new Bus();
  let value;
  assert.equal(bus.on('value', (next) => { value = next; }), bus);
  assert.equal(bus.emit('value', 42), true);
  assert.equal(value, 42);
  assert.equal(bus.emit('missing'), false);
});

function orderingScenario(EventEmitter) {
  const emitter = new EventEmitter();
  const trace = [];
  emitter.on('value', function (a, b) { trace.push(['tail', this === emitter, a, b]); });
  emitter.prependListener('value', () => trace.push(['head']));
  emitter.once('value', () => trace.push(['once']));
  emitter.prependOnceListener('value', () => trace.push(['first']));
  emitter.emit('value', 3, 7);
  emitter.emit('value', 5, 9);
  return trace;
}

test('EventEmitter listener order, once, prepend and this match Node', () => {
  assert.deepEqual(orderingScenario(loadShim().require('events')), orderingScenario(NodeEventEmitter));
});

function mutationScenario(EventEmitter) {
  const emitter = new EventEmitter();
  const trace = [];
  function second() { trace.push('second'); }
  emitter.on('value', () => {
    trace.push('first');
    emitter.off('value', second);
    emitter.on('value', () => trace.push('later'));
  });
  emitter.on('value', second);
  emitter.emit('value');
  emitter.emit('value');
  return trace;
}

test('EventEmitter snapshots listeners during emission like Node', () => {
  assert.deepEqual(mutationScenario(loadShim().require('events')), mutationScenario(NodeEventEmitter));
});

test('EventEmitter once cannot fire twice through recursive emission or raw wrapper calls', () => {
  const EventEmitter = loadShim().require('events');
  const emitter = new EventEmitter();
  let calls = 0;
  function listener() { calls++; emitter.emit('value'); }
  emitter.once('value', listener);
  const raw = emitter.rawListeners('value')[0];
  assert.equal(raw.listener, listener);
  assert.equal(emitter.listeners('value')[0], listener);
  raw();
  raw();
  assert.equal(calls, 1);
  assert.equal(emitter.listenerCount('value'), 0);
});

test('EventEmitter listener introspection and removal preserve symbol names and duplicate ordering', () => {
  const EventEmitter = loadShim().require('events');
  const emitter = new EventEmitter();
  const name = Symbol('event');
  function listener() {}
  emitter.on(name, listener).once(name, listener);
  assert.deepEqual(Array.from(emitter.eventNames()), [name]);
  assert.equal(EventEmitter.listenerCount(emitter, name), 2);
  assert.equal(emitter.listenerCount(name, listener), 2);
  emitter.listeners(name).pop();
  assert.equal(emitter.listenerCount(name), 2);
  emitter.removeListener(name, listener);
  assert.equal(emitter.rawListeners(name)[0], listener);
  emitter.off(name, listener);
  assert.equal(emitter.eventNames().length, 0);
});

function metaScenario(EventEmitter) {
  const emitter = new EventEmitter();
  const trace = [];
  emitter.on('newListener', (name, listener) => trace.push(['add', name, listener.name, emitter.listenerCount(name)]));
  emitter.on('removeListener', (name, listener) => trace.push(['remove', name, (listener.listener || listener).name, emitter.listenerCount(name)]));
  function first() {}
  function second() {}
  emitter.on('ready', first).once('ready', second);
  emitter.removeAllListeners();
  return trace;
}

test('EventEmitter meta events and removeAllListeners ordering match Node', () => {
  assert.deepEqual(metaScenario(loadShim().require('events')), metaScenario(NodeEventEmitter));
});

test('EventEmitter newListener additions precede the pending listener', () => {
  const EventEmitter = loadShim().require('events');
  const emitter = new EventEmitter();
  const trace = [];
  emitter.once('newListener', (name) => {
    if (name === 'value') emitter.on(name, () => trace.push('inserted'));
  });
  emitter.on('value', () => trace.push('pending'));
  emitter.emit('value');
  assert.deepEqual(trace, ['inserted', 'pending']);
});

test('EventEmitter throws unhandled errors and propagates listener exceptions', () => {
  const EventEmitter = loadShim().require('events');
  const emitter = new EventEmitter();
  const failure = new Error('plugin failed');
  assert.throws(() => emitter.emit('error', failure), (error) => error === failure);
  assert.throws(() => emitter.emit('error', 'failure'), { code: 'ERR_UNHANDLED_ERROR', context: 'failure' });
  let handled;
  emitter.on('error', (error) => { handled = error; });
  assert.equal(emitter.emit('error', failure), true);
  assert.equal(handled, failure);
  emitter.on('value', () => { throw failure; });
  assert.throws(() => emitter.emit('value'), (error) => error === failure);
});

test('EventEmitter validates listeners and warns once when max listeners is exceeded', () => {
  const { require, warnings } = loadShim();
  const EventEmitter = require('events');
  const emitter = new EventEmitter();
  assert.equal(emitter.getMaxListeners(), 10);
  EventEmitter.defaultMaxListeners = 2;
  assert.equal(emitter.getMaxListeners(), 2);
  emitter.setMaxListeners(1);
  for (let i = 0; i < 3; i++) emitter.on('value', () => {});
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].name, 'MaxListenersExceededWarning');
  assert.equal(warnings[0].emitter, emitter);
  assert.equal(warnings[0].count, 2);
  for (const method of ['on', 'once', 'prependListener', 'prependOnceListener', 'off']) {
    assert.throws(() => emitter[method]('value', null), { code: 'ERR_INVALID_ARG_TYPE' });
  }
  for (const value of [-1, NaN, '2']) assert.throws(() => emitter.setMaxListeners(value), { code: 'ERR_OUT_OF_RANGE' });
  assert.throws(() => new EventEmitter({ captureRejections: true }), { code: 'MODULE_NOT_SUPPORTED', moduleName: 'events' });
});

test('promisify interoperates with the shared Node custom symbol and is idempotent', async () => {
  const promisify = loadShim().require('util').promisify;
  assert.equal(promisify.custom, nodePromisify.custom);
  function original() { throw new Error('must use custom'); }
  original[Symbol.for('nodejs.util.promisify.custom')] = async () => 42;
  const custom = promisify(original);
  assert.equal(custom, original[nodePromisify.custom]);
  assert.equal(await custom(), 42);
  assert.equal(promisify(custom), custom);
  const wrapped = promisify((callback) => callback(null, 'wrapped'));
  assert.equal(promisify(wrapped), wrapped);
  assert.equal(await wrapped(), 'wrapped');
});

test('promisify preserves receiver and rejects callback or synchronous errors', async () => {
  const promisify = loadShim().require('util').promisify;
  const receiver = { base: 3, method(value, callback) { callback(null, this.base + value, 'ignored'); } };
  assert.equal(await promisify(receiver.method).call(receiver, 4), 7);
  const failure = new Error('failed');
  await assert.rejects(promisify((callback) => callback(failure))(), (error) => error === failure);
  await assert.rejects(promisify(() => { throw failure; })(), (error) => error === failure);
});

test('promisify rejects invalid originals and custom overrides synchronously', () => {
  const promisify = loadShim().require('util').promisify;
  for (const value of [null, undefined, 1, {}]) {
    assert.throws(() => promisify(value), { code: 'ERR_INVALID_ARG_TYPE' });
  }
  function original() {}
  original[promisify.custom] = {};
  assert.throws(() => promisify(original), { code: 'ERR_INVALID_ARG_TYPE' });
});
