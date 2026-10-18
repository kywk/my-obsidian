/**
 * Streaming PUT /v/* (CONTRACTS.md §3).
 *
 * The route used to buffer the whole body in memory (bodyLimit 2 GiB), which
 * makes a GB-scale attachment upload an OOM. These tests speak real HTTP
 * instead of app.inject() because the point is the *streaming* behaviour:
 * inject delivers a complete in-process payload and cannot show backpressure,
 * mid-transfer disconnects or the write-then-rename window.
 *
 * Memory is measured through process.memoryUsage().arrayBuffers while the
 * body is in flight. That counter tracks live Buffer/ArrayBuffer bytes, which
 * is exactly the quantity a buffered implementation would grow by the size of
 * the upload; a streaming implementation stays bounded by the socket and the
 * rotating client chunk pool.
 *
 * Only temporary directories are used.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildApp } from '../src/index.js';
import { clearOriginTokens, lookupOriginToken } from '../src/watch.js';

const CHUNK_SIZE = 1024 * 1024;

/** @type {string} */
let vault;
/** @type {string} */
let realRoot;
/** @type {import('fastify').FastifyInstance} */
let app;
/** @type {number} */
let port;

before(async () => {
  vault = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'myobs-stream-'));
  realRoot = await fs.promises.realpath(vault);
  // PUT does not create parent directories; every target below needs one.
  for (const dir of ['big', 'data', 'replace', 'abort', 'tokens', 'limited']) {
    await fs.promises.mkdir(path.join(vault, dir), { recursive: true });
  }
  clearOriginTokens();
  app = await buildApp({
    vaultPath: vault,
    watch: false,
    termsAccepted: true,
    authToken: '',
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

after(async () => {
  if (app) await app.close();
  await fs.promises.rm(vault, { recursive: true, force: true });
});

/**
 * The renderer's URL shape: "/v" + the absolute path with each segment
 * percent-encoded and the leading slash supplied by "/v".
 *
 * @param {string} absolute
 */
function resourceUrl(absolute) {
  return `/v${absolute.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * A deterministic byte pattern, written into `buffer` for chunk `index`.
 *
 * @param {Buffer} buffer
 * @param {number} index
 */
function fillChunk(buffer, index) {
  for (let i = 0; i < buffer.length; i += 1) {
    buffer[i] = (index * 31 + i * 7) & 0xff;
  }
}

/**
 * @param {http.ClientRequest} req
 * @param {Buffer} chunk
 * @returns {Promise<void>} resolves when the chunk is flushed
 */
function writeChunk(req, chunk) {
  return new Promise((resolve, reject) => {
    req.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

/** Every temp file this route is allowed to create, under `dir`. */
async function tempFiles(dir) {
  const entries = await fs.promises.readdir(dir).catch(() => []);
  return entries.filter((name) => name.includes('.myobs-upload'));
}

/**
 * @param {() => boolean | Promise<boolean>} predicate
 * @param {{ timeout?: number, interval?: number, label?: string }} [options]
 */
async function waitFor(predicate, options = {}) {
  const { timeout = 5000, interval = 25, label = 'condition' } = options;
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeout} ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * @param {string} absolutePath
 * @param {object} [headers]
 * @param {number} [targetPort]
 * @returns {{ req: http.ClientRequest, done: Promise<{ status: number, body: string }> }}
 */
function startPutAt(absolutePath, headers = {}, targetPort = port) {
  const req = http.request({
    host: '127.0.0.1',
    port: targetPort,
    method: 'PUT',
    path: resourceUrl(absolutePath),
    headers,
    // No keep-alive pool: app.close() would otherwise wait out Fastify's
    // 72 s keepAliveTimeout for every idle socket the suite leaves behind.
    agent: false,
  });
  const done = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
  });
  return { req, done };
}

/**
 * @param {string} name vault-relative path
 * @param {object} [headers]
 */
function startPut(name, headers = {}) {
  return startPutAt(path.join(realRoot, name), headers);
}

describe('PUT /v/* streams to disk', () => {
  it('uploads 64 MiB with a matching hash and bounded memory', async (t) => {
    const total = 64 * CHUNK_SIZE;
    const expected = createHash('sha256');
    const target = 'big/streamed.bin';

    let peakArrayBuffers = 0;
    const baseline = process.memoryUsage().arrayBuffers;
    const sampler = setInterval(() => {
      const now = process.memoryUsage().arrayBuffers;
      if (now > peakArrayBuffers) peakArrayBuffers = now;
    }, 5);

    const { req, done } = startPut(target, {
      'content-type': 'application/octet-stream',
      'content-length': String(total),
      'x-write-token': 'stream-token',
    });

    // Two rotating buffers, reused only after their write callback fired.
    const pool = [Buffer.allocUnsafe(CHUNK_SIZE), Buffer.allocUnsafe(CHUNK_SIZE)];
    let sent = 0;
    let index = 0;
    try {
      while (sent < total) {
        const buffer = pool[index % pool.length];
        fillChunk(buffer, index);
        expected.update(buffer);
        await writeChunk(req, buffer);
        sent += buffer.length;
        index += 1;

        if (index === 1) {
          // The request is still open (only 1 of 64 MiB sent) and the temp
          // file must already be growing on disk. A buffered route would not
          // create it until the whole body arrived.
          await waitFor(async () => {
            const partial = await fs.promises
              .readdir(path.join(vault, 'big'))
              .then((names) => names.find((name) => name.includes('.myobs-upload')));
            if (!partial) return false;
            const st = await fs.promises.stat(path.join(vault, 'big', partial));
            return st.size > 0;
          }, { label: 'the temp file to receive the first chunk' });
        }
      }
      req.end();
      const response = await done;
      assert.equal(response.status, 204);
    } finally {
      clearInterval(sampler);
    }

    const onDisk = createHash('sha256');
    const stream = fs.createReadStream(path.join(vault, target));
    for await (const chunk of stream) onDisk.update(chunk);

    const st = await fs.promises.stat(path.join(vault, target));
    assert.equal(st.size, total);
    assert.equal(onDisk.digest('hex'), expected.digest('hex'));

    // A buffered implementation keeps the whole 64 MiB body as one live
    // Buffer; the streaming route must stay clearly below that even with
    // allocator/GC slack. (The temp-file assertion above is the structural
    // proof; this is the memory measurement.)
    const peakDelta = peakArrayBuffers - baseline;
    t.diagnostic(
      `64 MiB PUT: peak live ArrayBuffers ${(peakArrayBuffers / 1024 / 1024).toFixed(1)} MiB ` +
        `(baseline ${(baseline / 1024 / 1024).toFixed(1)} MiB, delta +${(peakDelta / 1024 / 1024).toFixed(1)} MiB)`,
    );
    assert.ok(
      peakDelta < 48 * CHUNK_SIZE,
      `streaming upload allocated ${(peakDelta / 1024 / 1024).toFixed(1)} MiB of live buffers for a 64 MiB body`,
    );

    assert.equal(lookupOriginToken(target), 'stream-token');
    assert.deepEqual(await tempFiles(path.join(vault, 'big')), []);
  });

  it('does not discriminate on content-type: an application/json body still lands byte-exact', async () => {
    const payload = Buffer.from('{"plugins":["x"],"n":1}\n', 'utf8');
    const { req, done } = startPut('data/config.json', {
      'content-type': 'application/json',
      'content-length': String(payload.length),
    });
    req.end(payload);
    const response = await done;

    assert.equal(response.status, 204);
    assert.equal(await fs.promises.readFile(path.join(vault, 'data/config.json'), 'utf8'), payload.toString('utf8'));
  });

  it('replaces an existing file atomically and keeps the vault free of temp files', async () => {
    const absolute = path.join(vault, 'replace/note.bin');
    await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
    await fs.promises.writeFile(absolute, Buffer.from('old-content'));

    const payload = Buffer.from('new-content');
    const { req, done } = startPut('replace/note.bin', {
      'content-type': 'application/octet-stream',
      'content-length': String(payload.length),
    });
    req.end(payload);
    const response = await done;

    assert.equal(response.status, 204);
    assert.equal(await fs.promises.readFile(absolute, 'utf8'), 'new-content');
    assert.deepEqual(await tempFiles(path.join(vault, 'replace')), []);
  });
});

describe('PUT /v/* failure modes', () => {
  it('a mid-transfer disconnect leaves no half file, no temp and the old content intact', async () => {
    const target = 'abort/keep.bin';
    const absolute = path.join(vault, target);
    await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
    await fs.promises.writeFile(absolute, 'original-content');

    const chunk = Buffer.allocUnsafe(CHUNK_SIZE);
    fillChunk(chunk, 3);

    const { req, done } = startPut(target, {
      'content-type': 'application/octet-stream',
      'content-length': String(64 * CHUNK_SIZE),
    });
    // Swallow the client-side failure; the assertion is about server state.
    done.catch(() => {});

    await writeChunk(req, chunk);
    await writeChunk(req, chunk);
    req.destroy();
    await new Promise((resolve) => req.once('close', resolve));

    await waitFor(async () => (await tempFiles(path.dirname(absolute))).length === 0, {
      label: 'the temp upload file to be removed',
    });
    assert.equal(await fs.promises.readFile(absolute, 'utf8'), 'original-content');

    // The same abort against a path that did not exist must not create it.
    const fresh = startPut('abort/fresh.bin', {
      'content-type': 'application/octet-stream',
      'content-length': String(64 * CHUNK_SIZE),
    });
    fresh.done.catch(() => {});
    await writeChunk(fresh.req, chunk);
    fresh.req.destroy();
    await new Promise((resolve) => fresh.req.once('close', resolve));

    await waitFor(async () => (await tempFiles(path.join(vault, 'abort'))).length === 0, {
      label: 'the fresh temp upload file to be removed',
    });
    await assert.rejects(() => fs.promises.stat(path.join(vault, 'abort/fresh.bin')));
  });

  it('enforces the route body limit while streaming', async () => {
    const limited = await buildApp({
      vaultPath: vault,
      watch: false,
      termsAccepted: true,
      authToken: '',
      uploadBodyLimit: 64 * 1024,
    });
    await limited.listen({ host: '127.0.0.1', port: 0 });
    const address = limited.server.address();
    const limitedPort = typeof address === 'object' && address !== null ? address.port : 0;

    const chunk = Buffer.allocUnsafe(32 * 1024);
    fillChunk(chunk, 5);
    const body = Buffer.concat([chunk, chunk, chunk, chunk, chunk, chunk]); // 192 KiB

    try {
      const result = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: limitedPort,
            method: 'PUT',
            path: resourceUrl(path.join(realRoot, 'limited/too-big.bin')),
            headers: {
              'content-type': 'application/octet-stream',
              'content-length': String(body.length),
              // The rejected request is never fully read, so this connection
              // must not be reused: close it with the response.
              connection: 'close',
            },
            agent: false,
          },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () =>
              resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
            );
          },
        );
        req.on('error', reject);
        req.end(body);
      });

      assert.equal(result.status, 413);
      assert.equal(JSON.parse(result.body).error.code, 'ETOOBIG');
      await waitFor(async () => (await tempFiles(path.join(vault, 'limited'))).length === 0);
      await assert.rejects(() => fs.promises.stat(path.join(vault, 'limited/too-big.bin')));
    } finally {
      await limited.close();
    }
  });

  it('404s a write into a missing directory and leaves no temp behind', async () => {
    const { req, done } = startPut('missing-dir/x.bin', {
      'content-type': 'application/octet-stream',
      'content-length': '4',
    });
    req.end(Buffer.from('nope'));
    const response = await done;

    assert.equal(response.status, 404);
    assert.equal(JSON.parse(response.body).error.code, 'ENOENT');
    await assert.rejects(() => fs.promises.stat(path.join(vault, 'missing-dir')));
  });

  it('403s a write outside the vault without creating the file', async () => {
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'myobs-stream-out-'));
    try {
      // The URL carries an absolute path; the alias spelling os.tmpdir()
      // returns (/var vs /private/var) must not be accepted either.
      const { req, done } = startPutAt(path.join(outside, 'planted.bin'), {
        'content-type': 'application/octet-stream',
        'content-length': '4',
      });
      req.end(Buffer.from('nope'));
      const response = await done;

      assert.equal(response.status, 403);
      await assert.rejects(() => fs.promises.stat(path.join(outside, 'planted.bin')));
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });
});

describe('PUT /v/* write tokens', () => {
  it('registers X-Write-Token after the rename, and only when the header is present', async () => {
    const withToken = Buffer.from('tokenized');
    const first = startPut('tokens/marked.bin', {
      'content-type': 'application/octet-stream',
      'content-length': String(withToken.length),
      'x-write-token': 'stream-token-2',
    });
    first.req.end(withToken);
    assert.equal((await first.done).status, 204);

    const plain = Buffer.from('plain');
    const second = startPut('tokens/plain.bin', {
      'content-type': 'application/octet-stream',
      'content-length': String(plain.length),
    });
    second.req.end(plain);
    assert.equal((await second.done).status, 204);

    assert.equal(lookupOriginToken('tokens/marked.bin'), 'stream-token-2');
    assert.equal(lookupOriginToken('tokens/plain.bin'), undefined);
  });
});
