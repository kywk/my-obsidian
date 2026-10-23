import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { buildApp } from '../src/index.js';

const shimDir = new URL('../../shim/src/', import.meta.url);
const sources = await Promise.all(['node-globals-shim.js', 'fs-shim.js'].map(
  name => fs.readFile(new URL(name, shimDir), 'utf8'),
));

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myobs-plugin-fs-'));
  const root = await fs.realpath(dir);
  const app = await buildApp({ vaultPath: root, watch: false, logger: false, configPath: path.join(root, 'config.json') });
  t.after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  const requests = [];
  const context = vm.createContext({
    console, TextEncoder, TextDecoder, URL, atob, btoa, queueMicrotask, setTimeout, clearTimeout,
    __MYOBS: { vaultPath: root, resourcesPath: '/obsidian', platform: 'linux', sessionToken: 'plugin-fs-test' },
    fetch: async (url, init) => {
      if (url.startsWith('/obsidian/')) return new Response(new Uint8Array([65, 0, 255]));
      const payload = JSON.parse(init.body);
      requests.push(payload);
      const response = await app.inject({ method: init.method, url, payload });
      return new Response(response.body, { status: response.statusCode });
    },
  });
  vm.runInContext('window = globalThis', context);
  for (const source of sources) vm.runInContext(source, context);
  return { root, context, shim: context.__MYOBS_MODULES.fs, requests };
}

function call(shim, name, ...args) {
  return new Promise((resolve, reject) => {
    assert.equal(shim[name](...args, (error, value) => error ? reject(error) : resolve(value)), undefined);
  });
}

test('plugin binary read returns the browser Buffer for vault and static resources', async t => {
  const { root, shim, context } = await fixture(t);
  await fs.writeFile(path.join(root, 'bytes.bin'), new Uint8Array([65, 0, 255]));
  for (const target of [path.join(root, 'bytes.bin'), '/obsidian/probe.bin']) {
    for (const value of [await shim.promises.readFile(target), await call(shim, 'readFile', target)]) {
      assert.equal(context.Buffer.isBuffer(value), true);
      assert.equal(value.toString('hex'), '4100ff');
    }
  }
});

test('plugin callback fs supports encoded read, write and append through the real API', async t => {
  const { root, shim, requests } = await fixture(t);
  await call(shim, 'writeFile', path.join(root, 'note.md'), '台灣', 'utf8');
  await call(shim, 'appendFile', path.join(root, 'note.md'), '外掛');
  assert.equal(await call(shim, 'readFile', path.join(root, 'note.md'), { encoding: 'utf8' }), '台灣外掛');
  assert.equal(await fs.readFile(path.join(root, 'note.md'), 'utf8'), '台灣外掛');
  assert.ok(requests.filter(r => ['write', 'append'].includes(r.op)).every(r => r.args.token === 'plugin-fs-test'));
});

test('plugin callback fs composes directory, metadata, copy, rename and removal operations', async t => {
  const { root, shim } = await fixture(t);
  await call(shim, 'mkdir', path.join(root, 'notes'), { recursive: true });
  await call(shim, 'writeFile', path.join(root, 'notes/a.md'), 'abc');
  await call(shim, 'copyFile', path.join(root, 'notes/a.md'), path.join(root, 'notes/b.md'));
  await call(shim, 'rename', path.join(root, 'notes/b.md'), path.join(root, 'notes/c.md'));
  const entries = await call(shim, 'readdir', path.join(root, 'notes'), { withFileTypes: true });
  assert.deepEqual(Array.from(entries, e => e.name).sort(), ['a.md', 'c.md']);
  assert.ok(entries.every(e => e.isFile()));
  assert.equal((await call(shim, 'stat', path.join(root, 'notes/c.md'))).size, 3);
  await call(shim, 'access', path.join(root, 'notes/c.md'));
  await call(shim, 'unlink', path.join(root, 'notes/a.md'));
  await call(shim, 'rm', path.join(root, 'notes'), { recursive: true });
  await assert.rejects(fs.stat(path.join(root, 'notes')), { code: 'ENOENT' });
});

test('plugin callback fs rejects a missing callback before scheduling a mutation', async t => {
  const { root, shim, requests } = await fixture(t);
  assert.throws(() => shim.writeFile(path.join(root, 'must-not-exist'), 'x'), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.equal(requests.length, 0);
});

test('plugin callback fs reports an asynchronous failure exactly once', async t => {
  const { root, shim } = await fixture(t);
  let calls = 0;
  let synchronous = true;
  const done = new Promise(resolve => shim.readFile(path.join(root, 'missing'), error => {
    calls++;
    assert.equal(synchronous, false);
    assert.equal(error.code, 'ENOENT');
    resolve();
  }));
  synchronous = false;
  await done;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('plugin callback fs preserves confinement and offline write refusal', async t => {
  const { root, shim, context, requests } = await fixture(t);
  await assert.rejects(call(shim, 'readFile', path.join(root, '../outside')), { code: 'ENOENT' });
  context.__MYOBS_RESILIENCE = { online: false };
  await assert.rejects(call(shim, 'writeFile', path.join(root, 'blocked'), 'x'), { code: 'EOFFLINE' });
  assert.equal(requests.length, 0);
  await assert.rejects(fs.stat(path.join(root, 'blocked')), { code: 'ENOENT' });
});

test('plugin fs.exists checks uncached disk state and keeps its boolean callback', async t => {
  const { root, shim } = await fixture(t);
  const target = path.join(root, 'external.md');
  assert.equal(shim.existsSync(target), false);
  await fs.writeFile(target, 'created externally');
  assert.equal(await new Promise(resolve => shim.exists(target, resolve)), true);
  await fs.unlink(target);
  assert.equal(await new Promise(resolve => shim.exists(target, resolve)), false);
});

test('plugin fs.exists exposes the standard promisify custom hook', async t => {
  const { root, shim } = await fixture(t);
  const custom = shim.exists[Symbol.for('nodejs.util.promisify.custom')];
  assert.equal(await custom(path.join(root, 'missing')), false);
  await fs.writeFile(path.join(root, 'exists'), 'yes');
  assert.equal(await custom(path.join(root, 'exists')), true);
});
