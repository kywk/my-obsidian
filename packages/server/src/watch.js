/**
 * Chokidar watcher + write-token registry for /api/watch.
 *
 * Events are aggregated for 150 ms. A token recorded by an fs mutation is
 * attached to the matching event so the originating browser tab can ignore
 * the echo of its own write.
 */

import fs from 'node:fs';
import path from 'node:path';
import { watch } from 'chokidar';

const IGNORED_SEGMENTS = new Set(['.git', '.docusaurus', 'node_modules']);
const IGNORED_RELATIVE_FILES = new Set(['.obsidian/workspace.json']);
const TOKEN_TTL_MS = 30_000;

/** @type {Map<string, { token: string, expiresAt: number }>} */
const originTokens = new Map();

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeEventPath(value) {
  let rel = value.split(path.sep).join('/');
  rel = rel.replace(/\\/g, '/');
  rel = path.posix.normalize(rel);
  if (rel === '.') return '';
  return rel.replace(/^\/+/, '');
}

/**
 * Remember that `relativePath` is about to change because of a request that
 * carried `token`.
 *
 * @param {string} relativePath
 * @param {string} token
 */
export function recordOriginToken(relativePath, token) {
  if (typeof relativePath !== 'string' || typeof token !== 'string' || token === '') return;
  const key = normalizeEventPath(relativePath);
  if (key === '') return;
  originTokens.set(key, { token, expiresAt: Date.now() + TOKEN_TTL_MS });

  if (originTokens.size > 2000) {
    const now = Date.now();
    for (const [existing, entry] of originTokens) {
      if (entry.expiresAt <= now) originTokens.delete(existing);
    }
  }
}

/**
 * Consume a token for an event path.
 *
 * @param {string} relativePath
 * @returns {string | undefined}
 */
export function consumeOriginToken(relativePath) {
  const key = normalizeEventPath(relativePath);
  const entry = originTokens.get(key);
  if (!entry) return undefined;
  originTokens.delete(key);
  if (entry.expiresAt <= Date.now()) return undefined;
  return entry.token;
}

/** Exposed for tests/diagnostics. */
export function clearOriginTokens() {
  originTokens.clear();
}

/**
 * @param {string} vaultPath
 * @param {string} input
 * @returns {boolean}
 */
function makeIgnoreMatcher(vaultPath) {
  /** @param {string} input */
  return (input) => {
    let rel = input;
    if (path.isAbsolute(rel)) {
      rel = path.relative(vaultPath, rel);
    }
    rel = normalizeEventPath(rel);
    if (rel === '') return false;
    if (IGNORED_RELATIVE_FILES.has(rel)) return true;
    return rel.split('/').some((segment) => IGNORED_SEGMENTS.has(segment));
  };
}

/**
 * @typedef {{ path: string, kind: 'create' | 'change' | 'delete', mtimeMs: number, size: number, originToken?: string }} WatchEvent
 */

/**
 * @param {object} options
 * @param {string} options.vaultPath
 * @param {(events: WatchEvent[]) => void} options.onEvents
 * @param {number} [options.debounceMs]
 * @param {{ error?: (...args: unknown[]) => void, warn?: (...args: unknown[]) => void }} [options.logger]
 * @returns {{ close: () => Promise<void>, watcher: import('chokidar').FSWatcher, flush: () => Promise<void>, ready: Promise<void> }}
 */
export function createVaultWatcher(options) {
  const {
    vaultPath,
    onEvents,
    debounceMs = 150,
    logger = console,
  } = options;

  /** @type {Map<string, 'create' | 'change' | 'delete'>} */
  const pending = new Map();
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  const ignored = makeIgnoreMatcher(vaultPath);

  const watcher = watch(vaultPath, {
    cwd: vaultPath,
    ignoreInitial: true,
    followSymlinks: false,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    ignored,
  });

  watcher.on('error', (err) => {
    logger.error?.('[watch] error', err);
  });

  // Resolving on the initial scan means a client that connects right after
  // listen() cannot miss an external write made before the scan finished.
  const ready = new Promise((resolve) => {
    watcher.once('ready', () => resolve());
  });
  /**
   * @param {'create' | 'change' | 'delete'} kind
   * @param {string} rawPath
   */
  function enqueue(kind, rawPath) {
    if (ignored(rawPath)) return;
    const relative = path.isAbsolute(rawPath)
      ? path.relative(vaultPath, rawPath)
      : rawPath;
    const rel = normalizeEventPath(relative);
    if (rel === '' || rel === '..' || rel.startsWith('../')) return;

    const previous = pending.get(rel);
    if (previous === undefined) {
      pending.set(rel, kind);
    } else if (previous === 'create' && kind === 'change') {
      pending.set(rel, 'create');
    } else if (previous === 'change' && kind === 'create') {
      pending.set(rel, 'create');
    } else {
      // delete wins over anything; otherwise the newest event wins.
      pending.set(rel, kind === 'delete' ? 'delete' : kind);
    }

    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, debounceMs);
    }
  }

  async function flush() {
    if (pending.size === 0) return;
    const batch = [...pending.entries()];
    pending.clear();

    const events = await Promise.all(
      batch.map(async ([rel, kind]) => {
        let mtimeMs = 0;
        let size = 0;
        if (kind !== 'delete') {
          try {
            const st = await fs.promises.stat(path.join(vaultPath, rel));
            mtimeMs = st.mtimeMs;
            size = st.size;
          } catch {
            // The file vanished again within the debounce window.
          }
        }
        /** @type {WatchEvent} */
        const event = { path: rel, kind, mtimeMs, size };
        const token = consumeOriginToken(rel);
        if (token !== undefined) event.originToken = token;
        return event;
      }),
    );

    try {
      onEvents(events);
    } catch (err) {
      logger.error?.('[watch] onEvents failed', err);
    }
  }

  watcher.on('add', (rel) => enqueue('create', rel));
  watcher.on('addDir', (rel) => enqueue('create', rel));
  watcher.on('change', (rel) => enqueue('change', rel));
  watcher.on('unlink', (rel) => enqueue('delete', rel));
  watcher.on('unlinkDir', (rel) => enqueue('delete', rel));

  return {
    watcher,
    flush,
    ready,
    async close() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending.clear();
      await watcher.close();
    },
  };
}
