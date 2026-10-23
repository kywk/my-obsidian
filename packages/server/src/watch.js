/**
 * Watch events carry a token only while the observed disk version matches a
 * successful browser mutation. Matching versions survive multiple batches;
 * TTL bounds retention, never authorizes suppression of a different version.
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { watch } from 'chokidar';
import { resolveVaultPath, relativeFromVault } from './paths.js';

const IGNORED_SEGMENTS = new Set(['.git', '.docusaurus', 'node_modules']);
const IGNORED_RELATIVE_FILES = new Set(['.obsidian/workspace.json']);

/** How long a successful version remains eligible for echo matching. */
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
 * @typedef {{ kind: 'file' | 'directory' | 'missing', stamp?: string, digest?: string, mtimeMs?: number, size?: number }} OriginVersion
 * @typedef {{ token: string, expiresAt: number, version?: OriginVersion }} OriginEntry
 * @typedef {object} OriginTokenStore
 * @property {(relativePath: string, token: string, version?: OriginVersion) => void} record
 * @property {(relativePath: string, version?: OriginVersion) => string | undefined} lookup
 *   With a version, mismatches invalidate the record; without one this is a
 *   diagnostic lookup. A matching version is never consumed.
 * @property {(relativePath: string) => OriginEntry | undefined} peek
 * @property {(relativePath: string) => void} forget
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

  /** @type {Map<string, OriginEntry>} */
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
    record(relativePath, token, version) {
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
      entries.set(key, { token, version, expiresAt: clock + ttlMs });
      prune(clock);
    },

    lookup(relativePath, version) {
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
      if (arguments.length > 1 && !sameOriginVersion(entry.version, version)) {
        entries.delete(key);
        return undefined;
      }
      return entry.token;
    },

    peek(relativePath) {
      this.lookup(relativePath);
      return entries.get(normalizeEventPath(relativePath));
    },

    forget(relativePath) {
      entries.delete(normalizeEventPath(relativePath));
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
 * Record only a successfully completed version. Tokenless writes and failed
 * version capture revoke previous ownership instead of inheriting its token.
 *
 * @param {string} relativePath
 * @param {string | undefined} token
 * @param {OriginVersion | undefined} version
 */
export function recordOriginToken(relativePath, token, version) {
  if (!token || !version) originTokenStore.forget(relativePath);
  else originTokenStore.record(relativePath, token, version);
}

/**
 * Diagnostic lookup of the last recorded owner. Event delivery additionally
 * verifies the disk version and never relies on this lookup alone.
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

/** A content hash comes from the request/source, never arbitrary post-write data. */
export function hashOriginContent(data) {
  return createHash('sha256').update(data).digest('hex');
}

function statStamp(st) {
  return [st.dev, st.ino, st.mode, st.size, st.mtimeNs, st.ctimeNs, st.birthtimeNs].join(':');
}

function sameOriginVersion(left, right) {
  return left !== undefined && right !== undefined &&
    left.kind === right.kind && left.stamp === right.stamp && left.digest === right.digest;
}

/**
 * Capture the post-mutation metadata with the expected content supplied by the
 * writer. A racing external replacement cannot become ours merely by winning
 * the stat: its bytes must still match the request when the watcher checks.
 */
export async function captureOriginVersion(absolute, expectedDigest) {
  try {
    const st = await fs.promises.lstat(absolute, { bigint: true });
    if (st.isDirectory()) return { kind: 'directory', stamp: statStamp(st) };
    if (!st.isFile() || typeof expectedDigest !== 'string') return undefined;
    return { kind: 'file', stamp: statStamp(st), digest: expectedDigest };
  } catch (error) {
    return undefined;
  }
}

/**
 * Hash through a fixed descriptor and reject samples that changed while read
 * or were replaced at the path. Validate the opened descriptor against a
 * vault-contained path before hashing bytes.
 */
export async function readOriginVersion(vault, absolute, suffix) {
  let handle;
  try {
    const lst = await fs.promises.lstat(absolute, { bigint: true });
    if (lst.isDirectory()) return { kind: 'directory', stamp: statStamp(lst), mtimeMs: Number(lst.mtimeNs) / 1e6, size: Number(lst.size) };
    if (!lst.isFile()) return undefined;
    handle = await fs.promises.open(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    // O_NOFOLLOW protects only the last component. Revalidate the namespace
    // after opening, then match the descriptor before reading any bytes: an
    // ancestor can have become an outside symlink since the caller resolved it.
    if (!before.isFile() || statStamp(lst) !== statStamp(before)) return undefined;
    const verified = await resolveVaultPath(vault, relativeFromVault(vault, absolute));
    if (verified.real !== absolute) return undefined;
    const verifiedStat = await fs.promises.lstat(verified.real, { bigint: true });
    if (statStamp(before) !== statStamp(verifiedStat)) return undefined;
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    if (suffix !== undefined) hash.update(suffix);
    const after = await handle.stat({ bigint: true });
    const current = await fs.promises.lstat(absolute, { bigint: true });
    if (statStamp(before) !== statStamp(after) || statStamp(after) !== statStamp(current)) return undefined;
    return { kind: 'file', stamp: statStamp(after), digest: hash.digest('hex'), mtimeMs: Number(after.mtimeNs) / 1e6, size: Number(after.size) };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { kind: 'missing' };
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// Reserve every touched path before waiting so opposite-direction renames
// cannot deadlock. Only the commit of a streamed upload enters this queue.
const mutations = new Map();
export async function runOriginMutation(absolutePaths, operation) {
  const keys = [...new Set(absolutePaths.map(value => path.resolve(value)))];
  const previous = keys.map(key => mutations.get(key)).filter(Boolean);
  let release;
  const done = new Promise(resolve => { release = resolve; });
  for (const key of keys) mutations.set(key, done);
  await Promise.all(previous);
  try {
    return await operation();
  } finally {
    for (const key of keys) if (mutations.get(key) === done) mutations.delete(key);
    release();
  }
}

async function awaitOriginMutation(absolute) {
  while (mutations.has(absolute)) await mutations.get(absolute);
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
  const canonicalRoot = fs.realpathSync(vaultPath);
  const vault = { root: canonicalRoot, rootReal: canonicalRoot };

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
        const absolute = path.join(canonicalRoot, rel);
        for (;;) {
          await awaitOriginMutation(absolute);
          const entry = tokenStore.peek(rel);
          let resolved;
          let version;
          if (entry) {
            try {
              resolved = await resolveVaultPath(vault, rel);
              await awaitOriginMutation(resolved.real);
              version = await readOriginVersion(vault, resolved.real);
            } catch {
              // An external symlink must not turn version checks into reads
              // outside the vault. An unverified version is never our echo.
            }
          }
          let mtimeMs = version?.mtimeMs ?? 0;
          let size = version?.size ?? 0;
          if (!version && (!entry || resolved) && kind !== 'delete') {
            try {
              const st = await fs.promises.stat(absolute);
              mtimeMs = st.mtimeMs;
              size = st.size;
            } catch {
              // The file vanished again within the debounce window.
            }
          }
          // A new write during hashing invalidates this sample, not the new
          // writer's record. Wait for it and compare its completed version.
          if (mutations.has(absolute) || (resolved && mutations.has(resolved.real)) || tokenStore.peek(rel) !== entry) continue;
          const event = { path: rel, kind, mtimeMs, size };
          const token = entry ? tokenStore.lookup(rel, version) : undefined;
          if (token !== undefined) event.originToken = token;
          return event;
        }
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
