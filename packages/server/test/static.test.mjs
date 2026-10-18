/**
 * PWA surface: manifest, service worker, and the head injection that keeps
 * packages/runtime/index.html untouched.
 *
 * The service worker contract is a security boundary, not a performance knob:
 * /api/fs, /api/watch and /v/* must never be cached (DESIGN.md §3 item 13).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildApp } from '../src/index.js';
import {
  MANIFEST_JSON_PATH,
  MANIFEST_PATH,
  SERVICE_WORKER_PATH,
  buildManifest,
  injectPwaHead,
  serviceWorkerSource,
} from '../src/static.js';

/** @type {import('fastify').FastifyInstance} */
let app;
/** @type {string} */
let base;
/** @type {string} */
let vault;
/** @type {string} */
let vendorDir;
/** @type {string} */
let runtimeDir;
/** @type {string} */
let shimDir;

before(async () => {
  base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'myobs-pwa-'));
  vault = path.join(base, 'vault');
  vendorDir = path.join(base, 'vendor');
  runtimeDir = path.join(base, 'runtime');
  shimDir = path.join(base, 'shim');

  await fs.promises.mkdir(vault, { recursive: true });
  await fs.promises.mkdir(path.join(vendorDir, 'lib'), { recursive: true });
  await fs.promises.mkdir(runtimeDir, { recursive: true });
  await fs.promises.mkdir(shimDir, { recursive: true });

  await fs.promises.writeFile(path.join(vendorDir, 'app.js'), 'window.__APP__ = true;\n');
  await fs.promises.writeFile(path.join(vendorDir, 'app.css'), '.theme-dark{}\n');
  await fs.promises.writeFile(path.join(vendorDir, 'icon.png'), 'png');
  await fs.promises.writeFile(path.join(shimDir, 'boot-data.js'), '/* boot */\n');
  await fs.promises.writeFile(path.join(shimDir, 'print.js'), '/* shim */\n');
  await fs.promises.writeFile(path.join(runtimeDir, 'print.js'), '/* runtime */\n');
  await fs.promises.writeFile(path.join(runtimeDir, 'consent.html'), '<html></html>');
  await fs.promises.writeFile(
    path.join(runtimeDir, 'index.html'),
    [
      '<!doctype html>',
      '<html><head>',
      '<!-- MYOBS_BOOT -->',
      '<link href="/obsidian/app.css" rel="stylesheet">',
      '</head>',
      '<body class="theme-dark"></body>',
      '</html>',
    ].join('\n'),
  );

  app = await buildApp({
    vaultPath: vault,
    watch: false,
    termsAccepted: true,
    termsText: 'synthetic-acknowledgement-for-pwa-tests-0123456789',
    authToken: '',
    vendorDir,
    shimDir,
    runtimeIndexPath: path.join(runtimeDir, 'index.html'),
  });
});

after(async () => {
  if (app) await app.close();
  await fs.promises.rm(base, { recursive: true, force: true });
});

describe('manifest', () => {
  it('serves a complete web app manifest with no-cache', async () => {
    const response = await app.inject({ method: 'GET', url: MANIFEST_PATH });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'application/manifest+json; charset=utf-8');
    assert.equal(response.headers['cache-control'], 'no-cache');

    const manifest = response.json();
    assert.equal(manifest.start_url, '/');
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.theme_color, '#1e1e1e');
    assert.equal(manifest.background_color, '#1e1e1e');
    assert.equal(typeof manifest.name, 'string');
    assert.equal(typeof manifest.short_name, 'string');
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
    assert.equal(manifest.icons[0].src, '/obsidian/icon.png');
    assert.equal(manifest.icons[0].sizes, '512x512');
    assert.equal(manifest.icons[0].type, 'image/png');
  });

  it('also answers /manifest.json for clients that ask for it', async () => {
    const response = await app.inject({ method: 'GET', url: MANIFEST_JSON_PATH });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(response.json().display, 'standalone');
  });
});

describe('service worker', () => {
  it('serves JavaScript with the scope header and no-cache', async () => {
    const response = await app.inject({ method: 'GET', url: SERVICE_WORKER_PATH });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(response.headers['cache-control'], 'no-cache');
    assert.equal(response.headers['service-worker-allowed'], '/');
  });

  it('precaches static assets only', async () => {
    const response = await app.inject({ method: 'GET', url: SERVICE_WORKER_PATH });
    const match = /const PRECACHE = (\[[^\]]*\]);/.exec(response.body);
    assert.ok(match, 'PRECACHE array not found');
    const precache = JSON.parse(match[1]);

    assert.ok(precache.includes('/obsidian/app.css'));
    assert.ok(precache.includes('/obsidian/icon.png'));
    assert.ok(precache.includes('/shim/boot-data.js'));
    assert.ok(precache.includes('/shim/print.js'));
    assert.ok(precache.includes('/runtime/print.js'));

    // app.js is consent-gated: a cached copy would outlive the gate.
    assert.ok(!precache.includes('/obsidian/app.js'));
    assert.ok(!precache.includes('/runtime/index.html'));
    assert.ok(!precache.includes('/runtime/consent.html'));

    // Vault content must never enter the browser cache.
    for (const url of precache) {
      assert.ok(!url.startsWith('/v/'), `precache must not contain ${url}`);
      assert.ok(!url.startsWith('/api/'), `precache must not contain ${url}`);
    }
  });

  it('does not intercept vault or API requests', () => {
    const source = serviceWorkerSource(['/obsidian/app.css']);
    assert.match(source, /pathname\.startsWith\('\/v\/'\) \|\| pathname\.startsWith\('\/api\/'\)\) return false/);
    assert.match(source, /request\.method !== 'GET'/);
    assert.match(source, /url\.origin !== self\.location\.origin/);
    // Templates are not static assets: /runtime/index.html must always be
    // served through "/" so the boot object is injected.
    assert.match(source, /pathname\.endsWith\('\.js'\)/);
  });
});

describe('head injection', () => {
  it('injects manifest and theme tags before </head> without touching the template', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    assert.equal(response.statusCode, 200);

    const manifestAt = response.body.indexOf('<link rel="manifest"');
    const themeAt = response.body.indexOf('<meta name="theme-color"');
    const headEnd = response.body.indexOf('</head>');
    assert.ok(manifestAt > 0, 'manifest link missing');
    assert.ok(themeAt > 0, 'theme-color missing');
    assert.ok(manifestAt < headEnd);
    assert.ok(themeAt < headEnd);

    // The boot object still precedes every script (CONTRACTS.md §1).
    assert.ok(response.body.indexOf('window.__MYOBS') < response.body.indexOf('/obsidian/app.css'));
  });

  it('is idempotent', () => {
    const once = injectPwaHead('<html><head></head><body></body></html>');
    const twice = injectPwaHead(once);
    assert.equal(twice, once);
    assert.equal(once.match(/rel="manifest"/g).length, 1);
  });

  it('falls back to the vault name in the manifest title', () => {
    assert.equal(buildManifest({ vaultName: 'notes' }).name, 'notes - Obsidian');
    assert.equal(buildManifest({ vaultName: '' }).name, 'Obsidian');
    assert.equal(buildManifest().short_name, 'Obsidian');
  });
});
