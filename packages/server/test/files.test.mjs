/**
 * /v/* attachment endpoint (CONTRACTS.md §3).
 *
 * The renderer builds these URLs as
 *   resourcePathPrefix + pathToFileURL(abs).href.substring(8) + "?" + mtime
 * so every segment is percent-encoded by the shim, the leading "/" of the
 * absolute path is gone, and a cache-busting "?mtime" is appended. These tests
 * speak that exact URL shape, including the filenames a real vault contains
 * (`backpacker/1801 Iceland/`, CJK, "#", "?", "%", emoji).
 *
 * Only temporary directories are used.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildApp } from '../src/index.js';
import { parseRange } from '../src/files.js';

/** @type {string} */
let root;
/** @type {string} */
let realRoot;
/** @type {string} */
let outside;
/** @type {import('fastify').FastifyInstance} */
let app;

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

async function writeFixture(relativePath, contents) {
  const absolute = path.join(root, ...relativePath.split('/'));
  await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
  await fs.promises.writeFile(absolute, contents);
  return absolute;
}

/**
 * Reproduce FileSystemAdapter.getResourcePath(): percent-encode each segment
 * of the absolute path, drop the leading slash, prefix "/v/", append "?mtime".
 *
 * @param {string} absolutePath
 * @param {number} [mtime]
 * @returns {string}
 */
function resourceUrl(absolutePath, mtime = 1730000000000) {
  // '/Users/x' -> ['', 'Users', 'x'] -> '/Users/x', so this keeps the leading
  // slash and "/v" supplies the one the URL needs.
  const encoded = absolutePath.split('/').map(encodeURIComponent).join('/');
  return `/v${encoded}?${mtime}`;
}

/**
 * Same thing for a vault-relative path, which is how every real request is
 * shaped (the adapter always builds from the absolute path).
 *
 * @param {string} relativePath
 * @returns {string}
 */
function vaultUrl(relativePath) {
  return resourceUrl(path.join(realRoot, relativePath));
}

/**
 * @param {string} method
 * @param {string} url
 * @param {object} [options]
 */
function request(method, url, options = {}) {
  return app.inject({ method, url, ...options });
}

before(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'myobs-files-'));
  realRoot = await fs.promises.realpath(root);
  outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'myobs-files-out-'));

  await writeFixture('assets/pixel.png', PNG_BYTES);
  await writeFixture('assets/PIXEL-UPPER.PNG', PNG_BYTES);
  await writeFixture('assets/note.md', '# 標題\n\n內文 with accents é\n');
  await writeFixture('assets/plain.txt', 'plain text\n');
  await writeFixture('assets/data.json', '{"ok":true}\n');
  await writeFixture('assets/doc.pdf', '%PDF-1.4\n%%EOF\n');
  await writeFixture('assets/tone.mp3', Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22]));
  await writeFixture('assets/font.woff2', Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01]));
  await writeFixture('assets/vector.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFixture('assets/vector.SVG', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFixture('assets/mystery.zzz', Buffer.from([1, 2, 3, 4]));
  await writeFixture('assets/noextension', 'no extension here');
  await writeFixture('assets/empty.bin', Buffer.alloc(0));
  await writeFixture('assets/range.bin', Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'latin1'));
  await fs.promises.mkdir(path.join(root, 'assets/folder.png'), { recursive: true });

  // Filenames that break naive URL handling. Each pair below deliberately
  // makes the double-decoded name resolve to a *different* existing file, so a
  // regression serves the wrong bytes instead of a harmless 404.
  const tricky = [
    ['assets/has space.png', 'SPACE'],
    ['assets/中文檔名.png', 'CJK'],
    ['assets/hash#tag.png', 'HASH'],
    ['assets/query?mark.png', 'QUERY'],
    ['assets/pct%20.png', 'PERCENT-TWENTY'],
    ['assets/pct .png', 'PLAIN-SPACE'],
    ['assets/pct%2F.png', 'PERCENT-SLASH'],
    ['assets/emoji 😀.png', 'EMOJI'],
    ['assets/percent%.png', 'LONE-PERCENT'],
  ];
  for (const [name, marker] of tricky) {
    await writeFixture(name, Buffer.from(`content:${marker}\n`));
  }

  // A directory whose own name needs encoding, holding a full set of assets.
  await writeFixture('backpacker/1801 Iceland/_attach 測試/photo 1.png', PNG_BYTES);
  await writeFixture('backpacker/1801 Iceland/_attach 測試/筆記.md', 'ok\n');

  await writeFixture('secret.txt', 'inside is fine');
  await fs.promises.writeFile(path.join(outside, 'secret.txt'), 'outside');

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

describe('GET /v/* basics', () => {
  it('serves a file inside the vault with 200 and its bytes', async () => {
    const response = await request('GET', resourceUrl(path.join(realRoot, 'assets/pixel.png')));

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.rawPayload, PNG_BYTES);
    assert.equal(Number(response.headers['content-length']), PNG_BYTES.length);
  });

  it('advertises range support and cache metadata', async () => {
    const response = await request('GET', resourceUrl(path.join(realRoot, 'assets/pixel.png')));

    assert.equal(response.headers['accept-ranges'], 'bytes');
    assert.equal(response.headers['cache-control'], 'no-cache');
    assert.match(response.headers['last-modified'], /GMT$/);
  });

  it('403s a path that does not name the vault (the URL is always absolute)', async () => {
    // CONTRACTS.md §3: the URL is "/v/" + the absolute path with its leading
    // slash removed. "/v/assets/pixel.png" therefore means the absolute path
    // /assets/pixel.png, which is not in the vault -- it must not be silently
    // reinterpreted as vault-relative.
    const response = await request('GET', '/v/assets/pixel.png');

    assert.equal(response.statusCode, 403);
  });

  it('ignores the cache-busting query string', async () => {
    const response = await request('GET', vaultUrl('assets/pixel.png'), {
      headers: {},
    });
    const fresh = await request('GET', resourceUrl(path.join(realRoot, 'assets/pixel.png'), 9999999999999));

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.rawPayload, fresh.rawPayload);
  });

  it('404s for a missing file', async () => {
    const response = await request('GET', vaultUrl('assets/nope.png'));

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'ENOENT');
  });

  it('404s for a directory, even when its name looks like an image', async () => {
    const response = await request('GET', vaultUrl('assets'));
    const decoy = await request('GET', vaultUrl('assets/folder.png'));

    assert.equal(response.statusCode, 404);
    assert.equal(decoy.statusCode, 404);
  });

  it('403s for a path outside the vault', async () => {
    const response = await request('GET', resourceUrl(path.join(outside, 'secret.txt')));

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, 'EPERM');
  });

  it('403s for a traversal that escapes the vault', async () => {
    for (const url of [
      '/v/../../etc/passwd',
      '/v/assets/../../../../etc/passwd',
      '/v/%2e%2e/%2e%2e/etc/passwd',
      `/v/${encodeURIComponent(path.join(realRoot, '../escape.txt'))}`,
    ]) {
      const response = await request('GET', url);
      assert.ok(
        response.statusCode === 403 || response.statusCode === 404,
        `${url} returned ${response.statusCode}`,
      );
    }
  });

  it('refuses a sibling directory that only shares the vault prefix', async () => {
    const sibling = `${realRoot}-sibling`;
    await fs.promises.mkdir(sibling, { recursive: true });
    await fs.promises.writeFile(path.join(sibling, 'x.png'), 'nope');
    try {
      const response = await request('GET', resourceUrl(path.join(sibling, 'x.png')));
      assert.equal(response.statusCode, 403);
    } finally {
      await fs.promises.rm(sibling, { recursive: true, force: true });
    }
  });

  it('403s for a NUL byte in the path', async () => {
    const response = await request('GET', '/v/assets/pixel%00.png');

    assert.equal(response.statusCode, 403);
  });
});

describe('GET /v/* content types', () => {
  const cases = [
    ['assets/pixel.png', 'image/png'],
    ['assets/PIXEL-UPPER.PNG', 'image/png'],
    ['assets/note.md', 'text/markdown; charset=utf-8'],
    ['assets/plain.txt', 'text/plain; charset=utf-8'],
    ['assets/data.json', 'application/json; charset=utf-8'],
    ['assets/doc.pdf', 'application/pdf'],
    ['assets/tone.mp3', 'audio/mpeg'],
    ['assets/font.woff2', 'font/woff2'],
    ['assets/vector.svg', 'image/svg+xml; charset=utf-8'],
    ['assets/vector.SVG', 'image/svg+xml; charset=utf-8'],
    ['assets/mystery.zzz', 'application/octet-stream'],
    ['assets/noextension', 'application/octet-stream'],
  ];

  for (const [relative, expected] of cases) {
    it(`labels ${relative} as ${expected}`, async () => {
      const response = await request('GET', resourceUrl(path.join(realRoot, relative)));

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['content-type'], expected);
    });
  }

  it('keeps the UTF-8 body intact for a CJK markdown file', async () => {
    const response = await request('GET', resourceUrl(path.join(realRoot, 'assets/note.md')));

    assert.equal(response.statusCode, 200);
    assert.equal(response.body, '# 標題\n\n內文 with accents é\n');
  });
});

describe('HEAD /v/*', () => {
  it('returns the same metadata as GET and no body', async () => {
    const url = resourceUrl(path.join(realRoot, 'assets/pixel.png'));
    const get = await request('GET', url);
    const head = await request('HEAD', url);

    assert.equal(head.statusCode, 200);
    assert.equal(head.rawPayload.length, 0);
    for (const header of ['content-type', 'content-length', 'accept-ranges', 'last-modified', 'cache-control']) {
      assert.equal(head.headers[header], get.headers[header], `header ${header}`);
    }
  });

  it('mirrors a 206 response without a body', async () => {
    const url = resourceUrl(path.join(realRoot, 'assets/range.bin'));
    const head = await request('HEAD', url, { headers: { range: 'bytes=0-9' } });

    assert.equal(head.statusCode, 206);
    assert.equal(head.headers['content-range'], 'bytes 0-9/36');
    assert.equal(head.headers['content-length'], '10');
    assert.equal(head.rawPayload.length, 0);
  });

  it('mirrors a 404 without a body', async () => {
    const head = await request('HEAD', vaultUrl('assets/nope.png'));

    assert.equal(head.statusCode, 404);
    assert.equal(head.rawPayload.length, 0);
  });
});

describe('Range support', () => {
  const rangeUrl = () => resourceUrl(path.join(realRoot, 'assets/range.bin')); // 36 bytes

  it('serves a single closed range', async () => {
    const response = await request('GET', rangeUrl(), { headers: { range: 'bytes=0-9' } });

    assert.equal(response.statusCode, 206);
    assert.equal(response.headers['content-range'], 'bytes 0-9/36');
    assert.equal(response.headers['content-length'], '10');
    assert.equal(response.headers['accept-ranges'], 'bytes');
    assert.equal(response.body, '0123456789');
  });

  it('serves an open-ended range', async () => {
    const response = await request('GET', rangeUrl(), { headers: { range: 'bytes=30-' } });

    assert.equal(response.statusCode, 206);
    assert.equal(response.headers['content-range'], 'bytes 30-35/36');
    assert.equal(response.body, 'UVWXYZ');
  });

  it('serves a suffix range', async () => {
    const response = await request('GET', rangeUrl(), { headers: { range: 'bytes=-6' } });

    assert.equal(response.statusCode, 206);
    assert.equal(response.headers['content-range'], 'bytes 30-35/36');
    assert.equal(response.body, 'UVWXYZ');
  });

  it('clamps a suffix longer than the file instead of failing', async () => {
    const response = await request('GET', rangeUrl(), { headers: { range: 'bytes=-1000' } });

    assert.equal(response.statusCode, 206);
    assert.equal(response.headers['content-range'], 'bytes 0-35/36');
    assert.equal(response.body.length, 36);
  });

  it('clamps a last-byte-pos beyond EOF', async () => {
    const response = await request('GET', rangeUrl(), { headers: { range: 'bytes=30-9999' } });

    assert.equal(response.statusCode, 206);
    assert.equal(response.headers['content-range'], 'bytes 30-35/36');
  });

  it('serves a one-byte range', async () => {
    const response = await request('GET', rangeUrl(), { headers: { range: 'bytes=35-35' } });

    assert.equal(response.statusCode, 206);
    assert.equal(response.headers['content-range'], 'bytes 35-35/36');
    assert.equal(response.body, 'Z');
  });

  it('416s a range that starts past EOF, with bytes */<size>', async () => {
    const response = await request('GET', rangeUrl(), { headers: { range: 'bytes=36-' } });
    const past = await request('GET', rangeUrl(), { headers: { range: 'bytes=100-200' } });

    assert.equal(response.statusCode, 416);
    assert.equal(response.headers['content-range'], 'bytes */36');
    assert.equal(response.headers['accept-ranges'], 'bytes');
    assert.equal(response.rawPayload.length, 0);
    assert.equal(past.statusCode, 416);
    assert.equal(past.headers['content-range'], 'bytes */36');
  });

  it('416s any range against an empty file', async () => {
    const url = resourceUrl(path.join(realRoot, 'assets/empty.bin'));
    const response = await request('GET', url, { headers: { range: 'bytes=0-' } });
    const suffix = await request('GET', url, { headers: { range: 'bytes=-0' } });

    assert.equal(response.statusCode, 416);
    assert.equal(response.headers['content-range'], 'bytes */0');
    assert.equal(suffix.statusCode, 416);
  });

  it('ignores a syntactically invalid range and sends the whole file', async () => {
    for (const range of ['bytes=5-2', 'bytes=abc-def', 'bytes=-', 'bytes=', 'items=0-9']) {
      const response = await request('GET', rangeUrl(), { headers: { range } });
      assert.equal(response.statusCode, 200, `range ${range}`);
      assert.equal(response.body.length, 36, `range ${range}`);
      assert.equal(response.headers['content-range'], undefined, `range ${range}`);
    }
  });

  it('ignores a multi-range request instead of 416ing it', async () => {
    const response = await request('GET', rangeUrl(), { headers: { range: 'bytes=0-3,10-13' } });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.length, 36);
  });

  it('sends the whole file with 200 when no Range header is present', async () => {
    const response = await request('GET', rangeUrl());

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-range'], undefined);
    assert.equal(response.headers['content-length'], '36');
  });
});

describe('parseRange', () => {
  it('returns null when there is no header', () => {
    assert.equal(parseRange(undefined, 10), null);
    assert.equal(parseRange('', 10), null);
  });

  it('parses closed, open and suffix ranges', () => {
    assert.deepEqual(parseRange('bytes=2-5', 10), { start: 2, end: 5 });
    assert.deepEqual(parseRange('bytes=2-', 10), { start: 2, end: 9 });
    assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
    assert.deepEqual(parseRange('bytes=-30', 10), { start: 0, end: 9 });
  });

  it('tolerates surrounding whitespace and mixed case', () => {
    assert.deepEqual(parseRange('  bytes=1-2  ', 10), { start: 1, end: 2 });
    assert.deepEqual(parseRange('BYTES=1-2', 10), { start: 1, end: 2 });
    assert.deepEqual(parseRange('bytes= 1 - 2', 10), { start: 1, end: 2 });
  });

  it('reports unsatisfiable ranges', () => {
    assert.equal(parseRange('bytes=10-', 10), 'unsatisfiable');
    assert.equal(parseRange('bytes=99-100', 10), 'unsatisfiable');
    assert.equal(parseRange('bytes=-0', 10), 'unsatisfiable');
    assert.equal(parseRange('bytes=0-', 0), 'unsatisfiable');
  });

  it('ignores anything it does not understand', () => {
    assert.equal(parseRange('bytes=5-2', 10), null);
    assert.equal(parseRange('bytes=0-1,3-4', 10), null);
    assert.equal(parseRange('bytes=-', 10), null);
    assert.equal(parseRange('bytes', 10), null);
    assert.equal(parseRange('items=0-1', 10), null);
    assert.equal(parseRange('bytes=abc', 10), null);
  });
});

describe('filenames that need percent-encoding', () => {
  const cases = [
    ['has space.png', 'SPACE'],
    ['中文檔名.png', 'CJK'],
    ['hash#tag.png', 'HASH'],
    ['query?mark.png', 'QUERY'],
    ['pct%20.png', 'PERCENT-TWENTY'],
    ['pct%2F.png', 'PERCENT-SLASH'],
    ['emoji 😀.png', 'EMOJI'],
    ['percent%.png', 'LONE-PERCENT'],
  ];

  for (const [name, marker] of cases) {
    it(`serves ${JSON.stringify(name)} by its encoded URL`, async () => {
      const url = resourceUrl(path.join(realRoot, 'assets', name));
      const response = await request('GET', url);

      assert.equal(response.statusCode, 200, `${url} -> ${response.body}`);
      assert.equal(response.body, `content:${marker}\n`);
    });
  }

  it('keeps "%20" in a filename distinct from a real space', async () => {
    // The regression this guards: decoding a second time inside the handler
    // turns /v/pct%2520.png into the request for "pct .png", silently serving
    // the wrong attachment.
    const encoded = await request(
      'GET',
      resourceUrl(path.join(realRoot, 'assets/pct%20.png')),
    );
    const spaced = await request(
      'GET',
      resourceUrl(path.join(realRoot, 'assets/pct .png')),
    );

    assert.equal(encoded.body, 'content:PERCENT-TWENTY\n');
    assert.equal(spaced.body, 'content:PLAIN-SPACE\n');
  });

  it('serves files under a directory with a space and CJK name', async () => {
    const dir = path.join(realRoot, 'backpacker/1801 Iceland/_attach 測試');
    const image = await request('GET', resourceUrl(path.join(dir, 'photo 1.png')));
    const note = await request('GET', resourceUrl(path.join(dir, '筆記.md')));

    assert.equal(image.statusCode, 200);
    assert.deepEqual(image.rawPayload, PNG_BYTES);
    assert.equal(note.statusCode, 200);
    assert.equal(note.headers['content-type'], 'text/markdown; charset=utf-8');
  });

  it('still 403s an encoded traversal attempt', async () => {
    const response = await request('GET', '/v/%2e%2e%2f%2e%2e%2fetc%2fpasswd');

    assert.ok(
      response.statusCode === 403 || response.statusCode === 404,
      `returned ${response.statusCode}`,
    );
  });
});

describe('PUT /v/*', () => {
  it('writes a new file inside the vault', async () => {
    const url = resourceUrl(path.join(realRoot, 'assets/uploaded.bin'));
    const response = await request('PUT', url, {
      payload: Buffer.from([0x00, 0x01, 0xfe, 0xff]),
    });

    assert.equal(response.statusCode, 204);
    assert.deepEqual(
      await fs.promises.readFile(path.join(root, 'assets/uploaded.bin')),
      Buffer.from([0x00, 0x01, 0xfe, 0xff]),
    );
  });

  it('writes a file whose name needs encoding', async () => {
    const url = resourceUrl(path.join(realRoot, 'assets/上傳 檔#1%.bin'));
    const response = await request('PUT', url, { payload: Buffer.from('hello') });

    assert.equal(response.statusCode, 204);
    assert.equal(
      await fs.promises.readFile(path.join(root, 'assets/上傳 檔#1%.bin'), 'utf8'),
      'hello',
    );
  });

  it('403s a write outside the vault', async () => {
    const url = resourceUrl(path.join(outside, 'planted.bin'));
    const response = await request('PUT', url, { payload: Buffer.from('nope') });

    assert.equal(response.statusCode, 403);
    await assert.rejects(() => fs.promises.stat(path.join(outside, 'planted.bin')));
  });

  it('404s a write into a missing directory', async () => {
    const response = await request('PUT', vaultUrl('assets/missing-dir/x.bin'), {
      payload: Buffer.from('nope'),
    });

    assert.equal(response.statusCode, 404);
  });
});

describe('macOS /var aliasing', () => {
  it('serves the same file through the alias and the canonical root', async () => {
    // os.tmpdir() is /var/folders/... while its realpath is /private/var/...;
    // the renderer only ever knows the canonical vault.root the server sent,
    // but a hand-written URL may carry either spelling.
    const alias = root;
    const canonical = realRoot;
    const viaCanonical = await request('GET', resourceUrl(path.join(canonical, 'assets/pixel.png')));
    const viaAlias = await request('GET', resourceUrl(path.join(alias, 'assets/pixel.png')));

    assert.equal(viaCanonical.statusCode, 200);
    assert.equal(viaAlias.statusCode, 200, `alias ${alias} -> ${viaAlias.body}`);
    assert.deepEqual(viaAlias.rawPayload, PNG_BYTES);
  });

  it('runs in a directory whose realpath differs, which is what makes that meaningful', () => {
    if (process.platform !== 'darwin') return; // no /var -> /private/var alias
    assert.notEqual(root, realRoot, `expected ${root} to differ from its realpath`);
  });
});
