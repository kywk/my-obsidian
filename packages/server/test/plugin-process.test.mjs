import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function fixture() {
  const notices = [], io = [];
  const context = vm.createContext({
    console, TextEncoder, TextDecoder, setTimeout, clearTimeout, btoa, atob,
    fetch: (...args) => { io.push(args); throw new Error('unexpected network'); },
    __MYOBS_NOTICES: { push: value => notices.push(value) },
  });
  context.window = context;
  for (const name of ['node-globals-shim.js', 'require-shim.js']) {
    vm.runInContext(fs.readFileSync(new URL(`../../shim/src/${name}`, import.meta.url), 'utf8'), context);
  }
  return { context, notices, io };
}

test('plugins can import child_process without starting a process or notifying', () => {
  const { context, notices, io } = fixture();
  const module = context.require('child_process');
  assert.equal(module, context.require('node:child_process'));
  assert.equal(context.require.resolve('node:child_process'), 'node:child_process');
  assert.ok(Object.isFrozen(module));
  assert.deepEqual(notices, []);
  assert.deepEqual(io, []);
});

test('every child_process execution entry throws a named refusal without evaluating arguments', () => {
  const { context, notices, io } = fixture();
  const module = context.require('child_process');
  const names = ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork', 'ChildProcess', '_forkChild'];
  const hostile = { toString() { throw new Error('argument evaluated'); } };
  let callbackCalled = false;
  for (const name of names) {
    assert.throws(() => module[name](hostile, { get env() { throw new Error('options evaluated'); } }, () => { callbackCalled = true; }),
      { code: 'MODULE_NOT_SUPPORTED', moduleName: 'child_process', reason: 'server-side-module', operation: name });
  }
  assert.throws(() => new module.ChildProcess(), { code: 'MODULE_NOT_SUPPORTED' });
  assert.equal(callbackCalled, false);
  assert.equal(notices.length, names.length + 1);
  assert.deepEqual(io, []);
});

test('promisified child_process operations reject instead of returning empty success', async () => {
  const { context, io } = fixture();
  const module = context.require('child_process');
  const util = context.require('util');
  for (const name of ['exec', 'execFile']) {
    await assert.rejects(util.promisify(module[name])('never-run'), {
      code: 'MODULE_NOT_SUPPORTED', operation: name,
    });
  }
  assert.deepEqual(io, []);
});

test('refusal notices and errors never include commands, arguments or environment secrets', () => {
  const { context, notices } = fixture();
  const secret = 'PRIVATE-COMMAND-ARGUMENT';
  assert.throws(() => context.require('child_process').exec(secret, { env: { TOKEN: secret } }), error => {
    assert.equal(error.message.includes(secret), false);
    assert.ok(error.message.includes('child_process.exec'));
    return true;
  });
  assert.equal(JSON.stringify(notices).includes(secret), false);
  assert.equal(notices[0].dedupeKey, 'capability:child_process:exec');
});

test('missing or failing notification UI cannot turn execution refusal into another error', () => {
  const { context } = fixture();
  for (const value of [undefined, { push() { throw new Error('notice failed'); } }]) {
    context.__MYOBS_NOTICES = value;
    assert.throws(() => context.require('child_process').spawn('never-run'), {
      code: 'MODULE_NOT_SUPPORTED', operation: 'spawn',
    });
  }
});

test('child_process facade does not open other privileged modules or unsupported subpaths', () => {
  const { context } = fixture();
  for (const name of ['net', 'node:tls', 'http', 'https', 'worker_threads', 'child_process/promises']) {
    for (const load of [context.require, context.require.resolve]) {
      assert.throws(() => load(name), { code: 'MODULE_NOT_SUPPORTED', reason: 'server-side-module' });
    }
  }
});
