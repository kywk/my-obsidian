import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import { buildApp } from '../src/index.js';
import { handleFsRequest } from '../src/fs-api.js';
import { openVault } from '../src/paths.js';
import { clearOriginTokens, createVaultWatcher, captureOriginVersion, hashOriginContent, runOriginMutation } from '../src/watch.js';

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'myobs-origin-version-'));
  const vault = await openVault(root);
  const events = [];
  clearOriginTokens();
  const watcher = createVaultWatcher({ vaultPath: root, debounceMs: 60_000, onEvents: batch => events.push(...batch) });
  try {
    await watcher.ready;
    const api = async (op, file, args = {}) => {
      const result = await handleFsRequest(vault, { op, path: file, args });
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.result;
    };
    const event = async (file, kind = 'change') => {
      watcher.watcher.emit(kind === 'delete' ? 'unlink' : kind === 'create' ? 'add' : 'change', file);
      await watcher.flush();
      return events.filter(item => item.path === file).at(-1);
    };
    await run({ root, vault, api, event });
  } finally {
    await watcher.close();
    clearOriginTokens();
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('external edits within the token TTL are delivered while unchanged echoes remain tagged', async () => {
  await fixture(async ({ root, api, event }) => {
    await api('write', 'note.md', { data: 'browser', token: 'self' });
    assert.equal((await event('note.md', 'create')).originToken, 'self');
    assert.equal((await event('note.md')).originToken, 'self');
    await fs.writeFile(path.join(root, 'note.md'), 'external');
    assert.equal((await event('note.md')).originToken, undefined);
    assert.equal((await event('note.md')).originToken, undefined);
  });
});

test('same-size external edits with restored mtime are not browser echoes', async () => {
  await fixture(async ({ root, api, event }) => {
    await api('write', 'note.md', { data: 'aaaa', token: 'self' });
    const absolute = path.join(root, 'note.md');
    const before = await fs.stat(absolute);
    await fs.writeFile(absolute, 'bbbb');
    await fs.utimes(absolute, before.atime, before.mtime);
    assert.equal((await event('note.md')).originToken, undefined);
  });
});

test('successful tokenless writes revoke the previous writer', async () => {
  await fixture(async ({ api, event }) => {
    await api('write', 'note.md', { data: 'first', token: 'self' });
    await api('write', 'note.md', { data: 'plain' });
    assert.equal((await event('note.md')).originToken, undefined);
  });
});

test('text and binary appends retain their own echoes but not the next external write', async () => {
  await fixture(async ({ root, api, event }) => {
    for (const binary of [false, true]) {
      const file = binary ? 'binary.bin' : 'text.md';
      await api(binary ? 'writeBinary' : 'write', file, binary ? { base64: 'AAEC', token: 'a' } : { data: 'start', token: 'a' });
      await api(binary ? 'appendBinary' : 'append', file, binary ? { base64: '/wQ=', token: 'b' } : { data: '+end', token: 'b' });
      assert.deepEqual(await fs.readFile(path.join(root, file)), binary ? Buffer.from([0, 1, 2, 255, 4]) : Buffer.from('start+end'));
      assert.equal((await event(file)).originToken, 'b');
      assert.equal((await event(file)).originToken, 'b');
      await fs.appendFile(path.join(root, file), 'external');
      assert.equal((await event(file)).originToken, undefined);
    }
  });
});

test('copy, rename and timestamp mutations retain only their completed file versions', async () => {
  await fixture(async ({ root, api, event }) => {
    await api('write', 'source.md', { data: 'original', token: 'a' });
    await api('copy', 'source.md', { to: 'copy.md', token: 'copy' });
    assert.equal((await event('copy.md', 'create')).originToken, 'copy');
    await api('rename', 'copy.md', { to: 'renamed.md', token: 'rename' });
    assert.equal((await event('copy.md', 'delete')).originToken, 'rename');
    assert.equal((await event('renamed.md', 'create')).originToken, 'rename');
    await api('utimes', 'renamed.md', { mtimeMs: 1700000000000, token: 'touch' });
    assert.equal((await event('renamed.md')).originToken, 'touch');
    await fs.writeFile(path.join(root, 'renamed.md'), 'external');
    assert.equal((await event('renamed.md')).originToken, undefined);
  });
});

test('external delete and recreation cannot reuse an earlier live or missing version', async () => {
  await fixture(async ({ root, api, event }) => {
    await api('write', 'note.md', { data: 'browser', token: 'write' });
    await fs.unlink(path.join(root, 'note.md'));
    assert.equal((await event('note.md', 'delete')).originToken, undefined);
    await api('write', 'note.md', { data: 'browser', token: 'write' });
    await api('remove', 'note.md', { token: 'remove' });
    assert.equal((await event('note.md', 'delete')).originToken, 'remove');
    assert.equal((await event('note.md', 'delete')).originToken, 'remove');
    await fs.writeFile(path.join(root, 'note.md'), 'recreated');
    assert.equal((await event('note.md', 'create')).originToken, undefined);
  });
});

test('failed writes neither replace a valid owner nor claim a later external creation', async () => {
  await fixture(async ({ root, vault, api, event }) => {
    await api('write', 'note.md', { data: 'browser', token: 'original' });
    assert.equal((await handleFsRequest(vault, { op: 'write', path: 'note.md', args: { data: null, token: 'failed' } })).ok, false);
    assert.equal((await event('note.md')).originToken, 'original');
    assert.equal((await handleFsRequest(vault, { op: 'write', path: 'missing/note.md', args: { data: 'x', token: 'failed' } })).ok, false);
    await fs.mkdir(path.join(root, 'missing'));
    await fs.writeFile(path.join(root, 'missing/note.md'), 'external');
    assert.equal((await event('missing/note.md', 'create')).originToken, undefined);
  });
});

test('concurrent browser appends serialize with their expected contents and latest owner', async () => {
  await fixture(async ({ root, api, event }) => {
    await api('write', 'note.md', { data: 'start', token: 'initial' });
    await Promise.all(Array.from({ length: 8 }, (_, index) => api('append', 'note.md', { data: `|${index}`, token: `writer-${index}` })));
    const text = await fs.readFile(path.join(root, 'note.md'), 'utf8');
    assert.equal(text.split('|').length, 9);
    const last = text.split('|').at(-1);
    assert.equal((await event('note.md')).originToken, `writer-${last}`);
    assert.equal((await event('note.md')).originToken, `writer-${last}`);
  });
});

test('a post-write external overwrite is not adopted as the successful request payload', async () => {
  await fixture(async ({ root, api, event }) => {
    const writeFile = fs.writeFile;
    fs.writeFile = async (...args) => {
      const result = await writeFile(...args);
      if (path.basename(args[0]) === 'race.md' && args[1] === 'browser') await writeFile(args[0], 'foreign');
      return result;
    };
    try {
      await api('write', 'race.md', { data: 'browser', token: 'self' });
    } finally {
      fs.writeFile = writeFile;
    }
    assert.equal((await event('race.md', 'create')).originToken, undefined);
    assert.equal(await fs.readFile(path.join(root, 'race.md'), 'utf8'), 'foreign');
  });
});

test('post-write disappearance never creates a browser deletion tombstone', async () => {
  await fixture(async ({ root }) => {
    assert.equal(await captureOriginVersion(path.join(root, 'vanished.md'), hashOriginContent('request')), undefined);
  });
});

test('queued overlapping mutations cannot deadlock with reversed path order', async () => {
  await fixture(async ({ root }) => {
    const a = path.join(root, 'a'); const b = path.join(root, 'b');
    const order = [];
    await Promise.all([
      runOriginMutation([a, b], async () => { order.push('first'); }),
      runOriginMutation([b, a], async () => { order.push('second'); }),
    ]);
    assert.deepEqual(order, ['first', 'second']);
  });
});

test('directory creation and removal match only their own directory or missing state', async () => {
  await fixture(async ({ root, api, event }) => {
    await api('mkdir', 'folder', { token: 'mkdir' });
    assert.equal((await event('folder', 'create')).originToken, 'mkdir');
    await api('rmdir', 'folder', { token: 'rmdir' });
    assert.equal((await event('folder', 'delete')).originToken, 'rmdir');
    await fs.mkdir(path.join(root, 'folder'));
    assert.equal((await event('folder', 'create')).originToken, undefined);
  });
});

test('writes through a contained symlink tag both the alias and real target', async () => {
  await fixture(async ({ root, api, event }) => {
    await fs.writeFile(path.join(root, 'target.md'), 'before');
    await fs.symlink('target.md', path.join(root, 'alias.md'));
    await api('write', 'alias.md', { data: 'browser', token: 'self' });
    assert.equal((await event('alias.md')).originToken, 'self');
    assert.equal((await event('target.md')).originToken, 'self');
    assert.equal((await event('target.md')).originToken, 'self');
    await fs.writeFile(path.join(root, 'target.md'), 'external');
    assert.equal((await event('target.md')).originToken, undefined);
    assert.equal((await event('alias.md')).originToken, undefined);
  });
});

test('rename fingerprints the committed destination rather than a replaced symlink target', async () => {
  await fixture(async ({ root, api, event }) => {
    await fs.writeFile(path.join(root, 'target.md'), 'target');
    await fs.symlink('target.md', path.join(root, 'destination.md'));
    await api('write', 'source.md', { data: 'source', token: 'write' });
    await api('rename', 'source.md', { to: 'destination.md', token: 'rename' });
    assert.equal((await event('destination.md')).originToken, 'rename');
    assert.equal(await fs.readFile(path.join(root, 'target.md'), 'utf8'), 'target');
    assert.equal((await event('target.md')).originToken, undefined);
    await fs.symlink('target.md', path.join(root, 'alias.md'));
    await api('rename', 'alias.md', { to: 'renamed-alias.md', token: 'link-rename' });
    assert.equal((await event('alias.md', 'delete')).originToken, 'link-rename');
    assert.equal((await event('renamed-alias.md', 'create')).originToken, 'link-rename');
    assert.equal((await event('target.md')).originToken, undefined);
  });
});

test('watcher version sampling rejects an ancestor symlink escaping the vault', async () => {
  await fixture(async ({ root, api, event }) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'myobs-origin-outside-'));
    const open = fs.open;
    let opened = 0;
    try {
      await api('mkdir', 'folder');
      await api('write', 'folder/note.md', { data: 'browser', token: 'self' });
      await fs.writeFile(path.join(outside, 'note.md'), 'outside');
      await fs.rm(path.join(root, 'folder'), { recursive: true });
      await fs.symlink(outside, path.join(root, 'folder'));
      fs.open = async (...args) => { opened += 1; return open(...args); };
      assert.equal((await event('folder/note.md')).originToken, undefined);
      assert.equal(opened, 0, 'containment rejection must happen before opening bytes to hash');
    } finally {
      fs.open = open;
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test('PUT and fs writes share version ownership, including tokenless overwrite', async () => {
  await fixture(async ({ root, api, event }) => {
    const app = await buildApp({ vaultPath: root, watch: false, termsAccepted: true, authToken: '' });
    try {
      await api('write', 'upload.md', { data: 'before', token: 'api' });
      const upload = await app.inject({ method: 'PUT', url: `/v${path.join(root, 'upload.md')}`, payload: Buffer.from('uploaded'), headers: { 'x-write-token': 'put' } });
      assert.equal(upload.statusCode, 204);
      assert.equal((await event('upload.md')).originToken, 'put');
      await api('append', 'upload.md', { data: '+api', token: 'append' });
      assert.equal((await event('upload.md')).originToken, 'append');
      const plain = await app.inject({ method: 'PUT', url: `/v${path.join(root, 'upload.md')}`, payload: Buffer.from('plain') });
      assert.equal(plain.statusCode, 204);
      assert.equal((await event('upload.md')).originToken, undefined);
      assert.equal(await fs.readFile(path.join(root, 'upload.md'), 'utf8'), 'plain');
    } finally {
      await app.close();
    }
  });
});

test('a completed upload aborted while waiting for the mutation queue never replaces the target', async () => {
  await fixture(async ({ root, vault, api, event }) => {
    await api('write', 'upload.md', { data: 'original', token: 'api' });
    const app = await buildApp({ vaultPath: root, watch: false, termsAccepted: true, authToken: '' });
    let serverReply;
    app.addHook('onRequest', async (_request, reply) => { serverReply = reply; });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const createWriteStream = fsSync.createWriteStream;
    let streamFinished;
    const flushed = new Promise(resolve => { streamFinished = resolve; });
    fsSync.createWriteStream = (...args) => {
      const stream = createWriteStream(...args);
      stream.once('finish', streamFinished);
      return stream;
    };
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const held = runOriginMutation([path.join(vault.root, 'upload.md')], () => gate);
    let request;
    try {
      request = http.request({ host: '127.0.0.1', port: app.server.address().port, method: 'PUT', path: `/v${path.join(vault.root, 'upload.md')}`, headers: { 'content-length': '8', 'x-write-token': 'aborted' } });
      request.on('error', () => {});
      request.end('uploaded');
      await flushed;
      await immediate();
      const closed = new Promise(resolve => serverReply.raw.once('close', resolve));
      request.destroy();
      await closed;
      release();
      await held;
      // This queue reservation follows the PUT reservation and therefore
      // observes its commit-or-cleanup decision without a guessed sleep.
      await runOriginMutation([path.join(vault.root, 'upload.md')], async () => {});
      assert.equal(await fs.readFile(path.join(root, 'upload.md'), 'utf8'), 'original');
      assert.equal((await event('upload.md')).originToken, 'api');
    } finally {
      release();
      request?.destroy();
      fsSync.createWriteStream = createWriteStream;
      await app.close();
    }
  });
});

for (const boundary of ['before-lstat', 'before-open', 'restored-after-open']) {
  test(`watcher rejects an ancestor replaced ${boundary} before reading content`, async () => {
    await fixture(async ({ root, api, event }) => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'myobs-origin-race-outside-'));
      const originalOpen = fs.open;
      const originalLstat = fs.lstat;
      let swapped = false;
      let bytesRead = 0;
      const swap = async () => {
        if (swapped) return;
        swapped = true;
        await fs.rename(path.join(root, 'folder'), path.join(root, 'saved-folder'));
        await fs.symlink(outside, path.join(root, 'folder'));
      };
      try {
        await api('mkdir', 'folder');
        await api('write', 'folder/note.md', { data: 'browser', token: 'self' });
        await fs.writeFile(path.join(outside, 'note.md'), 'outside fixture');
        fs.lstat = async (...args) => {
          if (boundary !== 'before-open' && args[1]?.bigint && String(args[0]).endsWith('/folder/note.md')) await swap();
          return originalLstat(...args);
        };
        fs.open = async (...args) => {
          if (boundary === 'before-open' && String(args[0]).endsWith('/folder/note.md')) await swap();
          const handle = await originalOpen(...args);
          if (boundary === 'restored-after-open' && String(args[0]).endsWith('/folder/note.md')) {
            await fs.unlink(path.join(root, 'folder'));
            await fs.rename(path.join(root, 'saved-folder'), path.join(root, 'folder'));
          }
          const createReadStream = handle.createReadStream.bind(handle);
          handle.createReadStream = options => {
            const stream = createReadStream(options);
            stream.on('data', chunk => { bytesRead += chunk.length; });
            return stream;
          };
          return handle;
        };
        assert.equal((await event('folder/note.md')).originToken, undefined);
        assert.equal(swapped, true, 'the test must exercise the replacement window');
        assert.equal(bytesRead, 0, 'reject the opened descriptor before hashing outside bytes');
      } finally {
        fs.open = originalOpen;
        fs.lstat = originalLstat;
        await fs.rm(outside, { recursive: true, force: true });
      }
    });
  });
}
