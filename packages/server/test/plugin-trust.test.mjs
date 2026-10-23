import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../../shim/src/boot-data.js', import.meta.url), 'utf8');
function fixture({ values = [], boot = {}, storageError = false } = {}) {
  const stored = new Map(values), warnings = [], writes = [];
  const context = vm.createContext({
    console: { error() {}, warn: message => warnings.push(message) },
    document: { getElementById: () => null },
    __MYOBS: {
      vaultId: 'selected-vault', vaultName: 'Display name', vaultPath: '/vault',
      resourcesPath: '/obsidian', resourcePrefix: '/v/', version: '1.14.4',
      build: '1.14.4', platform: 'darwin', arch: 'arm64', documentsDir: '/documents',
      desktopDir: '/desktop', policy: { plugins: true }, termsAccepted: true,
      termsText: 'Unit test acknowledgement placeholder', sessionToken: 'unit-token', ...boot,
    },
    localStorage: {
      getItem: key => stored.has(key) ? stored.get(key) : null,
      setItem: (key, value) => {
        if (storageError) throw new Error('storage unavailable');
        writes.push([key, value]); stored.set(key, value);
      },
    },
  });
  context.window = context;
  return { context, stored, warnings, writes, run: () => vm.runInContext(source, context) };
}

test('fresh vault is trusted before renderer creates the app or asks to load plugins', () => {
  const f = fixture(); f.run();
  assert.equal(f.context.app, undefined);
  assert.equal(f.stored.get('enable-plugin-selected-vault'), 'true');
  assert.equal(f.context.__MYOBS_BOOT_OK, true);
});

test('startup reapplies the requested trust policy after restricted mode was previously saved', () => {
  const f = fixture({ values: [['enable-plugin-selected-vault', 'false']] }); f.run();
  assert.equal(f.stored.get('enable-plugin-selected-vault'), 'true');
});

test('trust selection uses the IPC vault id and leaves other vault preferences intact', () => {
  const f = fixture({ values: [['enable-plugin-another-vault', 'false'], ['theme', 'dark']] }); f.run();
  assert.equal(f.stored.get('enable-plugin-selected-vault'), 'true');
  assert.equal(f.stored.has('enable-plugin-Display name'), false);
  assert.equal(f.stored.get('enable-plugin-another-vault'), 'false');
  assert.equal(f.stored.get('theme'), 'dark');
  assert.equal(f.stored.size, 3);
});

test('already trusted vault keeps the same stored value without changing plugin policy', () => {
  const f = fixture({ values: [['enable-plugin-selected-vault', 'true']], boot: { policy: { plugins: false } } });
  f.run();
  assert.equal(f.stored.get('enable-plugin-selected-vault'), 'true');
  assert.equal(f.context.__MYOBS.policy.plugins, false);
});

test('invalid boot data does not change trust before the existing boot gate rejects it', () => {
  const f = fixture({ boot: { vaultId: '' } });
  assert.throws(f.run, { code: 'MYOBS_BOOT_DATA_INVALID' });
  assert.deepEqual(f.writes, []);
});

test('unavailable browser storage is reported without turning trust setup into a boot crash', () => {
  const f = fixture({ storageError: true });
  assert.doesNotThrow(f.run);
  assert.equal(f.context.__MYOBS_BOOT_OK, true);
  assert.equal(f.warnings.length, 1);
  assert.ok(f.warnings[0].includes('localStorage'));
});
