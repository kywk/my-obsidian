/**
 * DNS-rebinding hardening for GET /api/proxy (CONTRACTS.md §8).
 *
 * The allowlist is a *name* check; this file pins down the second check that
 * follows it: every hop's hostname is resolved and refused when any answer is
 * private or reserved. The resolver is injected (lookupImpl), so no test needs
 * real DNS and none of them can be affected by the machine's resolver.
 *
 * Deliberately not tested here: the TOCTOU window itself. `fetch` resolves the
 * name again after the check, so this is a mitigation that forces an attacker
 * to answer twice; pinning would need a custom dispatcher, which the proxy API
 * does not use. See the comment on assertPublicResolution().
 *
 * Only temporary directories are used.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildApp } from '../src/index.js';

/** @type {string} */
let vault;

before(async () => {
  vault = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'myobs-dns-'));
  await fs.promises.writeFile(path.join(vault, 'note.md'), 'vault\n');
});

after(async () => {
  await fs.promises.rm(vault, { recursive: true, force: true });
});

/**
 * A lookupImpl that answers from a table.
 *
 * @param {Record<string, string[] | Error>} table
 * @returns {((hostname: string, options: object) => Promise<Array<{address: string, family: number}>>) & { calls: Array<{host: string, options: object}> }}
 */
function lookupTable(table) {
  const calls = [];
  const impl = async (host, options) => {
    calls.push({ host, options });
    const entry = table[host];
    if (entry === undefined) {
      const err = new Error(`getaddrinfo ENOTFOUND ${host}`);
      // @ts-expect-error errno-style code
      err.code = 'ENOTFOUND';
      throw err;
    }
    if (entry instanceof Error) throw entry;
    return entry.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    }));
  };
  impl.calls = calls;
  return impl;
}

/**
 * @param {object} proxy
 * @param {object} [overrides]
 */
function makeApp(proxy, overrides = {}) {
  return buildApp({
    vaultPath: vault,
    watch: false,
    termsAccepted: true,
    authToken: '',
    proxy,
    ...overrides,
  });
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {string} target
 */
function proxyRequest(app, target) {
  return app.inject({
    method: 'GET',
    url: `/api/proxy?url=${encodeURIComponent(target)}`,
  });
}

/** @param {string} [body] */
function okResponse(body = 'upstream-ok') {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/** @returns {(input: string, init: object) => Promise<Response>} with a call log */
function fetchStub(handler) {
  const calls = [];
  const impl = async (input, init) => {
    calls.push({ input, init });
    return handler(input, init);
  };
  impl.calls = calls;
  return impl;
}

/**
 * One case per address class. `expect` is the HTTP status the proxy must
 * return; every rejection must carry X-MyOBS-Proxy-Error.
 */
const ADDRESS_CASES = [
  { name: 'private IPv4 10/8', address: '10.0.0.5', status: 403, code: 'EPERM' },
  { name: 'loopback IPv4 127/8', address: '127.0.0.1', status: 403, code: 'EPERM' },
  { name: 'link-local IPv4 169.254/16', address: '169.254.169.254', status: 403, code: 'EPERM' },
  { name: 'carrier-grade NAT 100.64/10', address: '100.64.0.1', status: 403, code: 'EPERM' },
  { name: 'unique-local IPv6 fc00::/7', address: 'fd12:3456:789a::1', status: 403, code: 'EPERM' },
  { name: 'link-local IPv6 fe80::/10', address: 'fe80::1', status: 403, code: 'EPERM' },
  { name: 'multicast IPv6 ff00::/8', address: 'ff02::1', status: 403, code: 'EPERM' },
  { name: 'IPv4-mapped IPv6 (dotted)', address: '::ffff:127.0.0.1', status: 403, code: 'EPERM' },
  { name: 'IPv4-mapped IPv6 (hex)', address: '::ffff:7f00:1', status: 403, code: 'EPERM' },
  { name: 'IPv4-mapped private 10/8', address: '::ffff:a00:5', status: 403, code: 'EPERM' },
  { name: 'IPv4-compatible loopback', address: '::127.0.0.1', status: 403, code: 'EPERM' },
  { name: 'Teredo 2001::/32', address: '2001:0000:4136:e378:8000:63bf:3fff:fdd2', status: 403, code: 'EPERM' },
  { name: '6to4 that embeds 127.0.0.1', address: '2002:7f00:1::1', status: 403, code: 'EPERM' },
  { name: 'documentation 2001:db8::/32', address: '2001:db8::1', status: 403, code: 'EPERM' },
  { name: 'public IPv4', address: '93.184.216.34', status: 200, code: null },
  {
    name: 'public IPv6',
    address: '2606:2800:220:1:248:1893:25c8:1946',
    status: 200,
    code: null,
  },
  {
    name: 'IPv4-mapped public IPv6',
    address: '::ffff:93.184.216.34',
    status: 200,
    code: null,
  },
];

describe('GET /api/proxy — DNS rebinding mitigation', () => {
  for (const testCase of ADDRESS_CASES) {
    it(`${testCase.status === 200 ? 'allows' : 'refuses'} ${testCase.name}`, async () => {
      const lookupImpl = lookupTable({ 'plugins.example': [testCase.address] });
      const fetchImpl = fetchStub(() => okResponse());
      const app = await makeApp({ allowedHosts: ['plugins.example'], lookupImpl, fetchImpl });

      try {
        const response = await proxyRequest(app, 'https://plugins.example/community-plugins.json');
        assert.equal(response.statusCode, testCase.status);
        if (testCase.status === 200) {
          assert.equal(response.body, 'upstream-ok');
          assert.equal(fetchImpl.calls.length, 1);
        } else {
          assert.equal(response.json().error.code, testCase.code);
          assert.equal(response.headers['x-myobs-proxy-error'], testCase.code);
          assert.match(response.json().error.message, /private or reserved address/);
          assert.equal(fetchImpl.calls.length, 0, 'must not connect after a private answer');
        }
        assert.equal(lookupImpl.calls.length, 1);
        assert.equal(lookupImpl.calls[0].host, 'plugins.example');
        assert.equal(lookupImpl.calls[0].options.all, true, 'must ask for every answer');
      } finally {
        await app.close();
      }
    });
  }

  it('refuses when any answer is private, even if others are public', async () => {
    const lookupImpl = lookupTable({
      'plugins.example': ['93.184.216.34', '10.1.2.3', '2606:2800:220:1::1'],
    });
    const fetchImpl = fetchStub(() => okResponse());
    const app = await makeApp({ allowedHosts: ['plugins.example'], lookupImpl, fetchImpl });

    try {
      const response = await proxyRequest(app, 'https://plugins.example/stats.json');
      assert.equal(response.statusCode, 403);
      assert.match(response.json().error.message, /10\.1\.2\.3/);
      assert.equal(fetchImpl.calls.length, 0);
    } finally {
      await app.close();
    }
  });

  it('never caches an answer: two requests resolve twice', async () => {
    const lookupImpl = lookupTable({ 'plugins.example': ['93.184.216.34'] });
    const fetchImpl = fetchStub(() => okResponse());
    const app = await makeApp({ allowedHosts: ['plugins.example'], lookupImpl, fetchImpl });

    try {
      await proxyRequest(app, 'https://plugins.example/a.json');
      await proxyRequest(app, 'https://plugins.example/b.json');
      assert.equal(lookupImpl.calls.length, 2);
    } finally {
      await app.close();
    }
  });

  it('maps a resolver failure to 502 EBADGATEWAY, not 403', async () => {
    const lookupImpl = lookupTable({}); // every host is ENOTFOUND
    const fetchImpl = fetchStub(() => okResponse());
    const app = await makeApp({ allowedHosts: ['plugins.example'], lookupImpl, fetchImpl });

    try {
      const response = await proxyRequest(app, 'https://plugins.example/missing.json');
      assert.equal(response.statusCode, 502);
      assert.equal(response.json().error.code, 'EBADGATEWAY');
      assert.match(response.json().error.message, /DNS lookup failed/);
      assert.equal(fetchImpl.calls.length, 0);
    } finally {
      await app.close();
    }
  });

  it('maps an empty resolver answer to 502 EBADGATEWAY', async () => {
    const lookupImpl = lookupTable({ 'plugins.example': [] });
    const fetchImpl = fetchStub(() => okResponse());
    const app = await makeApp({ allowedHosts: ['plugins.example'], lookupImpl, fetchImpl });

    try {
      const response = await proxyRequest(app, 'https://plugins.example/none.json');
      assert.equal(response.statusCode, 502);
      assert.equal(response.json().error.code, 'EBADGATEWAY');
      assert.match(response.json().error.message, /no addresses/);
    } finally {
      await app.close();
    }
  });

  it('maps a resolver timeout to 504 ETIMEDOUT', async () => {
    const lookupImpl = () => new Promise(() => {});
    const fetchImpl = fetchStub(() => okResponse());
    const app = await makeApp({
      allowedHosts: ['plugins.example'],
      lookupImpl,
      fetchImpl,
      timeoutMs: 50,
    });

    try {
      const response = await proxyRequest(app, 'https://plugins.example/slow.json');
      assert.equal(response.statusCode, 504);
      assert.equal(response.json().error.code, 'ETIMEDOUT');
      assert.equal(fetchImpl.calls.length, 0);
    } finally {
      await app.close();
    }
  });

  it('checks every redirect hop and refuses a private redirect target', async () => {
    const lookupImpl = lookupTable({
      'plugins.example': ['93.184.216.34'],
      'cdn.example': ['10.0.0.7'],
    });
    const fetchImpl = fetchStub((input) => {
      if (String(input) === 'https://plugins.example/start') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example/asset.js' },
        });
      }
      return okResponse();
    });
    const app = await makeApp({
      allowedHosts: ['plugins.example', 'cdn.example'],
      lookupImpl,
      fetchImpl,
    });

    try {
      const response = await proxyRequest(app, 'https://plugins.example/start');
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error.code, 'EPERM');
      assert.match(response.json().error.message, /cdn\.example/);
      assert.equal(fetchImpl.calls.length, 1, 'the second hop must not be fetched');
      assert.deepEqual(
        lookupImpl.calls.map((call) => call.host),
        ['plugins.example', 'cdn.example'],
      );
    } finally {
      await app.close();
    }
  });

  it('still refuses literal private hosts before any resolver call', async () => {
    const lookupImpl = lookupTable({});
    const fetchImpl = fetchStub(() => okResponse());
    const app = await makeApp({ allowedHosts: ['127.0.0.1'], lookupImpl, fetchImpl });

    try {
      const response = await proxyRequest(app, 'https://127.0.0.1/anything');
      assert.equal(response.statusCode, 403);
      assert.equal(lookupImpl.calls.length, 0);
      assert.equal(fetchImpl.calls.length, 0);
    } finally {
      await app.close();
    }
  });
});
