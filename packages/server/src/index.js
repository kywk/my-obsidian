/**
 * my-obsidian server entry point.
 *
 * Plain ESM, no build step. See docs/CONTRACTS.md for the wire contracts.
 *
 * Environment:
 *   VAULT_PATH      required, absolute or resolvable vault directory
 *   PORT            default 3000
 *   HOST            default 127.0.0.1
 *   WATCH_DISABLED  set to 1 to skip chokidar
 *   AUTH_TOKEN      optional; requires cookie myobs_token=<AUTH_TOKEN>
 *   TERMS_ACK       optional; without it / serves an explanation page and
 *                   /obsidian/app.js is not served
 */

import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';

import { openVault, vaultError } from './paths.js';
import { handleFsRequest } from './fs-api.js';
import { registerStaticRoutes } from './static.js';
import { registerFileRoutes } from './files.js';
import { createVaultWatcher } from './watch.js';

export const DEFAULT_VENDOR_DIR = fileURLToPath(
  new URL('../../../vendor/obsidian/', import.meta.url),
);
export const DEFAULT_RUNTIME_INDEX = fileURLToPath(
  new URL('../../runtime/index.html', import.meta.url),
);
export const DEFAULT_SHIM_DIR = fileURLToPath(
  new URL('../../shim/src/', import.meta.url),
);

/**
 * @param {unknown} header
 * @param {string} name
 * @returns {string | undefined}
 */
export function readCookie(header, name) {
  if (typeof header !== 'string' || header === '') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

/**
 * @param {string | undefined} cookieHeader
 * @param {string} expected
 * @returns {boolean}
 */
export function isAuthorized(cookieHeader, expected) {
  const actual = readCookie(cookieHeader, 'myobs_token');
  if (actual === undefined) return false;
  const expectedBuffer = Buffer.from(expected, 'utf8');

  /** @param {string} value */
  const matches = (value) => {
    const a = Buffer.from(value, 'utf8');
    return a.length === expectedBuffer.length && timingSafeEqual(a, expectedBuffer);
  };

  if (matches(actual)) return true;
  // Browsers commonly percent-encode cookie values written from JavaScript.
  try {
    const decoded = decodeURIComponent(actual);
    if (decoded !== actual && matches(decoded)) return true;
  } catch {
    // Malformed percent escape: only the raw value could have matched.
  }
  return false;
}

/**
 * @param {string} vendorDir
 * @returns {Promise<{ version: string, build: string }>}
 */
async function detectObsidianVersion(vendorDir) {
  const candidates = ['version.json', 'package.json', 'manifest.json'];
  for (const name of candidates) {
    try {
      const raw = await fs.promises.readFile(path.join(vendorDir, name), 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string' && parsed !== '') {
        return { version: parsed, build: parsed };
      }
      if (parsed && typeof parsed.version === 'string' && parsed.version !== '') {
        const build =
          typeof parsed.build === 'string' && parsed.build !== ''
            ? parsed.build
            : parsed.version;
        return { version: parsed.version, build };
      }
    } catch {
      // Try the next candidate; fall back to the documented target version.
    }
  }
  return { version: '1.14.4', build: '1.14.4' };
}

/**
 * Build the CONTRACTS.md §1 boot object.
 *
 * `termsText` is not listed in §1, but the shim's boot validator (and the
 * renderer's `sendSync("terms")` comparison) needs the operator-entered
 * acknowledgement string. The server never hard-codes it; it comes from the
 * environment/config and is only injected when terms are accepted.
 *
 * @param {object} options
 * @param {string} options.vaultPath Canonical absolute vault path.
 * @param {boolean} options.termsAccepted
 * @param {string} [options.termsText]
 * @param {string} [options.vendorDir]
 * @param {string} [options.version]
 * @param {string} [options.build]
 * @returns {Promise<object>}
 */
/**
 * Managed-policy defaults.
 *
 * The renderer does `policy = Object.freeze(ipcRenderer.sendSync("policy"))`,
 * unconditionally REPLACING its own permissive default, and then gates every
 * community plugin, theme and snippet behind `policyAllows(policy.plugins, id)`.
 * Sending `{}` therefore disables all community plugins silently -- no error,
 * no log, the plugin simply never loads (found by the hot-reload workstream;
 * see docs/DESIGN.md §11.3).
 *
 * These values are byte-for-byte the desktop main process's own normal-build
 * default (`Bt` in app.asar/main.js), so we reproduce shipped behaviour rather
 * than inventing a policy.
 *
 * @type {{ plugins: boolean, themes: boolean, snippets: boolean, sync: boolean,
 *         publish: boolean, webViewer: boolean, devTools: boolean, insider: boolean }}
 */
export const DEFAULT_POLICY = Object.freeze({
  plugins: true,
  themes: true,
  snippets: true,
  sync: true,
  publish: true,
  webViewer: true,
  devTools: true,
  insider: true,
});

export async function buildBootInfo(options) {
  const { vaultPath, termsAccepted } = options;
  const vendorDir = options.vendorDir ?? DEFAULT_VENDOR_DIR;
  const detected = await detectObsidianVersion(vendorDir);

  const normalizedVaultPath =
    vaultPath.length > 1 ? vaultPath.replace(/[\\/]+$/, '') : vaultPath;
  const vaultName = path.basename(normalizedVaultPath) || 'vault';

  /** @type {{ [key: string]: unknown }} */
  const boot = {
    vaultId: vaultName,
    vaultName,
    vaultPath: normalizedVaultPath,
    resourcesPath: '/obsidian',
    resourcePrefix: '/v/',
    version: options.version ?? detected.version,
    build: options.build ?? detected.build,
    platform: process.platform,
    arch: process.arch,
    documentsDir: path.join(os.homedir(), 'Documents'),
    desktopDir: path.join(os.homedir(), 'Desktop'),
    policy: options.policy ?? DEFAULT_POLICY,
    termsAccepted,
    devMode: process.env.DEV_MODE === '1',
  };

  if (termsAccepted) {
    boot.termsText = options.termsText ?? process.env.TERMS_ACK ?? '';
  }

  return boot;
}

/**
 * @param {object} [options]
 * @param {string} [options.vaultPath] Defaults to VAULT_PATH.
 * @param {string} [options.host] Unused by buildApp; consumed by start().
 * @param {boolean} [options.termsAccepted] Defaults to Boolean(TERMS_ACK).
 * @param {string} [options.termsText] Defaults to TERMS_ACK; injected only when accepted.
 * @param {string} [options.authToken] Defaults to AUTH_TOKEN (empty = off).
 * @param {boolean} [options.watch] Defaults to WATCH_DISABLED !== '1'.
 * @param {boolean | object} [options.logger]
 * @param {string} [options.vendorDir]
 * @param {string} [options.runtimeIndexPath]
 * @param {object} [options.boot] Override the generated boot object.
 * @param {number} [options.bodyLimit] JSON body limit for /api/fs.
 * @param {number} [options.uploadBodyLimit] PUT /v/* body limit.
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function buildApp(options = {}) {
  const vaultPath = options.vaultPath ?? process.env.VAULT_PATH;
  if (!vaultPath) {
    throw vaultError('ENOENT', 'VAULT_PATH is not set');
  }

  const vault = await openVault(vaultPath);
  // Acceptance is "the operator supplied the acknowledgement text", not "some
  // variable is set". TERMS_ACK=1 used to mark the vault accepted while feeding
  // "1" to the renderer's sendSync("terms"), which makes Obsidian call
  // window.close() and stall on the fatal screen. Derive it from the string.
  const termsText = options.termsText ?? process.env.TERMS_ACK ?? '';
  const termsAccepted =
    options.termsAccepted ?? termsText.trim().length > 0;
  const authToken =
    options.authToken !== undefined
      ? options.authToken
      : process.env.AUTH_TOKEN || undefined;
  const watchEnabled =
    options.watch ?? process.env.WATCH_DISABLED !== '1';
  const vendorDir = options.vendorDir ?? DEFAULT_VENDOR_DIR;
  const shimDir = options.shimDir ?? DEFAULT_SHIM_DIR;
  const runtimeIndexPath = options.runtimeIndexPath ?? DEFAULT_RUNTIME_INDEX;

  const boot =
    options.boot ??
    (await buildBootInfo({
      vaultPath: vault.root,
      termsAccepted,
      termsText,
      vendorDir,
    }));

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: options.bodyLimit ?? 64 * 1024 * 1024,
  });

  await app.register(websocket);

  // PUT /v/* and any other non-JSON request body arrives as a Buffer.
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  app.setErrorHandler((err, _request, reply) => {
    if (reply.sent) return;
    const code =
      typeof /** @type {{ code?: unknown }} */ (err).code === 'string'
        ? /** @type {{ code: string }} */ (err).code
        : 'EUNKNOWN';
    const status =
      typeof /** @type {{ statusCode?: unknown }} */ (err).statusCode === 'number' &&
      /** @type {{ statusCode: number }} */ (err).statusCode >= 400
        ? /** @type {{ statusCode: number }} */ (err).statusCode
        : 500;
    reply
      .code(status)
      .type('application/json; charset=utf-8')
      .send({ ok: false, error: { code, message: err.message } });
  });

  if (authToken) {
    app.addHook('onRequest', async (request, reply) => {
      if (isAuthorized(request.headers.cookie, authToken)) return;
      return reply
        .code(401)
        .type('application/json; charset=utf-8')
        .send({
          ok: false,
          error: {
            code: 'EPERM',
            message: 'unauthorized: cookie myobs_token does not match AUTH_TOKEN',
          },
        });
    });
  }

  /** @type {Set<import('ws').WebSocket>} */
  const clients = new Set();

  /** @param {import('./watch.js').WatchEvent[]} events */
  function broadcast(events) {
    if (events.length === 0 || clients.size === 0) return;
    const payload = JSON.stringify({ type: 'change', events });
    for (const socket of clients) {
      if (socket.readyState !== 1) continue;
      try {
        socket.send(payload);
      } catch (err) {
        app.log.debug?.({ err }, 'websocket send failed');
      }
    }
  }

  let watcher = null;
  if (watchEnabled) {
    watcher = createVaultWatcher({
      vaultPath: vault.root,
      onEvents: broadcast,
      logger: app.log,
    });
    // Wait for chokidar's initial scan so the first WS client cannot miss an
    // external change that lands between listen() and scan completion.
    await watcher.ready;
  }

  app.get('/api/watch', { websocket: true }, (socket) => {
    clients.add(socket);
    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message && message.type === 'ping') {
        try {
          socket.send(JSON.stringify({ type: 'pong' }));
        } catch {
          // The peer disappeared; close() will clean up.
        }
      }
    });
    socket.on('close', () => {
      clients.delete(socket);
    });
    socket.on('error', () => {
      clients.delete(socket);
    });
  });

  app.post('/api/fs', async (request, reply) => {
    let response;
    try {
      response = await handleFsRequest(vault, request.body);
    } catch (err) {
      // handleFsRequest already converts everything; this is defence in depth.
      response = {
        ok: false,
        error: {
          code: /** @type {{ code?: string }} */ (err).code ?? 'EUNKNOWN',
          message: /** @type {Error} */ (err).message ?? String(err),
        },
      };
    }
    return reply.type('application/json; charset=utf-8').send(response);
  });

  registerStaticRoutes(app, {
    vendorDir,
    shimDir,
    runtimeIndexPath,
    boot,
    termsAccepted,
  });

  registerFileRoutes(app, {
    vault,
    bodyLimit: options.uploadBodyLimit,
  });

  app.addHook('onClose', async () => {
    if (watcher) await watcher.close();
    for (const socket of clients) {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    }
    clients.clear();
  });

  return app;
}

/**
 * CLI entry point.
 *
 * @returns {Promise<void>}
 */
export async function start() {
  if (!process.env.VAULT_PATH || process.env.VAULT_PATH.trim() === '') {
    console.error(
      [
        'VAULT_PATH 未設定，server 無法啟動。',
        '請指定要服務的 Obsidian vault 絕對路徑，例如：',
        '  VAULT_PATH=/Users/me/obsidian npm start',
      ].join('\n'),
    );
    process.exit(1);
  }

  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`PORT 無效: ${process.env.PORT}`);
    process.exit(1);
  }
  const host = process.env.HOST || '127.0.0.1';

  let app;
  try {
    app = await buildApp({ logger: true });
    await app.listen({ host, port });
  } catch (err) {
    console.error(`server 啟動失敗: ${/** @type {Error} */ (err).message}`);
    process.exit(1);
  }

  if (!process.env.TERMS_ACK) {
    app.log.warn(
      'TERMS_ACK 未設定：GET / 會顯示說明頁，且 /obsidian/app.js 不會提供。',
    );
  }
  if (process.env.WATCH_DISABLED === '1') {
    app.log.warn('WATCH_DISABLED=1：檔案監控與 /api/watch 推播已停用。');
  }

  const shutdown = async (signal) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

const isMain =
  typeof process.argv[1] === 'string' &&
  process.argv[1] !== '' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  void start();
}
