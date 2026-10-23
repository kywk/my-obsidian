/**
 * Consent gate: storage, page, live state, and the routes that drive them.
 *
 * Every fixture value here is a synthetic string. The renderer's real
 * acknowledgement literal must never appear in this repository (AGENTS.md hard
 * rule 3), and one test at the bottom actively enforces that for consent.html.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildApp } from '../src/index.js';
import {
  MIN_TERMS_LENGTH,
  consentPage,
  createConsentState,
  defaultConfigPath,
  readConsent,
  REQUIRED_ACKNOWLEDGEMENTS,
  CONSENT_NOTICE_VERSION,
  withConsentTerms,
  writeConsent,
} from '../src/consent.js';

/** Synthetic acknowledgement, long enough to pass validation. */
const ACK = 'synthetic-acknowledgement-for-tests-only-0123456789';
/** A different synthetic value, used to prove a rewrite replaces the old one. */
const ACK2 = 'second-synthetic-acknowledgement-for-tests-9876543210';

/** @type {string} */
let tmp;

before(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'myobs-consent-'));
});

after(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

/**
 * @param {string} name
 * @returns {Promise<string>} a fresh directory inside the per-test temp root
 */
async function freshDir(name) {
  const dir = path.join(tmp, `${name}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

describe('defaultConfigPath', () => {
  it('follows MYOBS_CONFIG when set', () => {
    const previous = process.env.MYOBS_CONFIG;
    process.env.MYOBS_CONFIG = path.join(tmp, 'custom/config.json');
    try {
      assert.equal(defaultConfigPath(), path.join(tmp, 'custom/config.json'));
    } finally {
      if (previous === undefined) delete process.env.MYOBS_CONFIG;
      else process.env.MYOBS_CONFIG = previous;
    }
  });

  it('ignores an empty MYOBS_CONFIG and falls back to the user config dir', () => {
    const previous = process.env.MYOBS_CONFIG;
    process.env.MYOBS_CONFIG = '   ';
    try {
      assert.equal(
        defaultConfigPath(),
        path.join(os.homedir(), '.config', 'my-obsidian', 'config.json'),
      );
    } finally {
      if (previous === undefined) delete process.env.MYOBS_CONFIG;
      else process.env.MYOBS_CONFIG = previous;
    }
  });
});

describe('readConsent', () => {
  it('returns null for a missing file', async () => {
    const dir = await freshDir('read-missing');
    assert.equal(readConsent(path.join(dir, 'config.json')), null);
  });

  it('returns null for a directory', async () => {
    const dir = await freshDir('read-dir');
    assert.equal(readConsent(dir), null);
  });

  it('returns null for broken JSON', async () => {
    const dir = await freshDir('read-broken');
    const target = path.join(dir, 'config.json');
    await fs.promises.writeFile(target, '{"termsText": "truncated');
    assert.equal(readConsent(target), null);
  });

  it('returns null when termsText is missing, not a string, or blank', async () => {
    const dir = await freshDir('read-shape');
    for (const payload of ['{}', '[]', '"ack"', '{"termsText": 42}', '{"termsText": "   "}']) {
      const target = path.join(dir, `config-${Math.random().toString(36).slice(2, 8)}.json`);
      await fs.promises.writeFile(target, payload);
      assert.equal(readConsent(target), null, `payload ${payload}`);
    }
  });

  it('returns null for a truncated value below the sanity bound', async () => {
    const dir = await freshDir('read-short');
    const target = path.join(dir, 'config.json');
    await fs.promises.writeFile(target, JSON.stringify({ termsText: 'a'.repeat(MIN_TERMS_LENGTH - 1) }));
    assert.equal(readConsent(target), null);
  });

  it('returns the stored string, trimmed of surrounding whitespace', async () => {
    const dir = await freshDir('read-ok');
    const target = path.join(dir, 'config.json');
    await fs.promises.writeFile(target, JSON.stringify({ termsText: `\n${ACK} ` }));
    assert.deepEqual(readConsent(target), { termsText: ACK });
  });
});

describe('writeConsent', () => {
  it('writes the value and creates the directory 0700 / file 0600', async () => {
    const dir = await freshDir('write-mode');
    const target = path.join(dir, 'nested', 'my-obsidian', 'config.json');

    const written = await writeConsent(target, ACK);

    assert.equal(written, target);
    assert.deepEqual(readConsent(target), { termsText: ACK });
    assert.equal((await fs.promises.stat(target)).mode & 0o777, 0o600);
    assert.equal((await fs.promises.stat(path.dirname(target))).mode & 0o777, 0o700);
  });

  it('keeps unrelated keys that other workstreams may have stored', async () => {
    const dir = await freshDir('write-merge');
    const target = path.join(dir, 'config.json');
    await fs.promises.writeFile(target, JSON.stringify({ vault: 'x', termsText: ACK }));

    await writeConsent(target, ACK2);

    const parsed = JSON.parse(await fs.promises.readFile(target, 'utf8'));
    assert.equal(parsed.vault, 'x');
    assert.equal(parsed.termsText, ACK2);
  });

  it('replaces the whole value atomically and leaves no temp files behind', async () => {
    const dir = await freshDir('write-atomic');
    const target = path.join(dir, 'config.json');
    await writeConsent(target, ACK);

    await writeConsent(target, ACK2);

    // The file is complete JSON with the new value -- never a mix of both.
    const raw = await fs.promises.readFile(target, 'utf8');
    assert.deepEqual(JSON.parse(raw), { termsText: ACK2 });
    assert.equal(readConsent(target).termsText, ACK2);
    assert.deepEqual(
      (await fs.promises.readdir(dir)).filter((name) => name !== 'config.json'),
      [],
    );
  });

  it('keeps the previous file when the swap fails', async () => {
    const dir = await freshDir('write-fail');
    const target = path.join(dir, 'config.json');
    await writeConsent(target, ACK);
    const before = await fs.promises.readFile(target, 'utf8');

    // Inject an I/O failure at the rename, which is the only step that makes
    // the new content visible.
    const realRename = fs.promises.rename;
    fs.promises.rename = async () => {
      throw Object.assign(new Error('injected EIO'), { code: 'EIO' });
    };
    try {
      await assert.rejects(() => writeConsent(target, ACK2), /injected EIO/);
    } finally {
      fs.promises.rename = realRename;
    }

    assert.equal(await fs.promises.readFile(target, 'utf8'), before);
    assert.equal(readConsent(target).termsText, ACK);
    assert.deepEqual(
      (await fs.promises.readdir(dir)).filter((name) => name !== 'config.json'),
      [],
      'the temp file must be cleaned up after a failed swap',
    );
  });

  it('refuses values below the sanity bound', async () => {
    const dir = await freshDir('write-short');
    const target = path.join(dir, 'config.json');
    await assert.rejects(
      () => writeConsent(target, 'a'.repeat(MIN_TERMS_LENGTH - 1)),
      /短於/,
    );
    assert.equal(fs.existsSync(target), false);
  });
});

describe('createConsentState', () => {
  it('derives acceptance from the text, not from a flag', () => {
    const closed = createConsentState({});
    assert.equal(closed.termsAccepted, false);
    assert.equal(closed.termsText, '');
    assert.equal(closed.source, null);

    const open = createConsentState({ termsText: ACK });
    assert.equal(open.termsAccepted, true);
    assert.equal(open.source, 'option');
  });

  it('lets an explicit false close the gate, but never open it', () => {
    const closed = createConsentState({ termsAccepted: false, termsText: ACK });
    assert.equal(closed.termsAccepted, false);
    assert.equal(closed.termsText, '');

    // `true` alone is not a source of acceptance.
    const stillClosed = createConsentState({ termsAccepted: true });
    assert.equal(stillClosed.termsAccepted, false);
  });

  it('prefers option text over TERMS_ACK over the config file', async () => {
    const dir = await freshDir('state-precedence');
    const configPath = path.join(dir, 'config.json');
    await writeConsent(configPath, ACK2);

    assert.equal(createConsentState({ termsText: ACK, envTermsText: ACK2, configPath }).source, 'option');
    assert.equal(createConsentState({ envTermsText: ACK, configPath }).source, 'env');
    assert.equal(createConsentState({ configPath }).source, 'config');
  });

  it('sees the config file change without being recreated', async () => {
    const dir = await freshDir('state-live');
    const configPath = path.join(dir, 'config.json');
    const state = createConsentState({ configPath });
    assert.equal(state.termsAccepted, false);

    await writeConsent(configPath, ACK);

    assert.equal(state.termsAccepted, true);
    assert.equal(state.termsText, ACK);
    assert.equal(state.source, 'config');
  });

  it('ignores a config file whose value is below the sanity bound', async () => {
    const dir = await freshDir('state-short');
    const configPath = path.join(dir, 'config.json');
    await fs.promises.writeFile(configPath, JSON.stringify({ termsText: 'too short' }));
    assert.equal(createConsentState({ configPath }).termsAccepted, false);
  });
});

describe('withConsentTerms', () => {
  it('injects termsText only when accepted', () => {
    const accepted = withConsentTerms({ vaultId: 'v' }, { termsAccepted: true, termsText: ACK });
    assert.equal(accepted.termsAccepted, true);
    assert.equal(accepted.termsText, ACK);
    assert.equal(accepted.vaultId, 'v');
  });

  it('drops a stale termsText when the gate closes', () => {
    const denied = withConsentTerms(
      { vaultId: 'v', termsAccepted: true, termsText: ACK },
      { termsAccepted: false, termsText: '' },
    );
    assert.equal(denied.termsAccepted, false);
    assert.equal('termsText' in denied, false);
  });
});

describe('consentPage', () => {
  it('renders the shipped page with the current state as a data island', async () => {
    const html = consentPage({ configPath: '/tmp/example/config.json', accepted: false });

    assert.match(html, /id="myobs-consent-data"/);
    assert.match(html, /\/api\/consent/);
    assert.match(html, /id="terms"/);
    assert.match(html, /TERMS_ACK/);
    // The page is not the renderer: it must not carry the boot payload the
    // runtime page is recognised by (an existing test relies on this).
    assert.ok(!html.includes('window.__MYOBS'));

    const island = /<script type="application\/json" id="myobs-consent-data">(.*?)<\/script>/s.exec(html);
    assert.ok(island, 'data island missing');
    assert.deepEqual(JSON.parse(island[1]), {
      accepted: false,
      source: null,
      configPath: '/tmp/example/config.json',
      minLength: MIN_TERMS_LENGTH,
    });
  });

  it('escapes the data island so a path cannot close the script tag', () => {
    const html = consentPage({ configPath: '/tmp/</script><script>alert(1)</script>' });
    assert.ok(!html.includes('</script><script>alert(1)'));
    const island = /<script type="application\/json" id="myobs-consent-data">(.*?)<\/script>/s.exec(html);
    assert.ok(island, 'data island missing');
    assert.match(JSON.parse(island[1]).configPath, /alert\(1\)/);
  });

  it('falls back to a working page when the template is missing', () => {
    const html = consentPage({
      consentHtmlPath: path.join(tmp, 'no-such-consent-page.html'),
      accepted: false,
    });
    assert.match(html, /\/api\/consent/);
    assert.match(html, /TERMS_ACK/);
    // The fallback has no marker of its own; the data island is appended.
    assert.match(html, /myobs-consent-data/);
  });
});

describe('GET / and /obsidian/app.js follow the live consent state', () => {
  /** @type {import('fastify').FastifyInstance} */
  let app;
  let vaultRoot;
  let configPath;

  before(async () => {
    const base = await freshDir('routes');
    vaultRoot = path.join(base, 'vault');
    const vendorDir = path.join(base, 'vendor');
    await fs.promises.mkdir(vaultRoot, { recursive: true });
    await fs.promises.mkdir(vendorDir, { recursive: true });
    await fs.promises.writeFile(path.join(vendorDir, 'app.js'), 'window.__APP__ = true;\n');
    const runtimePath = path.join(base, 'index.html');
    await fs.promises.writeFile(
      runtimePath,
      '<!doctype html><html><head><!-- MYOBS_BOOT --></head><body></body></html>',
    );
    configPath = path.join(base, 'config', 'config.json');

    app = await buildApp({
      vaultPath: vaultRoot,
      watch: false,
      vendorDir,
      runtimeIndexPath: runtimePath,
      configPath,
      // Stay independent of whatever is in the developer's environment.
      envTermsText: '',
      authToken: '',
    });
  });

  after(async () => {
    if (app) await app.close();
  });

  it('serves the consent page with no-store while nothing is recorded', async () => {
    const page = await app.inject({ method: 'GET', url: '/' });
    assert.equal(page.statusCode, 200);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.body, /id="terms"/);
    assert.ok(!page.body.includes('window.__MYOBS'), 'the gate must not leak the boot payload');

    const explicit = await app.inject({ method: 'GET', url: '/consent' });
    assert.equal(explicit.statusCode, 200);
    assert.equal(explicit.headers['cache-control'], 'no-store');
    assert.match(explicit.body, /id="terms"/);
  });

  it('refuses app.js while nothing is recorded', async () => {
    const response = await app.inject({ method: 'GET', url: '/obsidian/app.js' });
    assert.equal(response.statusCode, 403);
    assert.match(response.body, /CONTRACTS\.md/);
  });

  it('rejects an empty body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/consent',
      payload: { termsText: '' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().ok, false);
    assert.match(response.json().error.message, /空的/);
    assert.equal(fs.existsSync(configPath), false, 'a rejected post must not write the file');
  });

  it('rejects a value below the sanity bound and explains why', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/consent',
      payload: { termsText: 'too-short-to-be-the-real-thing' },
    });
    assert.equal(response.statusCode, 400);
    const body = response.json();
    assert.equal(body.ok, false);
    assert.match(body.error.message, /短於/);
    assert.equal(fs.existsSync(configPath), false);
  });

  it('rejects a request without termsText or without JSON', async () => {
    const missing = await app.inject({ method: 'POST', url: '/api/consent', payload: {} });
    assert.equal(missing.statusCode, 400);
    assert.match(missing.json().error.message, /termsText/);

    const notJson = await app.inject({
      method: 'POST',
      url: '/api/consent',
      headers: { 'content-type': 'application/json' },
      payload: 'not json at all',
    });
    assert.equal(notJson.statusCode, 400);
    assert.match(notJson.json().error.message, /JSON/);
  });

  it('refuses a valid string without every acknowledgement', async () => {
    const none = await app.inject({
      method: 'POST',
      url: '/api/consent',
      payload: { termsText: ACK },
    });
    assert.equal(none.statusCode, 400);
    assert.equal(none.json().error.code, 'EACK');
    assert.match(none.json().error.message, /unofficial/);

    const partial = await app.inject({
      method: 'POST',
      url: '/api/consent',
      payload: { termsText: ACK, acknowledgements: ['unofficial', 'obsidian-terms'] },
    });
    assert.equal(partial.statusCode, 400);
    assert.match(partial.json().error.message, /private-use/);
    assert.equal(fs.existsSync(configPath), false, 'a refused post must not write the file');
  });

  it('accepts the value, and both routes follow without a restart', async () => {
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/consent',
      payload: { termsText: ` ${ACK}\n`, acknowledgements: [...REQUIRED_ACKNOWLEDGEMENTS] },
    });
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(accepted.json(), { ok: true });
    assert.deepEqual(readConsent(configPath), { termsText: ACK });
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(stored.acknowledgements, [...REQUIRED_ACKNOWLEDGEMENTS]);
    assert.equal(stored.noticeVersion, CONSENT_NOTICE_VERSION);
    assert.ok(!Number.isNaN(Date.parse(stored.acknowledgedAt)));

    // Same app instance as the 403 above: no restart happened.
    const appJs = await app.inject({ method: 'GET', url: '/obsidian/app.js' });
    assert.equal(appJs.statusCode, 200);
    assert.equal(appJs.body, 'window.__APP__ = true;\n');

    const page = await app.inject({ method: 'GET', url: '/' });
    assert.equal(page.statusCode, 200);
    const bootMatch = /window\.__MYOBS = (\{.*?\});<\/script>/s.exec(page.body);
    assert.ok(bootMatch, 'boot JSON not found');
    const boot = JSON.parse(bootMatch[1]);
    assert.equal(boot.termsAccepted, true);
    assert.equal(boot.termsText, ACK);
  });

  it('closes the gate again when the config file goes away', async () => {
    await fs.promises.rm(configPath, { force: true });
    const appJs = await app.inject({ method: 'GET', url: '/obsidian/app.js' });
    assert.equal(appJs.statusCode, 403);
    const page = await app.inject({ method: 'GET', url: '/' });
    assert.ok(!page.body.includes('window.__MYOBS'));
  });
});

describe('repository hygiene', () => {
  it('consent.html never contains the renderer literal from the vendor bundle', () => {
    const vendorPath = new URL('../../../vendor/obsidian/app.js', import.meta.url);
    if (!fs.existsSync(vendorPath)) {
      // vendor/ is generated by scripts/fetch-obsidian.mjs and is gitignored.
      return;
    }
    const source = fs.readFileSync(vendorPath, 'utf8');
    const marker = '.ipcRenderer.sendSync("terms")';
    const at = source.indexOf(marker);
    assert.ok(at > 0, 'terms gate not found in the vendor bundle');
    const open = source.lastIndexOf('"', at - 2);
    const close = source.lastIndexOf('"', open - 1);
    const literal = source.slice(close + 1, open);
    assert.ok(literal.length >= MIN_TERMS_LENGTH, 'extracted literal looks wrong');

    const html = fs.readFileSync(new URL('../../runtime/consent.html', import.meta.url), 'utf8');
    // Booleans only: a failure must not print the literal into the test log.
    assert.ok(!html.includes(literal), 'packages/runtime/consent.html must not carry the literal');
  });
});
