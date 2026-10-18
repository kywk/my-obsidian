/**
 * Static assets and the boot injection into the runtime HTML.
 *
 * GET /obsidian/* serves vendor/obsidian verbatim (app.js must stay
 * byte-identical to the official release). GET / reads
 * packages/runtime/index.html and replaces <!-- MYOBS_BOOT --> with the
 * synchronous boot object from CONTRACTS.md §1.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isInside } from './paths.js';
import { consentPage, withConsentTerms } from './consent.js';

export const BOOT_MARKER = '<!-- MYOBS_BOOT -->';

/** PWA surface. The runtime template is not ours to edit, so `/` injects these. */
export const MANIFEST_PATH = '/manifest.webmanifest';
export const MANIFEST_JSON_PATH = '/manifest.json';
export const SERVICE_WORKER_PATH = '/sw.js';
export const THEME_COLOR = '#1e1e1e';
export const BACKGROUND_COLOR = '#1e1e1e';

/** Minimal page used when packages/runtime/index.html does not exist yet. */
export const FALLBACK_RUNTIME_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>my-obsidian</title>
${BOOT_MARKER}
</head>
<body>
<p>runtime/index.html 尚未建立；server 已啟動，boot 物件已注入。</p>
</body></html>
`;

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.cjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.ico', 'image/x-icon'],
  ['.bmp', 'image/bmp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.eot', 'application/vnd.ms-fontobject'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
]);

/**
 * @param {string} filePath
 * @returns {string}
 */
export function contentTypeFor(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function safeDecode(raw) {
  if (typeof raw !== 'string') return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Build the synchronous boot script. JSON is escaped so a vault name
 * containing "</script>" cannot terminate the tag.
 *
 * @param {object} boot
 * @returns {string}
 */
export function renderBootScript(boot) {
  const json = JSON.stringify(boot)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `<script>window.__MYOBS = ${json};</script>`;
}

/**
 * @param {string} template
 * @param {object} boot
 * @returns {string}
 */
export function injectBoot(template, boot) {
  const script = renderBootScript(boot);
  if (template.includes(BOOT_MARKER)) {
    return template.replace(BOOT_MARKER, script);
  }
  // The contract template carries the marker. If it is missing (hand-written
  // test fixture), inject immediately after <head> so the object still exists
  // before any shim or app script.
  const headOpen = /<head\b[^>]*>/i.exec(template);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return `${template.slice(0, at)}${script}\n${template.slice(at)}`;
  }
  return `${script}\n${template}`;
}

/**
 * PWA manifest. The vault name gives the installed app its identity; the
 * short name stays constant because it is shown under a launcher icon and a
 * vault directory name can be arbitrarily long.
 *
 * icon.png is 512x512 (verified from its IHDR). One entry is enough for
 * Chrome's install criteria (>=192px) and avoids claiming a 192px asset that
 * does not exist.
 *
 * @param {{ vaultName?: string }} [options]
 * @returns {object}
 */
export function buildManifest(options = {}) {
  const vaultName = typeof options.vaultName === 'string' ? options.vaultName.trim() : '';
  return {
    name: vaultName === '' ? 'Obsidian' : `${vaultName} - Obsidian`,
    short_name: 'Obsidian',
    description: 'Obsidian renderer served from a self-hosted vault.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    theme_color: THEME_COLOR,
    background_color: BACKGROUND_COLOR,
    icons: [
      {
        src: '/obsidian/icon.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  };
}

/**
 * Inject the manifest/theme tags into the runtime HTML. index.html is frozen
 * (it is the contract template), so this is a string injection in the `/`
 * handler, immediately before </head>.
 *
 * @param {string} html
 * @returns {string}
 */
export function injectPwaHead(html) {
  const tags = [
    `<link rel="manifest" href="${MANIFEST_PATH}">`,
    `<meta name="theme-color" content="${THEME_COLOR}">`,
    '<link rel="apple-touch-icon" href="/obsidian/icon.png">',
  ].join('\n');
  if (/rel=["']manifest["']/i.test(html)) return html;
  const at = html.lastIndexOf('</head>');
  if (at === -1) return `${html}\n${tags}`;
  return `${html.slice(0, at)}${tags}\n${html.slice(at)}`;
}

/**
 * @param {string} dir
 * @param {string} urlPrefix
 * @returns {Promise<string[]>}
 */
async function listScripts(dir, urlPrefix) {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
      .map((entry) => `${urlPrefix}${entry.name}`)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Service worker source.
 *
 * Contract (DESIGN.md §3 item 13): static assets only. `/api/fs`, `/api/watch`
 * and `/v/*` must never enter the browser cache — a vault note cached by a
 * service worker survives sign-out, consent changes and server-side edits, and
 * would be served to the next person using the browser profile.
 *
 * Network-first for the allowlist: the server sends `no-store` for shim and
 * runtime code, so cache-first would serve stale code after every edit. The
 * cache exists for offline reloads, not for masking deployments.
 *
 * @param {string[]} precache absolute URL paths
 * @returns {string}
 */
export function serviceWorkerSource(precache) {
  const list = JSON.stringify(precache, null, 0);
  return `/* my-obsidian service worker — generated by packages/server/src/static.js.
 *
 * Caches static renderer assets only. Vault content (/api/fs, /api/watch,
 * /v/*) is deliberately absent from both the precache and the fetch handler.
 */
'use strict';

const CACHE_NAME = 'myobs-static-v1';
const PRECACHE = ${list};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        // One missing optional asset must not fail the whole install.
        Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => undefined))),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('myobs-static-') && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isStaticAsset(pathname) {
  if (pathname === '/obsidian/app.css' || pathname === '/obsidian/icon.png') return true;
  // Classic scripts only: /runtime/index.html is a template that must receive
  // the per-request boot object from "/", and consent.html is a gate page.
  if (pathname.startsWith('/shim/') || pathname.startsWith('/runtime/')) {
    return pathname.endsWith('.js');
  }
  // Defence in depth: even if a caller sends a confusing path, never let the
  // vault API or attachment route into the cache.
  if (pathname.startsWith('/v/') || pathname.startsWith('/api/')) return false;
  return false;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (!isStaticAsset(url.pathname)) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined);
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((hit) => hit || new Response('offline', {
          status: 504,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })),
      ),
  );
});
`;
}

/**
 * The gate page shown while the operator has not recorded consent.
 *
 * Delegates to consentPage() so GET / and GET /consent are the same page: the
 * one the operator uses to record the acknowledgement (DESIGN.md §8). It is not
 * a plain explanation page any more.
 *
 * @param {object} options
 * @param {string} [options.consentHtmlPath]
 * @param {string} [options.configPath]
 * @param {{ termsAccepted: boolean, termsText: string, source?: string|null }} options.consent
 * @returns {string}
 */
function termsPage(options) {
  const { consent } = options;
  return consentPage({
    consentHtmlPath: options.consentHtmlPath,
    configPath: options.configPath,
    accepted: consent.termsAccepted,
    source: consent.source ?? null,
  });
}

/**
 * @param {string} vendorDir
 * @param {string} relativePath
 * @returns {string}
 */
function vendorMissingMessage(vendorDir, relativePath) {
  return [
    `找不到 Obsidian 靜態資產: ${relativePath || '(空路徑)'}`,
    `vendor 目錄: ${vendorDir}`,
    '請先執行 scripts/fetch-obsidian.mjs 取得 vendor/obsidian/*。',
  ].join('\n');
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {object} options
 * @param {string} options.vendorDir
 * @param {string} options.runtimeIndexPath
 * @param {object} options.boot Base boot object; the terms fields are added per
 *   request from `consent` so the gate follows the consent state without a
 *   restart (CONTRACTS.md §1).
 * @param {{ termsAccepted: boolean, termsText: string, source?: string|null }} options.consent
 *   Live consent holder, read on every request. A plain snapshot is still
 *   accepted as a fallback below so an out-of-tree caller does not break.
 * @param {boolean} [options.termsAccepted] Legacy snapshot, only used when
 *   `consent` is absent.
 * @param {string} [options.configPath] Consent config path, shown on the page.
 * @param {string} [options.consentHtmlPath] Consent page template.
 * @returns {void}
 */
export function registerStaticRoutes(app, options) {
  const { vendorDir, shimDir, runtimeIndexPath, boot } = options;
  const consent =
    options.consent ??
    Object.freeze({
      termsAccepted: Boolean(options.termsAccepted),
      termsText: options.termsAccepted ? options.termsText ?? '' : '',
      source: null,
    });

  /**
   * Serves one asset tree with containment checks and symlink verification.
   *
   * `gateAppJs` exists because the renderer itself may only be delivered after
   * the operator accepted the terms (docs/DESIGN.md §8); everything else under
   * vendor/ is inert.
   *
   * @param {string} rootDir absolute directory to serve from
   * @param {(relativePath: string) => string} missing
   * @param {{ gateAppJs?: boolean, cacheControl?: string }} [opts]
   */
  function assetTree(rootDir, missing, opts = {}) {
    const root = path.resolve(rootDir);

    return async function handle(request, reply) {
      const raw = /** @type {{ '*'?: string }} */ (request.params)['*'] ?? '';
      const requested = safeDecode(raw).replace(/^\/+/, '');

      let relative;
      try {
        relative = path.posix.normalize(requested);
      } catch {
        relative = '';
      }

      const reject = () =>
        reply.code(404).type('text/plain; charset=utf-8').send(missing(requested));

      if (opts.gateAppJs && relative === 'app.js' && !consent.termsAccepted) {
        return reply
          .code(403)
          .type('text/plain; charset=utf-8')
          .send(
            [
              '尚未完成授權聲明確認，依照 CONTRACTS.md §1 不提供 /obsidian/app.js。',
              '請開 GET / 完成同意畫面上的確認（或設定 TERMS_ACK 環境變數後重新啟動）。',
              '寫入設定檔後立即生效，不需要重新啟動 server。',
            ].join('\n'),
          );
      }

      if (
        relative === '' ||
        relative === '.' ||
        relative === '..' ||
        relative.startsWith('../') ||
        relative.includes('\0') ||
        path.isAbsolute(relative)
      ) {
        return reject();
      }

      const absolute = path.resolve(root, ...relative.split('/'));
      if (!isInside(root, absolute)) return reject();

      let st;
      try {
        st = await fs.promises.stat(absolute);
      } catch (err) {
        const code = /** @type {NodeJS.ErrnoException} */ (err).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return reject();
        throw err;
      }
      if (!st.isFile()) return reject();

      const realRoot = await fs.promises.realpath(root).catch(() => root);
      const real = await fs.promises.realpath(absolute).catch(() => absolute);
      if (!isInside(realRoot, real)) return reject();

      reply
        .code(200)
        .header('Content-Type', contentTypeFor(relative))
        .header('Content-Length', String(st.size))
        .header('Cache-Control', opts.cacheControl ?? 'no-cache')
        .send(fs.createReadStream(absolute));
      return reply;
    };
  }

  app.get(
    '/obsidian/*',
    assetTree(vendorDir, (rel) => vendorMissingMessage(vendorDir, rel), {
      gateAppJs: true,
    }),
  );

  // Obsidian lazy-loads its heavy libraries with root-absolute paths --
  // yE("/lib/mermaid.min.js"), yE("/lib/pdfjs/pdf.min.mjs"),
  // yE("/lib/prism.min.js"), yE("/lib/mathjax/obsidian-mathjax.js"),
  // yE("/lib/reveal/reveal.js"), yE("/lib/codemirror/modes.min.js").
  //
  // On desktop the document base is app://obsidian.md/, so "/lib" means the app
  // root. Here the app root is /obsidian/, so /lib must be registered as an
  // alias. Without it Mermaid, the PDF viewer, syntax highlighting, MathJax and
  // Slides all 404, and their lazy-load promises reject with a bare Event --
  // which shows up as an unhandled rejection rather than a missing asset.
  app.get(
    '/lib/*',
    assetTree(path.join(vendorDir, 'lib'), (rel) =>
      vendorMissingMessage(vendorDir, `lib/${rel}`),
    ),
  );

  // The runtime page loads the shim layer from /shim/*. Without this route the
  // classic scripts 404, window.require never exists, and app.js dies on its
  // first line -- the single most likely way to break boot.
  app.get(
    '/shim/*',
    assetTree(
      shimDir,
      (rel) =>
        [
          `shim script not found: /shim/${rel}`,
          `expected under: ${shimDir}`,
          'the shim layer lives in packages/shim/src and is not generated.',
        ].join('\n'),
      // Shim edits must reach the browser immediately; a stale cache here looks
      // exactly like a code bug.
      { cacheControl: 'no-store' },
    ),
  );

  // The runtime layer next to index.html (plugin-watch.js today). index.html
  // itself is served through "/" so the boot object can be injected; this route
  // is plain static files and must not duplicate the injection logic.
  // The root is derived from runtimeIndexPath rather than configured twice, so
  // the two cannot drift apart.
  const runtimeDir = path.dirname(path.resolve(runtimeIndexPath));
  app.get(
    '/runtime/*',
    assetTree(
      runtimeDir,
      (rel) =>
        [
          `runtime script not found: /runtime/${rel}`,
          `expected under: ${runtimeDir}`,
          'the runtime layer lives in packages/runtime and is not generated.',
        ].join('\n'),
      { cacheControl: 'no-store' },
    ),
  );

  // Browsers request /favicon.ico unconditionally; serve Obsidian's own icon
  // rather than logging a 404 on every load.
  app.get('/favicon.ico', async (request, reply) => {
    const icon = path.join(vendorDir, 'icon.png');
    try {
      const st = await fs.promises.stat(icon);
      return reply
        .code(200)
        .header('Content-Type', 'image/png')
        .header('Content-Length', String(st.size))
        .header('Cache-Control', 'no-cache')
        .send(fs.createReadStream(icon));
    } catch {
      return reply.code(404).send();
    }
  });

  // PWA surface (DESIGN.md §3 item 13). The manifest is generated from the
  // same boot object the page receives, so the installed app name follows the
  // vault instead of a second configuration value.
  const manifest = buildManifest({ vaultName: boot && boot.vaultName });
  const sendManifest = async (request, reply) => {
    const asJson = request.url.startsWith(MANIFEST_JSON_PATH);
    return reply
      .code(200)
      .header(
        'Content-Type',
        asJson ? 'application/json; charset=utf-8' : 'application/manifest+json; charset=utf-8',
      )
      // A stale manifest pins the wrong start_url/name after a vault change.
      .header('Cache-Control', 'no-cache')
      .send(JSON.stringify(manifest));
  };
  app.get(MANIFEST_PATH, sendManifest);
  app.get(MANIFEST_JSON_PATH, sendManifest);

  app.get(SERVICE_WORKER_PATH, async (request, reply) => {
    const precache = [
      // app.css and the icon are stable assets. app.js is deliberately absent:
      // it is consent-gated, and a cached copy would survive the gate closing
      // (CONTRACTS.md §1, DESIGN.md §8).
      '/obsidian/app.css',
      '/obsidian/icon.png',
      ...(await listScripts(shimDir, '/shim/')),
      ...(await listScripts(runtimeDir, '/runtime/')),
    ];
    return reply
      .code(200)
      .header('Content-Type', 'text/javascript; charset=utf-8')
      // The service worker script itself must never be cached at the HTTP
      // layer; a stale worker cannot be updated by the next page load.
      .header('Cache-Control', 'no-cache')
      // The worker lives at /sw.js but must control the whole origin.
      .header('Service-Worker-Allowed', '/')
      .send(serviceWorkerSource(precache));
  });

  app.get('/', async (request, reply) => {
    // Consent state changes without a restart, so this page must never be
    // cached -- a stale copy would keep showing the gate (or leak past it).
    reply.header('Cache-Control', 'no-store');

    if (!consent.termsAccepted) {
      return reply
        .type('text/html; charset=utf-8')
        .send(
          termsPage({
            consent,
            configPath: options.configPath,
            consentHtmlPath: options.consentHtmlPath,
          }),
        );
    }

    let template;
    try {
      template = await fs.promises.readFile(runtimeIndexPath, 'utf8');
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        template = FALLBACK_RUNTIME_HTML;
      } else {
        throw err;
      }
    }

    return reply
      .type('text/html; charset=utf-8')
      .send(injectPwaHead(injectBoot(template, withConsentTerms(boot, consent))));
  });
}
