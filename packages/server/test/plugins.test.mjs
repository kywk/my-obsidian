import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildApp } from '../src/index.js';
import { PROXY_ALLOWED_HOSTS, validateProxyUrl } from '../src/proxy.js';

/** @param {Buffer | string} content */
function digestOf(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/**
 * @param {string} vaultPath
 * @param {object} [overrides]
 */
function makeApp(vaultPath, overrides = {}) {
  return buildApp({
    vaultPath,
    watch: false,
    termsAccepted: true,
    authToken: '',
    ...overrides,
  });
}

/** @returns {Promise<string>} */
async function makeVault() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'myobs-plugins-'));
}

/**
 * @param {string} root
 * @param {string} relativePath
 * @param {string | Buffer} contents
 */
async function writeFile(root, relativePath, contents) {
  const absolute = path.join(root, relativePath);
  await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
  await fs.promises.writeFile(absolute, contents);
}

/**
 * A local stand-in for the upstream hosts the proxy talks to.
 *
 * @returns {Promise<{
 *   url: string,
 *   requests: { url: string, headers: http.IncomingHttpHeaders }[],
 *   close: () => Promise<void>
 * }>}
 */
async function startUpstream() {
  /** @type {{ url: string, headers: http.IncomingHttpHeaders }[]} */
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers });

    if (req.url === '/ok') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'upstream=1; Path=/',
      });
      res.end('{"hello":true}');
      return;
    }
    if (req.url === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          accept: req.headers.accept ?? null,
          cookie: req.headers.cookie ?? null,
          authorization: req.headers.authorization ?? null,
        }),
      );
      return;
    }
    if (req.url === '/missing') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('upstream says no');
      return;
    }
    if (req.url === '/slow') {
      // Never respond: the proxy's header timeout must fire.
      return;
    }
    if (req.url === '/stall') {
      // Send headers, then nothing: the proxy must time out waiting for the
      // first body chunk.
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.flushHeaders();
      return;
    }
    if (req.url === '/big') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': '1000',
      });
      res.end(Buffer.alloc(1000));
      return;
    }
    if (req.url === '/chunked-big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(Buffer.alloc(200));
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/ok' });
      res.end();
      return;
    }
    if (req.url === '/redirect-evil') {
      res.writeHead(302, { location: 'http://evil.example/steal' });
      res.end();
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('unknown');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/**
 * A local stand-in for api.github.com and the release asset host.
 *
 * @returns {Promise<{
 *   url: string,
 *   state: {
 *     requests: string[],
 *     release: null | {
 *       tag: string,
 *       files: Record<string, string | Buffer>,
 *       digests?: Record<string, string | null>
 *     }
 *   },
 *   close: () => Promise<void>
 * }>}
 */
async function startGithubStub() {
  const state = {
    /** @type {string[]} */
    requests: [],
    /** @type {null | { tag: string, files: Record<string, string | Buffer>, digests?: Record<string, string | null> }} */
    release: null,
  };

  /** @type {http.Server} */
  let server;
  server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    state.requests.push(requestUrl.pathname);

    if (requestUrl.pathname.startsWith('/repos/')) {
      const match =
        /^\/repos\/([^/]+)\/([^/]+)\/releases\/(latest|tags\/(.+))$/.exec(
          requestUrl.pathname,
        );
      if (match === null || state.release === null) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"message":"Not Found"}');
        return;
      }
      if (match[3] !== 'latest' && decodeURIComponent(match[4]) !== state.release.tag) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"message":"Not Found"}');
        return;
      }

      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const base = `http://127.0.0.1:${address.port}`;

      const assets = Object.entries(state.release.files).map(([name, content]) => {
        const overridden =
          state.release.digests !== undefined &&
          Object.prototype.hasOwnProperty.call(state.release.digests, name);
        return {
          name,
          browser_download_url: `${base}/assets/${encodeURIComponent(name)}`,
          ...(overridden
            ? state.release.digests?.[name] === null
              ? {}
              : { digest: state.release.digests?.[name] }
            : { digest: digestOf(content) }),
        };
      });

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tag_name: state.release.tag, assets }));
      return;
    }

    if (requestUrl.pathname.startsWith('/assets/')) {
      const name = decodeURIComponent(requestUrl.pathname.slice('/assets/'.length));
      const content = state.release?.files?.[name];
      if (content === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(buffer.length),
      });
      res.end(buffer);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  return {
    url: `http://127.0.0.1:${address.port}`,
    state,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

describe('GET /api/proxy — allowlist and SSRF', () => {
  /** @type {string} */
  let vault;
  /** @type {import('fastify').FastifyInstance} */
  let app;

  before(async () => {
    vault = await makeVault();
    app = await makeApp(vault, {
      proxy: {
        // Never hits the network: the allowlist check happens before fetch.
        fetchImpl: async () =>
          new Response('allowed', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          }),
      },
    });
  });

  after(async () => {
    if (app) await app.close();
    await fs.promises.rm(vault, { recursive: true, force: true });
  });

  /**
   * @param {string} target
   * @param {object} [headers]
   */
  function get(target, headers) {
    return app.inject({
      method: 'GET',
      url: `/api/proxy?url=${encodeURIComponent(target)}`,
      headers,
    });
  }

  it('allows an allowlisted https URL', async () => {
    const response = await get('https://raw.githubusercontent.com/o/r/master/community-plugins.json');
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, 'allowed');
  });

  it('allows explicit ports 80 and 443', async () => {
    for (const port of ['80', '443']) {
      const response = await get(`https://github.com:${port}/o/r`);
      assert.equal(response.statusCode, 200, `port ${port}: ${response.body}`);
    }
  });

  it('rejects plain http', async () => {
    const response = await get('http://github.com/o/r');
    assert.equal(response.statusCode, 403);
    assert.match(response.json().error.message, /https/);
  });

  it('rejects an unexpected port', async () => {
    const response = await get('https://github.com:8443/o/r');
    assert.equal(response.statusCode, 403);
    assert.match(response.json().error.message, /443/);
  });

  it('rejects 127.0.0.1', async () => {
    const response = await get('https://127.0.0.1/secret');
    assert.equal(response.statusCode, 403);
    assert.match(response.json().error.message, /private/);
  });

  it('rejects localhost', async () => {
    const response = await get('https://localhost/secret');
    assert.equal(response.statusCode, 403);
    assert.match(response.json().error.message, /private/);
  });

  it('rejects file: URLs', async () => {
    const response = await get('file:///etc/passwd');
    assert.equal(response.statusCode, 403);
    assert.match(response.json().error.message, /https/);
  });

  it('rejects hosts outside the allowlist', async () => {
    const response = await get('https://evil.example/steal');
    assert.equal(response.statusCode, 403);
    assert.equal(response.headers['x-myobs-proxy'], '1');
    assert.equal(response.headers['x-myobs-proxy-error'], 'EPERM');
    assert.match(response.json().error.message, /not in the server proxy allowlist/);
    assert.match(response.json().error.message, /packages\/server\/src\/proxy\.js/);
  });

  it('rejects lookalike hosts', async () => {
    const response = await get('https://github.com.evil.example/steal');
    assert.equal(response.statusCode, 403);
  });

  it('rejects embedded credentials', async () => {
    const response = await get('https://user:pass@github.com/o/r');
    assert.equal(response.statusCode, 403);
    assert.match(response.json().error.message, /credentials/);
  });

  it('rejects a missing url parameter', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/proxy' });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'EINVAL');
  });

  it('rejects an unparseable url', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/proxy?url=not-a-url',
    });
    assert.equal(response.statusCode, 400);
  });
});

describe('GET /api/proxy — upstream behaviour', () => {
  /** @type {string} */
  let vault;
  /** @type {import('fastify').FastifyInstance} */
  let app;
  /** @type {Awaited<ReturnType<typeof startUpstream>>} */
  let upstream;

  before(async () => {
    vault = await makeVault();
    upstream = await startUpstream();
    app = await makeApp(vault, {
      proxy: {
        // Test-only: the production default allows neither http nor IP hosts.
        allowHttp: true,
        allowedHosts: ['127.0.0.1'],
        maxBytes: 100,
        timeoutMs: 500,
      },
    });
  });

  after(async () => {
    if (app) await app.close();
    if (upstream) await upstream.close();
    await fs.promises.rm(vault, { recursive: true, force: true });
  });

  /**
   * @param {string} target
   * @param {object} [headers]
   */
  function get(target, headers) {
    return app.inject({
      method: 'GET',
      url: `/api/proxy?url=${encodeURIComponent(target)}`,
      headers,
    });
  }

  it('streams a 200 and strips Set-Cookie', async () => {
    const response = await get(`${upstream.url}/ok`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, '{"hello":true}');
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-myobs-proxy'], '1');
  });

  it('forwards Accept but not Cookie or Authorization', async () => {
    const response = await get(`${upstream.url}/echo`, {
      accept: 'application/vnd.github+json',
      cookie: 'myobs_token=secret',
      authorization: 'Bearer secret',
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      accept: 'application/vnd.github+json',
      cookie: null,
      authorization: null,
    });
  });

  it('passes an upstream 404 through unchanged', async () => {
    const response = await get(`${upstream.url}/missing`);
    assert.equal(response.statusCode, 404);
    assert.equal(response.body, 'upstream says no');
    assert.equal(response.headers['x-myobs-proxy'], '1');
    assert.equal(response.headers['x-myobs-proxy-error'], undefined);
  });

  it('follows a redirect after re-validating it', async () => {
    const response = await get(`${upstream.url}/redirect`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, '{"hello":true}');
  });

  it('refuses a redirect that leaves the allowlist', async () => {
    const response = await get(`${upstream.url}/redirect-evil`);
    assert.equal(response.statusCode, 403);
    assert.match(response.json().error.message, /not in the server proxy allowlist/);
  });

  it('returns 502 when Content-Length exceeds the cap', async () => {
    const response = await get(`${upstream.url}/big`);
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error.code, 'ETOOBIG');
  });

  it('returns 502 when a chunked body exceeds the cap', async () => {
    const response = await get(`${upstream.url}/chunked-big`);
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error.code, 'ETOOBIG');
  });

  it('returns 504 when upstream headers do not arrive in time', async () => {
    const response = await get(`${upstream.url}/slow`);
    assert.equal(response.statusCode, 504);
    assert.equal(response.json().error.code, 'ETIMEDOUT');
  });

  it('returns 504 when the first body chunk never arrives', async () => {
    const response = await get(`${upstream.url}/stall`);
    assert.equal(response.statusCode, 504);
    assert.equal(response.json().error.code, 'ETIMEDOUT');
  });
});

describe('GET /api/proxy — GitHub release assets', () => {
  /** @type {string} */
  let vault;
  /** @type {import('fastify').FastifyInstance} */
  let app;

  before(async () => {
    vault = await makeVault();
  });

  after(async () => {
    if (app) await app.close();
    await fs.promises.rm(vault, { recursive: true, force: true });
  });

  it('keeps release-assets.githubusercontent.com in the production allowlist', () => {
    assert.ok(PROXY_ALLOWED_HOSTS.includes('release-assets.githubusercontent.com'));
    assert.doesNotThrow(() =>
      validateProxyUrl(
        'https://release-assets.githubusercontent.com/github-production-release-asset/x?token=1',
      ),
    );
  });

  it('follows a github.com release redirect to release-assets under the default allowlist', async () => {
    /** @type {string[]} */
    const calls = [];
    app = await makeApp(vault, {
      proxy: {
        // No allowedHosts/allowHttp overrides: this exercises the same policy
        // the browser hits in production.
        fetchImpl: async (url) => {
          calls.push(url);
          if (url === 'https://github.com/o/r/releases/download/v1/main.js') {
            return new Response(null, {
              status: 302,
              headers: {
                location:
                  'https://release-assets.githubusercontent.com/github-production-release-asset/x?token=1',
              },
            });
          }
          if (
            url ===
            'https://release-assets.githubusercontent.com/github-production-release-asset/x?token=1'
          ) {
            return new Response('asset-bytes', {
              status: 200,
              headers: { 'content-type': 'application/octet-stream' },
            });
          }
          throw new Error(`unexpected upstream URL: ${url}`);
        },
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/proxy?url=${encodeURIComponent('https://github.com/o/r/releases/download/v1/main.js')}`,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.body, 'asset-bytes');
    assert.deepEqual(calls, [
      'https://github.com/o/r/releases/download/v1/main.js',
      'https://release-assets.githubusercontent.com/github-production-release-asset/x?token=1',
    ]);
  });
});

describe('GET /api/plugins', () => {
  /** @type {string} */
  let vault;
  /** @type {import('fastify').FastifyInstance} */
  let app;

  before(async () => {
    vault = await makeVault();
    app = await makeApp(vault);
  });

  after(async () => {
    if (app) await app.close();
    await fs.promises.rm(vault, { recursive: true, force: true });
  });

  it('returns an empty list when the plugins directory is absent', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/plugins' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true, plugins: [], errors: [] });
  });

  it('lists a valid manifest and reads the enabled list', async () => {
    await writeFile(
      vault,
      '.obsidian/plugins/demo/manifest.json',
      JSON.stringify({
        id: 'demo',
        name: 'Demo Plugin',
        version: '1.2.3',
        minAppVersion: '1.0.0',
        isDesktopOnly: false,
      }),
    );
    await writeFile(
      vault,
      '.obsidian/community-plugins.json',
      JSON.stringify(['demo', 'not-installed']),
    );

    const response = await app.inject({ method: 'GET', url: '/api/plugins' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(body.errors, []);
    assert.deepEqual(body.plugins, [
      {
        id: 'demo',
        name: 'Demo Plugin',
        version: '1.2.3',
        minAppVersion: '1.0.0',
        isDesktopOnly: false,
        enabled: true,
        dir: 'demo',
      },
    ]);
  });

  it('reports a broken manifest without hiding the valid plugins', async () => {
    await writeFile(vault, '.obsidian/plugins/broken/manifest.json', '{not json');

    const response = await app.inject({ method: 'GET', url: '/api/plugins' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.plugins.length, 1);
    assert.equal(body.errors.length, 1);
    assert.equal(body.errors[0].dir, 'broken');
    assert.match(body.errors[0].message, /JSON/);
  });
});

describe('POST /api/plugins/install', () => {
  /** @type {string} */
  let vault;
  /** @type {import('fastify').FastifyInstance} */
  let app;
  /** @type {Awaited<ReturnType<typeof startGithubStub>>} */
  let github;

  before(async () => {
    vault = await makeVault();
    github = await startGithubStub();
    app = await makeApp(vault, {
      plugins: {
        githubApiBase: github.url,
        // Test-only: the stub speaks http on 127.0.0.1.
        allowInsecureDownload: true,
      },
    });
  });

  after(async () => {
    if (app) await app.close();
    if (github) await github.close();
    await fs.promises.rm(vault, { recursive: true, force: true });
  });

  /**
   * @param {object} body
   */
  function install(body) {
    return app.inject({ method: 'POST', url: '/api/plugins/install', payload: body });
  }

  /**
   * @param {string} id
   * @param {object} [overrides]
   */
  function setRelease(id, overrides = {}) {
    github.state.release = {
      tag: 'v1.2.3',
      files: {
        'manifest.json': JSON.stringify({
          id,
          name: 'Demo',
          version: '1.2.3',
        }),
        'main.js': 'console.log("demo");\n',
      },
      ...overrides,
    };
  }

  it('installs the latest release atomically', async () => {
    setRelease('demo', {
      files: {
        'manifest.json': JSON.stringify({ id: 'demo', name: 'Demo', version: '1.2.3' }),
        'main.js': 'console.log("demo");\n',
        'styles.css': '.demo { color: red; }\n',
      },
    });

    const response = await install({ repo: 'owner/obsidian-demo' });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), {
      ok: true,
      id: 'demo',
      version: '1.2.3',
      files: ['manifest.json', 'main.js', 'styles.css'],
    });

    const dir = path.join(vault, '.obsidian/plugins/demo');
    assert.equal(
      await fs.promises.readFile(path.join(dir, 'main.js'), 'utf8'),
      'console.log("demo");\n',
    );
    assert.equal(
      JSON.parse(await fs.promises.readFile(path.join(dir, 'manifest.json'), 'utf8')).id,
      'demo',
    );
    assert.equal(
      await fs.promises.readFile(path.join(dir, 'styles.css'), 'utf8'),
      '.demo { color: red; }\n',
    );

    // No temp/backup directories survive a successful install.
    const entries = await fs.promises.readdir(path.join(vault, '.obsidian/plugins'));
    assert.deepEqual(entries.sort(), ['demo']);

    // Installation must not enable the plugin.
    await assert.rejects(
      fs.promises.readFile(path.join(vault, '.obsidian/community-plugins.json'), 'utf8'),
      /ENOENT/,
    );
  });

  it('uses the requested tag', async () => {
    setRelease('demo');
    github.state.release.tag = 'v9.9.9';

    const response = await install({ repo: 'owner/obsidian-demo', version: 'v9.9.9' });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(
      github.state.requests.includes('/repos/owner/obsidian-demo/releases/tags/v9.9.9'),
      github.state.requests.join(', '),
    );
  });

  it('replaces an existing plugin, removes old files, and keeps data.json', async () => {
    await writeFile(vault, '.obsidian/plugins/demo/old.txt', 'old');
    await writeFile(vault, '.obsidian/plugins/demo/data.json', '{"setting":true}');
    setRelease('demo');

    const response = await install({ repo: 'owner/obsidian-demo' });
    assert.equal(response.statusCode, 200, response.body);
    await assert.rejects(
      fs.promises.readFile(path.join(vault, '.obsidian/plugins/demo/old.txt'), 'utf8'),
      /ENOENT/,
    );
    assert.equal(
      await fs.promises.readFile(
        path.join(vault, '.obsidian/plugins/demo/data.json'),
        'utf8',
      ),
      '{"setting":true}',
    );
  });

  it('accepts a JSON body sent as form-urlencoded (curl -d default)', async () => {
    setRelease('form-demo');
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugins/install',
      payload: JSON.stringify({ repo: 'owner/obsidian-demo' }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().id, 'form-demo');
  });

  it('rejects malformed repos', async () => {
    for (const repo of [
      'owner',
      'owner/',
      '/repo',
      'owner/repo/extra',
      '../repo',
      'owner/..',
      'owner/re po',
      'own er/repo',
    ]) {
      const response = await install({ repo });
      assert.equal(response.statusCode, 400, `repo=${JSON.stringify(repo)}: ${response.body}`);
      assert.equal(response.json().error.code, 'EINVAL');
    }
  });

  it('rejects a manifest with an unsafe id and writes nothing', async () => {
    setRelease('../../escape');
    const response = await install({ repo: 'owner/obsidian-demo' });
    assert.equal(response.statusCode, 422, response.body);
    assert.equal(response.json().error.code, 'EINVALID');
    await assert.rejects(
      fs.promises.access(path.join(vault, 'escape')),
      /ENOENT/,
    );
  });

  it('rejects a manifest missing id or version', async () => {
    github.state.release = {
      tag: 'v1.2.3',
      files: {
        'manifest.json': JSON.stringify({ name: 'No id', version: '1.0.0' }),
        'main.js': 'x',
      },
    };
    const missingId = await install({ repo: 'owner/obsidian-demo' });
    assert.equal(missingId.statusCode, 422, missingId.body);

    github.state.release.files['manifest.json'] = JSON.stringify({ id: 'demo' });
    const missingVersion = await install({ repo: 'owner/obsidian-demo' });
    assert.equal(missingVersion.statusCode, 422, missingVersion.body);
  });

  it('rejects an empty main.js', async () => {
    github.state.release = {
      tag: 'v1.2.3',
      files: {
        'manifest.json': JSON.stringify({ id: 'demo', version: '1.0.0' }),
        'main.js': '',
      },
    };
    const response = await install({ repo: 'owner/obsidian-demo' });
    assert.equal(response.statusCode, 422, response.body);
    assert.match(response.json().error.message, /main\.js is empty/);
  });

  it('rejects a digest mismatch', async () => {
    github.state.release = {
      tag: 'v1.2.3',
      files: {
        'manifest.json': JSON.stringify({ id: 'digest-demo', version: '1.0.0' }),
        'main.js': 'console.log(1);',
      },
      digests: { 'main.js': `sha256:${'0'.repeat(64)}` },
    };
    const response = await install({ repo: 'owner/obsidian-demo' });
    assert.equal(response.statusCode, 422, response.body);
    assert.match(response.json().error.message, /digest mismatch/);
    await assert.rejects(
      fs.promises.access(path.join(vault, '.obsidian/plugins/digest-demo')),
      /ENOENT/,
    );
  });

  it('reports a missing main.js asset', async () => {
    github.state.release = {
      tag: 'v1.2.3',
      files: {
        'manifest.json': JSON.stringify({ id: 'demo', version: '1.0.0' }),
      },
    };
    const response = await install({ repo: 'owner/obsidian-demo' });
    assert.equal(response.statusCode, 404, response.body);
    assert.match(response.json().error.message, /main\.js/);
  });

  it('passes a GitHub 404 through as 404', async () => {
    github.state.release = null;
    const response = await install({ repo: 'owner/does-not-exist' });
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(response.json().error.code, 'ENOENT');
  });
});

describe('POST /api/plugins/uninstall', () => {
  /** @type {string} */
  let vault;
  /** @type {import('fastify').FastifyInstance} */
  let app;

  before(async () => {
    vault = await makeVault();
    app = await makeApp(vault);
  });

  after(async () => {
    if (app) await app.close();
    await fs.promises.rm(vault, { recursive: true, force: true });
  });

  /**
   * @param {object} body
   */
  function uninstall(body) {
    return app.inject({ method: 'POST', url: '/api/plugins/uninstall', payload: body });
  }

  it('moves the plugin into .trash instead of deleting it', async () => {
    await writeFile(vault, '.obsidian/plugins/demo/manifest.json', '{"id":"demo","version":"1.0.0"}');
    await writeFile(vault, '.obsidian/plugins/demo/main.js', 'console.log(1);');
    await writeFile(vault, '.obsidian/community-plugins.json', '["demo"]');

    const response = await uninstall({ id: 'demo' });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), {
      ok: true,
      id: 'demo',
      trashedTo: '.trash/plugins/demo',
    });

    await assert.rejects(
      fs.promises.access(path.join(vault, '.obsidian/plugins/demo')),
      /ENOENT/,
    );
    assert.equal(
      await fs.promises.readFile(path.join(vault, '.trash/plugins/demo/main.js'), 'utf8'),
      'console.log(1);',
    );
    // Uninstalling must not curate the enabled list on the user's behalf.
    assert.equal(
      await fs.promises.readFile(
        path.join(vault, '.obsidian/community-plugins.json'),
        'utf8',
      ),
      '["demo"]',
    );
  });

  it('never overwrites an existing trash entry', async () => {
    await writeFile(vault, '.obsidian/plugins/demo/main.js', 'new copy');
    await writeFile(vault, '.trash/plugins/demo/keep.txt', 'older copy');

    const response = await uninstall({ id: 'demo' });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().trashedTo, '.trash/plugins/demo-1');

    assert.equal(
      await fs.promises.readFile(path.join(vault, '.trash/plugins/demo/keep.txt'), 'utf8'),
      'older copy',
    );
    assert.equal(
      await fs.promises.readFile(path.join(vault, '.trash/plugins/demo-1/main.js'), 'utf8'),
      'new copy',
    );
  });

  it('rejects id traversal and missing ids', async () => {
    for (const id of ['../../etc', '..', '.', 'a/b', 'a\\b', '']) {
      const response = await uninstall({ id });
      assert.equal(response.statusCode, 400, `id=${JSON.stringify(id)}: ${response.body}`);
      assert.equal(response.json().error.code, 'EINVAL');
    }
  });

  it('reports a plugin that is not installed', async () => {
    const response = await uninstall({ id: 'not-installed' });
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(response.json().error.code, 'ENOENT');
  });
});
