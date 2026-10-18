/**
 * Chokidar watcher + write-token registry for /api/watch.
 *
 * Events are aggregated for 150 ms. A write that carried a token records that
 * token against the path it touched, and *every* event for that path during
 * the following TOKEN_TTL_MS carries it, so the originating browser tab can
 * ignore the echo of its own write (CONTRACTS.md §4).
 *
 * `originToken` therefore means "this path was most recently written by this
 * token", not "this event was caused by that write". The wider meaning is the
 * one that makes echo filtering correct, because the two failure modes are not
 * symmetric:
 *
 * - A false negative (our own event arrives untagged) is unbounded: the tab
 *   treats its own write as an external change, reloads the plugin, the plugin
 *   writes data.json again, and the loop never terminates on its own.
 *   Consuming the token on first use produced exactly that hole for any path
 *   producing events in two different batches -- chokidar's create+change pair
 *   for a new file, or a plugin's next save.
 * - A false positive (an external edit inside the TTL window is tagged with
 *   our token) is bounded: it delays one reconcile for that path. Opening the
 *   file re-reads it from disk anyway, and the next write to the path is
 *   tagged with whoever wrote last.
 *
 * So the filter is deliberately biased towards suppression, and the TTL only
 * has to outlive "save -> reload -> write again", not the write itself.
 * 30 s is ~100x the 300 ms awaitWriteFinish stability threshold.
 *
 * Multiple writers of one path: the registry keeps the *last* writer (the
 * token is replaced, not accumulated). One `originToken` string per event is
 * all the wire contract carries, and "the token whose write the current disk
 * content came from" is the only useful single answer. Keeping the first
 * writer would be actively wrong: the second writer's own echo would come back
 * untagged, so the tab holding the newest content would be the one that loops,
 * while the tab with the stale buffer keeps it -- and overwrites the newer
 * content on its next save, the exact hazard DESIGN.md §6 exists to prevent.
 *
 * Residual limit: two tabs ping-ponging on one path both see the other's write
 * as external, which is indistinguishable from a real external writer doing
 * the same thing. A single-token-per-event contract cannot express "both tabs
 * wrote in this batch" without a wire change; see packages/shim/GAPS.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { watch } from 'chokidar';

const IGNORED_SEGMENTS = new Set(['.git', '.docusaurus', 'node_modules']);
const IGNORED_RELATIVE_FILES = new Set(['.obsidian/workspace.json']);

/** How long a recorded write keeps tagging events for its path. */
const TOKEN_TTL_MS = 30_000;
/**
 * Hard cap on remembered paths. Entries only exist for paths written within
 * the TTL, and the paths whose echo actually starts a reload loop are plugin
 * main.js / data.json, themes and snippets -- a handful of paths. A cap far
 * above that is enough; the entries it evicts are the oldest writes, i.e. the
 * ones closest to expiring. Bulk vault-wide edits (find & replace) are what
 * can exceed it, and those target notes, whose reconcile path is cheap.
 */
const MAX_ORIGIN_TOKENS = 2000;
/**
 * Expired entries are swept at most this often so a burst of writes does not
 * pay an O(n) scan per write; the size cap is enforced on every record
 * regardless, so memory stays bounded between sweeps.
 */
const SWEEP_INTERVAL_MS = 1_000;

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
 * @typedef {object} OriginTokenStore
 * @property {(relativePath: string, token: string) => void} record Remember that
 *   `relativePath` was just written with `token`.
 * @property {(relativePath: string) => string | undefined} lookup The token of
 *   the most recent write for `relativePath`, or undefined when there is none
 *   in the TTL window. Non-consuming: repeated lookups return the same token.
 * @property {() => void} clear
 * @property {number} size Number of remembered paths (bounded by maxEntries).
 */

/**
 * Build an isolated registry. The server uses the module-level one below;
 * tests build their own with a short TTL and a fake clock so expiry does not
 * depend on wall-clock timing.
 *
 * @param {object} [options]
 * @param {number} [options.ttlMs]
 * @param {number} [options.maxEntries]
 * @param {() => number} [options.now]
 * @returns {OriginTokenStore}
 */
export function createOriginTokenStore(options = {}) {
  const ttlMs = options.ttlMs ?? TOKEN_TTL_MS;
  const maxEntries = options.maxEntries ?? MAX_ORIGIN_TOKENS;
  const now = options.now ?? Date.now;

  /** @type {Map<string, { token: string, expiresAt: number }>} */
  const entries = new Map();
  /** Timestamp of the next allowed full sweep. */
  let nextSweepAt = 0;

  /**
   * Drop expired entries, then the oldest writes if the cap is still exceeded.
   *
   * @param {number} clock
   */
  function prune(clock) {
    if (entries.size === 0) return;
    if (clock < nextSweepAt && entries.size <= maxEntries) return;
    nextSweepAt = clock + SWEEP_INTERVAL_MS;

    for (const [key, entry] of entries) {
      if (entry.expiresAt <= clock) entries.delete(key);
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done === true) break;
      entries.delete(oldest.value);
    }
  }

  return {
    record(relativePath, token) {
      if (typeof relativePath !== 'string' || typeof token !== 'string' || token === '') {
        return;
      }
      const key = normalizeEventPath(relativePath);
      if (key === '') return;

      const clock = now();
      // Delete before set so Map iteration order is write order: the cap below
      // evicts the least recently written path, and a hot path (plugin
      // data.json) must not look "old" only because it was seen first.
      entries.delete(key);
      entries.set(key, { token, expiresAt: clock + ttlMs });
      prune(clock);
    },

    lookup(relativePath) {
      if (typeof relativePath !== 'string') return undefined;
      const key = normalizeEventPath(relativePath);
      const entry = entries.get(key);
      const clock = now();
      if (entry === undefined) {
        // Still worth a sweep: a path that is never looked up again must not
        // keep its expired entry alive until the next write happens.
        prune(clock);
        return undefined;
      }
      if (entry.expiresAt <= clock) {
        entries.delete(key);
        prune(clock);
        return undefined;
      }
      return entry.token;
    },

    clear() {
      entries.clear();
      nextSweepAt = 0;
    },

    get size() {
      return entries.size;
    },
  };
}

/** Registry shared by /api/fs, PUT /v/* and the watcher in this process. */
const originTokenStore = createOriginTokenStore();

/**
 * Remember that `relativePath` is about to change because of a request that
 * carried `token`.
 *
 * @param {string} relativePath
 * @param {string} token
 */
export function recordOriginToken(relativePath, token) {
  originTokenStore.record(relativePath, token);
}

/**
 * The token to attach to an event for `relativePath`, if any (see the file
 * header for what the field means).
 *
 * @param {string} relativePath
 * @returns {string | undefined}
 */
export function lookupOriginToken(relativePath) {
  return originTokenStore.lookup(relativePath);
}

/** Exposed for tests/diagnostics. */
export function clearOriginTokens() {
  originTokenStore.clear();
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
 * @param {OriginTokenStore} [options.tokenStore] Defaults to the shared registry.
 * @param {{ error?: (...args: unknown[]) => void, warn?: (...args: unknown[]) => void }} [options.logger]
 * @returns {{ close: () => Promise<void>, watcher: import('chokidar').FSWatcher, flush: () => Promise<void>, ready: Promise<void> }}
 */
export function createVaultWatcher(options) {
  const {
    vaultPath,
    onEvents,
    debounceMs = 150,
    tokenStore = originTokenStore,
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
        const token = tokenStore.lookup(rel);
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
