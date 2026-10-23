import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertDevModeHost,
  isLoopbackHost,
  readTermsFromVendor,
} from '../src/consent.js';

test('readTermsFromVendor extracts the literal immediately before the terms gate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myobs-dev-terms-'));
  try {
    const value = `test-ack-${'x'.repeat(80)}`;
    fs.writeFileSync(
      path.join(dir, 'app.js'),
      `var host={ipcRenderer:{sendSync:function(c){return "${value}"}}};` +
        `host.ipcRenderer.sendSync("terms")`,
    );
    assert.equal(readTermsFromVendor(dir), value);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readTermsFromVendor refuses a truncated literal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myobs-dev-terms-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'app.js'),
      'var a="short";a.ipcRenderer.sendSync("terms")',
    );
    assert.throws(() => readTermsFromVendor(dir), /truncated/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dev mode host guard is loopback-only', () => {
  for (const host of ['127.0.0.1', '127.0.0.2', 'localhost', '::1', ' LOCALHOST ']) {
    assert.equal(isLoopbackHost(host), true, host);
    assert.doesNotThrow(() => assertDevModeHost(host));
  }
  for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com', '']) {
    assert.equal(isLoopbackHost(host), false, host);
    assert.throws(() => assertDevModeHost(host), /只允許 loopback/);
  }
});
