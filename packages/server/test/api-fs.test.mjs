import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildApp } from '../src/index.js';

/** @type {string} */
let root;
/** @type {string} */
let realRoot;
/** @type {string} */
let outside;
/** @type {import('fastify').FastifyInstance} */
let app;

async function writeFixture(relativePath, contents) {
  const absolute = path.join(root, relativePath);
  await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
  await fs.promises.writeFile(absolute, contents);
}

/**
 * @param {string} op
 * @param {string} [relativePath]
 * @param {object} [args]
 */
async function call(op, relativePath = '', args) {
  const payload = { op, path: relativePath };
  if (args !== undefined) payload.args = args;
  const response = await app.inject({
    method: 'POST',
    url: '/api/fs',
    payload,
  });
  assert.equal(response.statusCode, 200, `HTTP status for ${op}: ${response.body}`);
  return response.json();
}

async function ok(op, relativePath = '', args) {
  const body = await call(op, relativePath, args);
  assert.equal(body.ok, true, `${op} failed: ${JSON.stringify(body)}`);
  return body.result;
}

async function failure(op, relativePath = '', args) {
  const body = await call(op, relativePath, args);
  assert.equal(body.ok, false, `${op} unexpectedly succeeded: ${JSON.stringify(body)}`);
  return body.error;
}

before(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'myobs-api-'));
  realRoot = await fs.promises.realpath(root);
  outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'myobs-outside-'));

  await writeFixture('notes/a.md', 'hello 世界\n');
  await writeFixture('notes/b.txt', 'bee');
  await fs.promises.mkdir(path.join(root, 'empty-dir'), { recursive: true });
  await fs.promises.writeFile(
    path.join(root, 'binary.bin'),
    Buffer.from([0x00, 0xff, 0x10, 0x41]),
  );
  await fs.promises.writeFile(path.join(outside, 'secret.txt'), 'outside secret');
  await fs.promises.symlink(outside, path.join(root, 'out-link'));

  app = await buildApp({
    vaultPath: root,
    watch: false,
    termsAccepted: true,
    authToken: '',
  });
});

after(async () => {
  if (app) await app.close();
  await fs.promises.rm(root, { recursive: true, force: true });
  await fs.promises.rm(outside, { recursive: true, force: true });
});

describe('read / readBinary', () => {
  it('reads utf8 text', async () => {
    assert.equal(await ok('read', 'notes/a.md'), 'hello 世界\n');
  });

  it('reports EISDIR for a directory', async () => {
    const error = await failure('read', 'notes');
    assert.equal(error.code, 'EISDIR');
  });

  it('reports ENOENT for a missing file', async () => {
    const error = await failure('read', 'notes/nope.md');
    assert.equal(error.code, 'ENOENT');
  });

  it('round-trips binary data as base64', async () => {
    const read = await ok('readBinary', 'binary.bin');
    assert.deepEqual(Buffer.from(read.base64, 'base64'), Buffer.from([0x00, 0xff, 0x10, 0x41]));
  });
});

describe('write family', () => {
  it('writes text and returns the real mtime and size', async () => {
    const result = await ok('write', 'notes/new.md', { data: 'one' });
    assert.equal(result.size, 3);
    assert.ok(result.mtimeMs > 0);
    assert.equal(await fs.promises.readFile(path.join(root, 'notes/new.md'), 'utf8'), 'one');

    const stat = await ok('stat', 'notes/new.md');
    assert.equal(stat.mtimeMs, result.mtimeMs);
    assert.equal(stat.size, 3);
    assert.equal(result.conflictSavedAs, undefined);
  });

  it('overwrites without ifMtimeMs', async () => {
    await ok('write', 'notes/new.md', { data: 'two' });
    assert.equal(await ok('read', 'notes/new.md'), 'two');
  });

  it('writes binary data', async () => {
    const bytes = Buffer.from([0xde, 0xad, 0x00, 0xbe, 0xef]);
    const result = await ok('writeBinary', 'notes/bytes.bin', {
      base64: bytes.toString('base64'),
    });
    assert.equal(result.size, bytes.length);
    const read = await ok('readBinary', 'notes/bytes.bin');
    assert.deepEqual(Buffer.from(read.base64, 'base64'), bytes);
  });

  it('appends text and binary data', async () => {
    await ok('write', 'notes/append.txt', { data: 'a' });
    await ok('append', 'notes/append.txt', { data: 'b' });
    assert.equal(await ok('read', 'notes/append.txt'), 'ab');

    await ok('writeBinary', 'notes/append.bin', { base64: Buffer.from([1]).toString('base64') });
    await ok('appendBinary', 'notes/append.bin', {
      base64: Buffer.from([2, 3]).toString('base64'),
    });
    const read = await ok('readBinary', 'notes/append.bin');
    assert.deepEqual(Buffer.from(read.base64, 'base64'), Buffer.from([1, 2, 3]));
  });

  it('rejects a missing data field with EINVAL', async () => {
    const error = await failure('write', 'notes/bad.md', {});
    assert.equal(error.code, 'EINVAL');
  });
});

describe('conditional writes / conflict copy', () => {
  it('creates a conflict copy when ifMtimeMs is stale, preserving old content', async () => {
    await ok('write', 'notes/race.md', { data: 'old' });
    const stat = await ok('stat', 'notes/race.md');

    const result = await ok('write', 'notes/race.md', {
      data: 'new',
      ifMtimeMs: stat.mtimeMs - 1000,
    });

    assert.equal(typeof result.conflictSavedAs, 'string');
    assert.match(result.conflictSavedAs, /^notes\/race\.conflict-\d+\.md$/);
    assert.equal(await ok('read', 'notes/race.md'), 'new');
    assert.equal(await ok('read', result.conflictSavedAs), 'old');
  });

  it('does not create a conflict copy when ifMtimeMs matches', async () => {
    await ok('write', 'notes/race2.md', { data: 'same' });
    const stat = await ok('stat', 'notes/race2.md');
    const result = await ok('write', 'notes/race2.md', {
      data: 'changed',
      ifMtimeMs: stat.mtimeMs,
    });
    assert.equal(result.conflictSavedAs, undefined);
    assert.equal(await ok('read', 'notes/race2.md'), 'changed');
  });

  it('allocates a distinct name for a second conflict in the same millisecond', async () => {
    await ok('write', 'notes/race3.md', { data: 'v1' });
    const first = await ok('write', 'notes/race3.md', {
      data: 'v2',
      ifMtimeMs: 1,
    });
    const second = await ok('write', 'notes/race3.md', {
      data: 'v3',
      ifMtimeMs: 1,
    });
    assert.notEqual(first.conflictSavedAs, second.conflictSavedAs);
    assert.equal(await ok('read', first.conflictSavedAs), 'v1');
    assert.equal(await ok('read', second.conflictSavedAs), 'v2');
  });
});

describe('exists / access / stat', () => {
  it('exists is true only for reachable paths', async () => {
    assert.equal(await ok('exists', 'notes/a.md'), true);
    assert.equal(await ok('exists', 'notes/missing.md'), false);
    assert.equal(await ok('exists', ''), true);
  });

  it('access returns null or ENOENT', async () => {
    assert.equal(await ok('access', 'notes/a.md'), null);
    assert.equal((await failure('access', 'notes/missing.md')).code, 'ENOENT');
  });

  it('stat returns null for a missing path', async () => {
    assert.equal(await ok('stat', 'notes/missing.md'), null);
  });

  it('stat distinguishes files and folders', async () => {
    const file = await ok('stat', 'notes/a.md');
    assert.equal(file.type, 'file');
    assert.equal(file.size, Buffer.byteLength('hello 世界\n'));
    assert.ok(file.mtimeMs > 0);
    assert.ok(file.ctimeMs > 0);
    assert.equal(file.realpath, path.join(realRoot, 'notes/a.md'));

    const folder = await ok('stat', 'notes');
    assert.equal(folder.type, 'folder');
  });

  it('stat resolves symlinks for type and realpath', async () => {
    await fs.promises.symlink('a.md', path.join(root, 'notes/a-link.md'));
    const result = await ok('stat', 'notes/a-link.md');
    assert.equal(result.type, 'file');
    assert.equal(result.realpath, await fs.promises.realpath(path.join(root, 'notes/a.md')));
    assert.equal(result.size, Buffer.byteLength('hello 世界\n'));
  });

  it('stat on the vault root is a folder', async () => {
    const result = await ok('stat', '');
    assert.equal(result.type, 'folder');
    assert.equal(result.realpath, await fs.promises.realpath(root));
  });
});

describe('list', () => {
  before(async () => {
    await writeFixture('listing/a.md', 'a');
    await writeFixture('listing/b.txt', 'b');
    await writeFixture('listing/sub/c.md', 'c');
    await fs.promises.symlink('sub', path.join(root, 'listing/sub-link'));
    await fs.promises.symlink('a.md', path.join(root, 'listing/file-link.md'));
  });

  it('returns single-level names without paths', async () => {
    const result = await ok('list', 'listing');
    assert.deepEqual(result.files, ['a.md', 'b.txt', 'file-link.md']);
    assert.deepEqual(result.folders, ['sub']);
    for (const name of [...result.files, ...result.folders]) {
      assert.equal(name.includes('/'), false);
    }
    assert.equal(result.files.includes('c.md'), false);
  });

  it('does not follow directory symlinks', async () => {
    const result = await ok('list', 'listing');
    assert.equal(result.folders.includes('sub-link'), false);
  });

  it('lists the vault root including .obsidian if present', async () => {
    await fs.promises.mkdir(path.join(root, '.obsidian'), { recursive: true });
    const result = await ok('list', '');
    assert.equal(result.folders.includes('.obsidian'), true);
  });

  it('reports ENOTDIR when listing a file', async () => {
    assert.equal((await failure('list', 'notes/a.md')).code, 'ENOTDIR');
  });
});

describe('mkdir / rmdir / remove / rename / copy', () => {
  it('mkdir is recursive and idempotent', async () => {
    assert.equal(await ok('mkdir', 'deep/a/b'), null);
    assert.equal(await ok('mkdir', 'deep/a/b'), null);
    assert.equal((await ok('stat', 'deep/a/b')).type, 'folder');
  });

  it('mkdir on an existing file is EEXIST', async () => {
    assert.equal((await failure('mkdir', 'notes/a.md')).code, 'EEXIST');
  });

  it('renames a file', async () => {
    await ok('write', 'notes/rename-me.md', { data: 'x' });
    assert.equal(await ok('rename', 'notes/rename-me.md', { to: 'notes/renamed.md' }), null);
    assert.equal(await ok('read', 'notes/renamed.md'), 'x');
    assert.equal(await ok('exists', 'notes/rename-me.md'), false);
  });

  it('copies a file', async () => {
    assert.equal(await ok('copy', 'notes/renamed.md', { to: 'notes/copied.md' }), null);
    assert.equal(await ok('read', 'notes/copied.md'), 'x');
  });

  it('copies a directory recursively', async () => {
    assert.equal(await ok('copy', 'deep', { to: 'deep-copy' }), null);
    assert.equal((await ok('stat', 'deep-copy/a/b')).type, 'folder');
  });

  it('remove deletes a file and reports EISDIR for a directory', async () => {
    assert.equal(await ok('remove', 'notes/copied.md'), null);
    assert.equal(await ok('exists', 'notes/copied.md'), false);
    assert.equal((await failure('remove', 'deep')).code, 'EISDIR');
  });

  it('rmdir requires an empty directory unless recursive', async () => {
    assert.equal((await failure('rmdir', 'deep')).code, 'ENOTEMPTY');
    assert.equal(await ok('rmdir', 'deep/a/b'), null);
    assert.equal(await ok('rmdir', 'deep/a'), null);
    assert.equal(await ok('rmdir', 'deep'), null);
    await ok('mkdir', 'empty-again');
    assert.equal(await ok('rmdir', 'empty-again'), null);
  });

  it('refuses to remove the vault root', async () => {
    assert.equal((await failure('rmdir', '')).code, 'EPERM');
    assert.equal((await failure('remove', '')).code, 'EPERM');
  });

  it('refuses to copy a directory into itself', async () => {
    await ok('mkdir', 'self-copy');
    assert.equal((await failure('copy', 'self-copy', { to: 'self-copy/inside' })).code, 'EPERM');
  });
});

describe('utimes / realpath', () => {
  it('sets mtime (and accepts an ignored ctimeMs)', async () => {
    await ok('write', 'times.md', { data: 'x' });
    const target = 1_700_000_000_123;
    assert.equal(
      await ok('utimes', 'times.md', { mtimeMs: target, ctimeMs: target }),
      null,
    );
    const stat = await ok('stat', 'times.md');
    assert.ok(Math.abs(stat.mtimeMs - target) < 2, `mtime ${stat.mtimeMs}`);
  });

  it('rejects a non-numeric mtimeMs', async () => {
    assert.equal((await failure('utimes', 'times.md', { mtimeMs: 'nope' })).code, 'EINVAL');
  });

  it('returns vault-relative real paths', async () => {
    assert.equal(await ok('realpath', ''), '');
    assert.equal(await ok('realpath', 'notes/a.md'), 'notes/a.md');
    assert.equal(await ok('realpath', 'notes/a-link.md'), 'notes/a.md');
  });

  it('realpath of a missing path is ENOENT', async () => {
    assert.equal((await failure('realpath', 'missing-real.md')).code, 'ENOENT');
  });
});

describe('path containment', () => {
  it('rejects ../ escapes', async () => {
    assert.equal((await failure('read', '../outside-secret.txt')).code, 'EPERM');
    assert.equal((await failure('list', 'notes/../..')).code, 'EPERM');
    assert.equal(
      (await failure('rename', 'notes/a.md', { to: '../moved.md' })).code,
      'EPERM',
    );
  });

  it('rejects absolute paths', async () => {
    assert.equal((await failure('read', '/etc/passwd')).code, 'EPERM');
    assert.equal(
      (await failure('write', path.join(outside, 'x.txt'), { data: 'x' })).code,
      'EPERM',
    );
  });

  it('rejects symlink escapes for read, write and list', async () => {
    assert.equal((await failure('read', 'out-link/secret.txt')).code, 'EPERM');
    assert.equal((await failure('list', 'out-link')).code, 'EPERM');
    assert.equal(
      (await failure('write', 'out-link/evil.txt', { data: 'evil' })).code,
      'EPERM',
    );
    assert.equal(fs.existsSync(path.join(outside, 'evil.txt')), false);
  });

  it('rejects symlinks that point outside the vault', async () => {
    await fs.promises.symlink(path.join(outside, 'secret.txt'), path.join(root, 'outside-file.md'));
    assert.equal((await failure('read', 'outside-file.md')).code, 'EPERM');
    assert.equal((await failure('stat', 'outside-file.md')).code, 'EPERM');
  });

  it('rejects an escaping destination', async () => {
    assert.equal(
      (await failure('copy', 'notes/a.md', { to: '/tmp/escaped-copy.md' })).code,
      'EPERM',
    );
  });
});

describe('unknown operations', () => {
  it('returns EUNKNOWN instead of crashing Fastify', async () => {
    const error = await failure('frobnicate', 'notes/a.md');
    assert.equal(error.code, 'EUNKNOWN');
  });
});

describe('/v/*', () => {
  let appWithTerms;
  let vaultRoot;

  before(async () => {
    vaultRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'myobs-v-'));
    await fs.promises.mkdir(path.join(vaultRoot, 'assets'), { recursive: true });
    await fs.promises.writeFile(path.join(vaultRoot, 'assets/a b.txt'), '0123456789');
    appWithTerms = await buildApp({
      vaultPath: vaultRoot,
      watch: false,
      termsAccepted: true,
      authToken: '',
    });
  });

  after(async () => {
    if (appWithTerms) await appWithTerms.close();
    await fs.promises.rm(vaultRoot, { recursive: true, force: true });
  });

  function urlFor(relativePath) {
    return `/v/${encodeURI(path.join(vaultRoot, relativePath).slice(1))}`;
  }

  it('serves a vault file', async () => {
    const response = await appWithTerms.inject({
      method: 'GET',
      url: urlFor('assets/a b.txt'),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, '0123456789');
    assert.equal(response.headers['accept-ranges'], 'bytes');
    assert.equal(response.headers['cache-control'], 'no-cache');
    assert.ok(response.headers['last-modified']);
    assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
  });

  it('supports Range requests', async () => {
    const response = await appWithTerms.inject({
      method: 'GET',
      url: urlFor('assets/a b.txt'),
      headers: { range: 'bytes=2-4' },
    });
    assert.equal(response.statusCode, 206);
    assert.equal(response.body, '234');
    assert.equal(response.headers['content-range'], 'bytes 2-4/10');
    assert.equal(response.headers['content-length'], '3');
  });

  it('supports open-ended and suffix ranges', async () => {
    const open = await appWithTerms.inject({
      method: 'GET',
      url: urlFor('assets/a b.txt'),
      headers: { range: 'bytes=7-' },
    });
    assert.equal(open.statusCode, 206);
    assert.equal(open.body, '789');

    const suffix = await appWithTerms.inject({
      method: 'GET',
      url: urlFor('assets/a b.txt'),
      headers: { range: 'bytes=-2' },
    });
    assert.equal(suffix.statusCode, 206);
    assert.equal(suffix.body, '89');
  });

  it('returns 416 for an unsatisfiable range', async () => {
    const response = await appWithTerms.inject({
      method: 'GET',
      url: urlFor('assets/a b.txt'),
      headers: { range: 'bytes=50-' },
    });
    assert.equal(response.statusCode, 416);
    assert.equal(response.headers['content-range'], 'bytes */10');
  });

  it('supports HEAD with metadata', async () => {
    const response = await appWithTerms.inject({
      method: 'HEAD',
      url: urlFor('assets/a b.txt'),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-length'], '10');
    assert.equal(response.body, '');
  });

  it('PUT writes a large-file upload unconditionally', async () => {
    const body = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff]);
    const response = await appWithTerms.inject({
      method: 'PUT',
      url: urlFor('assets/upload.bin'),
      headers: { 'content-type': 'application/octet-stream' },
      payload: body,
    });
    assert.equal(response.statusCode, 204);
    assert.deepEqual(await fs.promises.readFile(path.join(vaultRoot, 'assets/upload.bin')), body);
  });

  it('returns 403 outside the vault', async () => {
    const response = await appWithTerms.inject({
      method: 'GET',
      url: '/v/etc/hosts',
    });
    assert.equal(response.statusCode, 403);
  });

  it('returns 404 for a missing vault file', async () => {
    const response = await appWithTerms.inject({
      method: 'GET',
      url: urlFor('assets/missing.bin'),
    });
    assert.equal(response.statusCode, 404);
  });
});

describe('auth', () => {
  let authApp;
  let authRoot;

  before(async () => {
    authRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'myobs-auth-'));
    await fs.promises.writeFile(path.join(authRoot, 'note.md'), 'secret');
    authApp = await buildApp({
      vaultPath: authRoot,
      watch: false,
      termsAccepted: true,
      authToken: 's3cret-token',
    });
  });

  after(async () => {
    if (authApp) await authApp.close();
    await fs.promises.rm(authRoot, { recursive: true, force: true });
  });

  it('rejects requests without the cookie', async () => {
    const response = await authApp.inject({
      method: 'POST',
      url: '/api/fs',
      payload: { op: 'read', path: 'note.md' },
    });
    assert.equal(response.statusCode, 401);
  });

  it('rejects a wrong cookie', async () => {
    const response = await authApp.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: 'myobs_token=nope' },
    });
    assert.equal(response.statusCode, 401);
  });

  it('accepts the matching cookie for API, page and static assets', async () => {
    const cookie = 'foo=1; myobs_token=s3cret-token';
    const api = await authApp.inject({
      method: 'POST',
      url: '/api/fs',
      headers: { cookie },
      payload: { op: 'read', path: 'note.md' },
    });
    assert.equal(api.statusCode, 200);
    assert.equal(api.json().result, 'secret');

    const page = await authApp.inject({ method: 'GET', url: '/', headers: { cookie } });
    assert.equal(page.statusCode, 200);

    const asset = await authApp.inject({
      method: 'GET',
      url: '/obsidian/whatever.js',
      headers: { cookie },
    });
    // Auth passes; the vendor file is simply absent in this fixture.
    assert.equal(asset.statusCode, 404);
  });
});

describe('boot injection and static assets', () => {
  let staticApp;
  let runtimeDir;
  let vendorDir;
  let staticRoot;
  let runtimePath;

  before(async () => {
    const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'myobs-static-'));
    staticRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'myobs-static-vault-'));
    runtimeDir = path.join(base, 'runtime');
    vendorDir = path.join(base, 'vendor');
    await fs.promises.mkdir(path.join(vendorDir, 'lib'), { recursive: true });
    await fs.promises.mkdir(runtimeDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(vendorDir, 'app.js'),
      'window.__OBSIDIAN_APP__ = true;\n',
    );
    await fs.promises.writeFile(
      path.join(vendorDir, 'lib', 'worker.js'),
      '/* worker */\n',
    );
    runtimePath = path.join(runtimeDir, 'index.html');
    await fs.promises.writeFile(
      runtimePath,
      '<!doctype html><html><head><!-- MYOBS_BOOT --><script src="/obsidian/app.js"></script></head><body></body></html>',
    );

    staticApp = await buildApp({
      vaultPath: staticRoot,
      watch: false,
      termsAccepted: true,
      // Deliberately not the real terms string: it must never live in the repo.
      termsText: 'acknowledged-by-operator',
      vendorDir,
      runtimeIndexPath: runtimePath,
      authToken: '',
    });
  });

  after(async () => {
    if (staticApp) await staticApp.close();
    if (staticRoot) await fs.promises.rm(staticRoot, { recursive: true, force: true });
    // base is the parent of runtimeDir/vendorDir
    if (runtimeDir) {
      await fs.promises.rm(path.dirname(runtimeDir), { recursive: true, force: true });
    }
  });

  it('injects window.__MYOBS before the app script', async () => {
    const response = await staticApp.inject({ method: 'GET', url: '/' });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /window\.__MYOBS = \{/);

    const bootMatch = /window\.__MYOBS = (\{.*?\});<\/script>/s.exec(response.body);
    assert.ok(bootMatch, 'boot JSON not found');
    const boot = JSON.parse(bootMatch[1]);
    assert.equal(boot.vaultPath, await fs.promises.realpath(staticRoot));
    assert.equal(boot.vaultName, path.basename(staticRoot));
    assert.equal(boot.resourcesPath, '/obsidian');
    assert.equal(boot.resourcePrefix, '/v/');
    assert.equal(boot.termsAccepted, true);
    assert.equal(boot.termsText, 'acknowledged-by-operator');
    assert.equal(boot.platform, process.platform);
    assert.equal(boot.arch, process.arch);
    assert.equal(boot.policy && typeof boot.policy, 'object');
    assert.equal(typeof boot.version, 'string');
    assert.equal(typeof boot.build, 'string');
    assert.ok(boot.documentsDir.endsWith('Documents'));
    assert.ok(boot.desktopDir.endsWith('Desktop'));

    assert.ok(
      response.body.indexOf('window.__MYOBS') < response.body.indexOf('/obsidian/app.js'),
      'boot must appear before app.js is loaded',
    );
  });

  it('serves vendor files with the right content types', async () => {
    const appJs = await staticApp.inject({ method: 'GET', url: '/obsidian/app.js' });
    assert.equal(appJs.statusCode, 200);
    assert.equal(appJs.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(appJs.body, 'window.__OBSIDIAN_APP__ = true;\n');

    const worker = await staticApp.inject({ method: 'GET', url: '/obsidian/lib/worker.js' });
    assert.equal(worker.statusCode, 200);
    assert.equal(worker.headers['content-type'], 'text/javascript; charset=utf-8');
  });

  it('explains how to fetch missing vendor assets', async () => {
    const response = await staticApp.inject({
      method: 'GET',
      url: '/obsidian/missing.js',
    });
    assert.equal(response.statusCode, 404);
    assert.match(response.body, /fetch-obsidian\.mjs/);
  });

  it('does not allow vendor traversal', async () => {
    const response = await staticApp.inject({
      method: 'GET',
      url: '/obsidian/..%2f..%2fetc%2fpasswd',
    });
    assert.equal(response.statusCode, 404);
  });

  it('blocks app.js and shows an explanation without TERMS_ACK', async () => {
    const noTerms = await buildApp({
      vaultPath: staticRoot,
      watch: false,
      termsAccepted: false,
      vendorDir,
      runtimeIndexPath: runtimePath,
      authToken: '',
    });
    try {
      const page = await noTerms.inject({ method: 'GET', url: '/' });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /TERMS_ACK/);
      assert.doesNotMatch(page.body, /window\.__MYOBS/);

      const appJs = await noTerms.inject({ method: 'GET', url: '/obsidian/app.js' });
      assert.equal(appJs.statusCode, 403);
      assert.match(appJs.body, /TERMS_ACK/);
    } finally {
      await noTerms.close();
    }
  });
});
