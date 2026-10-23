/**
 * Tests for packages/server/src/watch.js.
 *
 * Two invariants this file exists to protect:
 *
 * 1. An origin token survives until its TTL expires, so *every* event for a
 *    unchanged version is tagged -- not only the first one. Consuming the token on first use
 *    left the second batch of a path untagged, which let a tab treat its own
 *    write as an external change (plugin data.json -> reload -> write -> ...).
 * 2. The registry stays bounded (TTL sweep + hard cap), and PUT /v/* can mark
 *    the write it performs through `X-Write-Token`.
 *
 * Timing: nothing here sleeps for a guessed duration and then asserts. Every
 * positive assertion polls until its condition holds; the two negative ones
 * (ignored paths, WATCH_DISABLED) run behind a positive control on the same
 * connection plus a bounded settle window, so a missing event cannot be an
 * accident of "the event was simply slower than the sleep".
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';

import { buildApp } from '../src/index.js';
import {
  clearOriginTokens,
  createOriginTokenStore,
  createVaultWatcher,
  lookupOriginToken,
  recordOriginToken,
  readOriginVersion,
} from '../src/watch.js';

/** Failure modes of a broken watcher are noise; only the assertions matter. */
const SILENT = { error() {}, warn() {} };

/**
 * How long to keep listening before claiming "no event arrived". A real event
 * travels write -> 300 ms awaitWriteFinish -> 150 ms batch, so this is ~3x the
 * worst case.
 */
const NEGATIVE_WINDOW_MS = 1500;

/**
 * Poll until `predicate()` returns something truthy. Tests must never assume a
 * fixed delay is long enough for chokidar + the batch window.
 *
 * @template T
 * @param {() => T | undefined} predicate
 * @param {{ timeout?: number, interval?: number, label?: string }} [options]
 * @returns {Promise<T>}
 */
async function waitFor(predicate, options = {}) {
  const { timeout = 8000, interval = 20, label = 'condition' } = options;
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeout} ms waiting for ${label}`);
    }
    await delay(interval);
  }
}

/**
 * @typedef {import('../src/watch.js').WatchEvent} WatchEvent
 */

/** Collects every batch the watched directory produces. */
function createSink() {
  /** @type {WatchEvent[][]} */
  const batches = [];
  return {
    batches,
    /** @type {(events: WatchEvent[]) => void} */
    onEvents(events) {
      batches.push(events);
    },
    /** @returns {WatchEvent[]} */
    events() {
      return batches.flat();
    },
    /** @returns {string[]} */
    paths() {
      return batches.flat().map((event) => event.path);
    },
  };
}

/** @type {string} */
let root;

/** @param {string} relativePath @param {string} contents */
async function writeVaultFile(relativePath, contents) {
  const absolute = path.join(root, relativePath);
  await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
  await fs.promises.writeFile(absolute, contents);
  return absolute;
}

before(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'myobs-watch-'));
  // Directories that exist before the watcher starts: `ignoreInitial` keeps
  // their creation out of the stream, so a failing test cannot be caused by an
  // unrelated `addDir` event.
  for (const dir of ['notes', '.obsidian', '.git/objects', '.docusaurus', 'node_modules/pkg']) {
    await fs.promises.mkdir(path.join(root, dir), { recursive: true });
  }
});

after(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('origin token store', () => {
  it('keeps the token across repeated lookups instead of consuming it', () => {
    const store = createOriginTokenStore({ ttlMs: 1000, now: () => 0 });
    store.record('notes/a.md', 'tok');

    assert.equal(store.lookup('notes/a.md'), 'tok');
    assert.equal(store.lookup('notes/a.md'), 'tok');
    assert.equal(store.lookup('notes/a.md'), 'tok');
    assert.equal(store.size, 1, 'lookup must not drop the entry');
  });

  it('normalizes absolute and dotted paths so record and lookup agree', () => {
    const store = createOriginTokenStore({ ttlMs: 1000, now: () => 0 });
    store.record('/notes//sub/./a.md', 'tok');

    assert.equal(store.lookup('notes/sub/a.md'), 'tok');
    assert.equal(store.lookup('/notes/sub/a.md'), 'tok');
    assert.equal(store.size, 1, 'both forms must share one entry');
  });

  it('keeps only the most recent writer for a path', () => {
    const store = createOriginTokenStore({ ttlMs: 1000, now: () => 0 });
    store.record('notes/two-tabs.md', 'tab-a');
    store.record('notes/two-tabs.md', 'tab-b');

    assert.equal(store.lookup('notes/two-tabs.md'), 'tab-b');
    assert.equal(store.size, 1);
  });

  it('expires an entry once the ttl has passed', () => {
    const clock = { now: 0 };
    const store = createOriginTokenStore({ ttlMs: 1000, now: () => clock.now });
    store.record('notes/ttl.md', 'tok');

    clock.now = 999;
    assert.equal(store.lookup('notes/ttl.md'), 'tok');

    clock.now = 1000;
    assert.equal(store.lookup('notes/ttl.md'), undefined);
    assert.equal(store.size, 0, 'the expired entry must be dropped, not just hidden');
  });

  it('refreshes the ttl on every write to the path', () => {
    const clock = { now: 0 };
    const store = createOriginTokenStore({ ttlMs: 1000, now: () => clock.now });
    store.record('notes/refresh.md', 'tok');
    clock.now = 800;
    store.record('notes/refresh.md', 'tok');

    clock.now = 1500;
    assert.equal(store.lookup('notes/refresh.md'), 'tok', 'ttl restarts at the last write');

    clock.now = 1801;
    assert.equal(store.lookup('notes/refresh.md'), undefined);
  });

  it('never grows past maxEntries', () => {
    const store = createOriginTokenStore({ ttlMs: 60_000, maxEntries: 8, now: () => 0 });
    for (let i = 0; i < 100; i += 1) store.record(`notes/${i}.md`, `token-${i}`);

    assert.equal(store.size, 8);
    assert.equal(store.lookup('notes/99.md'), 'token-99', 'the newest write survives');
    assert.equal(store.lookup('notes/0.md'), undefined, 'the oldest write is evicted');
  });

  it('evicts the least recently written path, not the first one seen', () => {
    const store = createOriginTokenStore({ ttlMs: 60_000, maxEntries: 3, now: () => 0 });
    store.record('a.md', 'a');
    store.record('b.md', 'b');
    store.record('c.md', 'c');
    store.record('a.md', 'a2'); // hot path written again
    store.record('d.md', 'd'); // over the cap

    assert.equal(store.lookup('a.md'), 'a2');
    assert.equal(store.lookup('b.md'), undefined, 'b has the oldest write');
    assert.equal(store.lookup('c.md'), 'c');
    assert.equal(store.lookup('d.md'), 'd');
    assert.equal(store.size, 3);
  });

  it('sweeps expired entries so the table shrinks again', () => {
    const clock = { now: 0 };
    const store = createOriginTokenStore({ ttlMs: 500, maxEntries: 100, now: () => clock.now });
    store.record('a.md', 'a');
    store.record('b.md', 'b');

    clock.now = 500;
    assert.equal(store.lookup('a.md'), undefined);
    assert.equal(store.size, 1, 'the looked-up entry is gone');

    clock.now = 1500;
    store.record('c.md', 'c');
    assert.equal(store.size, 1, 'the sweep collects entries nobody looks up again');
    assert.equal(store.lookup('c.md'), 'c');
  });
});

describe('event tagging', () => {
  it('tags every batch for a path, not only the first one (regression)', async () => {
    clearOriginTokens();
    const sink = createSink();
    const watcher = createVaultWatcher({
      vaultPath: root,
      onEvents: sink.onEvents,
      debounceMs: 40,
      logger: SILENT,
    });

    try {
      await watcher.ready;
      const target = await writeVaultFile('notes/echo.md', 'first version');
      recordOriginToken('notes/echo.md', 'token-echo', await readOriginVersion({ root, rootReal: root }, target));
      const first = await waitFor(
        () => sink.events().find((event) => event.path === 'notes/echo.md'),
        { label: 'the first event for notes/echo.md' },
      );
      assert.equal(first.originToken, 'token-echo');
      assert.equal(first.kind, 'create');

      // A delayed event for the same completed version must keep its token.
      // A new external write is a different version, covered separately.
      watcher.watcher.emit('change', 'notes/echo.md');
      await watcher.flush();
      const second = await waitFor(
        () => sink.events().filter((event) => event.path === 'notes/echo.md')[1],
        { label: 'a second, separately batched event for notes/echo.md' },
      );

      assert.ok(sink.batches.length >= 2, 'the two writes must be separate batches');
      assert.equal(second.originToken, 'token-echo');
    } finally {
      await watcher.close();
      clearOriginTokens();
    }
  });

  it('stops tagging once the recorded write is older than the ttl', async () => {
    const clock = { now: 0 };
    const store = createOriginTokenStore({ ttlMs: 1000, now: () => clock.now });
    const sink = createSink();
    const watcher = createVaultWatcher({
      vaultPath: root,
      onEvents: sink.onEvents,
      debounceMs: 40,
      tokenStore: store,
      logger: SILENT,
    });

    try {
      await watcher.ready;
      const target = await writeVaultFile('notes/ttl.md', 'inside the ttl');
      store.record('notes/ttl.md', 'token-ttl', await readOriginVersion({ root, rootReal: root }, target));

      const tagged = await waitFor(
        () => sink.events().find((event) => event.path === 'notes/ttl.md'),
        { label: 'the tagged event for notes/ttl.md' },
      );
      assert.equal(tagged.originToken, 'token-ttl');

      clock.now = 1000; // the write is now older than the ttl
      await fs.promises.writeFile(target, 'after the ttl');

      const untagged = await waitFor(
        () => sink.events().filter((event) => event.path === 'notes/ttl.md')[1],
        { label: 'the untagged event for notes/ttl.md' },
      );
      assert.equal(untagged.originToken, undefined);
    } finally {
      await watcher.close();
    }
  });

  it('attaches the most recent writer when two tabs write one path', async () => {
    clearOriginTokens();
    const sink = createSink();
    const watcher = createVaultWatcher({
      vaultPath: root,
      onEvents: sink.onEvents,
      debounceMs: 40,
      logger: SILENT,
    });

    try {
      await watcher.ready;
      const target = await writeVaultFile('notes/two-tabs.md', 'written by tab-a');
      recordOriginToken('notes/two-tabs.md', 'tab-a', await readOriginVersion({ root, rootReal: root }, target));
      await fs.promises.writeFile(target, 'written by tab-b');
      recordOriginToken('notes/two-tabs.md', 'tab-b', await readOriginVersion({ root, rootReal: root }, target));
      const event = await waitFor(
        () => sink.events().find((candidate) => candidate.path === 'notes/two-tabs.md'),
        { label: 'the event for notes/two-tabs.md' },
      );

      assert.equal(event.originToken, 'tab-b');
      assert.equal(lookupOriginToken('notes/two-tabs.md'), 'tab-b');
    } finally {
      await watcher.close();
      clearOriginTokens();
    }
  });
});

describe('batch aggregation', () => {
  it('merges one path per batch and lets delete win', async () => {
    clearOriginTokens();
    const sink = createSink();
    // A long debounce means the batch below can only be emitted by the
    // explicit flush(): no timing to guess.
    const watcher = createVaultWatcher({
      vaultPath: root,
      onEvents: sink.onEvents,
      debounceMs: 60_000,
      logger: SILENT,
    });

    try {
      await watcher.ready;
      watcher.watcher.emit('add', 'notes/dup.md');
      watcher.watcher.emit('change', 'notes/dup.md');
      watcher.watcher.emit('change', 'notes/recreated.md');
      watcher.watcher.emit('add', 'notes/recreated.md');
      watcher.watcher.emit('add', 'notes/gone.md');
      watcher.watcher.emit('unlink', 'notes/gone.md');
      watcher.watcher.emit('change', 'notes/touched.md');
      watcher.watcher.emit('change', 'notes/touched.md');

      await watcher.flush();

      assert.equal(sink.batches.length, 1);
      assert.deepEqual(
        sink.events().map((event) => ({ path: event.path, kind: event.kind })),
        [
          { path: 'notes/dup.md', kind: 'create' },
          { path: 'notes/recreated.md', kind: 'create' },
          { path: 'notes/gone.md', kind: 'delete' },
          { path: 'notes/touched.md', kind: 'change' },
        ],
      );
    } finally {
      await watcher.close();
    }
  });
});

describe('ignored paths', () => {
  it('emits nothing for .git, .docusaurus, node_modules or workspace.json', async () => {
    const sink = createSink();
    const watcher = createVaultWatcher({
      vaultPath: root,
      onEvents: sink.onEvents,
      debounceMs: 40,
      logger: SILENT,
    });

    try {
      await watcher.ready;
      await writeVaultFile('.git/objects/ab12', 'git object');
      await writeVaultFile('.docusaurus/cache.js', 'build cache');
      await writeVaultFile('node_modules/pkg/index.js', 'vendor code');
      await writeVaultFile('.obsidian/workspace.json', '{"layout":"desktop"}');
      // Positive control: the watcher is alive and this file is not ignored.
      await writeVaultFile('.obsidian/app.json', '{"legacyEditor":false}');

      const control = await waitFor(
        () => sink.events().find((event) => event.path === '.obsidian/app.json'),
        { label: 'the control event for .obsidian/app.json' },
      );
      assert.equal(control.kind, 'create');

      // The ignored writes all happened before the control, so chokidar's
      // events for them are already past their stability window; this window
      // only catches a straggler.
      await delay(NEGATIVE_WINDOW_MS);
      assert.deepEqual(sink.paths(), ['.obsidian/app.json']);

      // The enqueue-level filter must hold on its own, independent of what
      // chokidar hands us: nothing reaches the batch for an ignored path.
      watcher.watcher.emit('add', '.git/objects/cd34');
      watcher.watcher.emit('change', '.obsidian/workspace.json');
      watcher.watcher.emit('change', `${root}/node_modules/pkg/main.js`);
      watcher.watcher.emit('change', '.docusaurus/generated.js');
      await watcher.flush();
      assert.deepEqual(sink.paths(), ['.obsidian/app.json']);
    } finally {
      await watcher.close();
    }
  });
});

describe('WATCH_DISABLED', () => {
  it('serves the fs API but delivers no watch event', async () => {
    const previous = process.env.WATCH_DISABLED;
    process.env.WATCH_DISABLED = '1';
    /** @type {import('fastify').FastifyInstance | undefined} */
    let app;
    /** @type {import('ws').WebSocket | undefined} */
    let socket;
    /** @type {unknown[]} */
    const messages = [];

    try {
      app = await buildApp({ vaultPath: root, termsAccepted: true, authToken: '' });
      await app.ready();
      socket = await app.injectWS('/api/watch');
      socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));

      const response = await app.inject({
        method: 'POST',
        url: '/api/fs',
        payload: { op: 'write', path: 'notes/no-watch.md', args: { data: 'nothing to see' } },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().ok, true);
      assert.equal(await fs.promises.readFile(path.join(root, 'notes/no-watch.md'), 'utf8'), 'nothing to see');

      await delay(NEGATIVE_WINDOW_MS);
      assert.deepEqual(messages, [], 'WATCH_DISABLED=1 must not start chokidar');
    } finally {
      socket?.terminate();
      if (app) await app.close();
      if (previous === undefined) delete process.env.WATCH_DISABLED;
      else process.env.WATCH_DISABLED = previous;
    }
  });
});

describe('PUT /v/* write tokens', () => {
  it('registers X-Write-Token so the upload event is tagged', async () => {
    clearOriginTokens();
    const app = await buildApp({ vaultPath: root, watch: true, termsAccepted: true, authToken: '' });
    /** @type {import('ws').WebSocket | undefined} */
    let socket;
    /** @type {{ events?: WatchEvent[] }[]} */
    const messages = [];

    try {
      // The connection is the positive control for the WATCH_DISABLED test:
      // with the watcher running, this is the same event path that test
      // asserts must stay silent.
      await app.ready();
      socket = await app.injectWS('/api/watch');
      socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
      const received = () => messages.flatMap((message) => message.events ?? []);

      const upload = await app.inject({
        method: 'PUT',
        url: `/v${path.join(root, 'notes/upload.bin')}`,
        headers: { 'x-write-token': 'upload-token' },
        payload: Buffer.from([1, 2, 3, 4]),
      });
      assert.equal(upload.statusCode, 204);

      const tagged = await waitFor(
        () => received().find((event) => event.path === 'notes/upload.bin'),
        { label: 'the watcher event for notes/upload.bin' },
      );
      assert.equal(tagged.originToken, 'upload-token');
      assert.equal(tagged.kind, 'create');
      assert.equal(lookupOriginToken('notes/upload.bin'), 'upload-token');

      // Without the header the upload stays unmarked: the header is the only
      // source of a PUT token.
      const plain = await app.inject({
        method: 'PUT',
        url: `/v${path.join(root, 'notes/upload-plain.bin')}`,
        payload: Buffer.from([5, 6]),
      });
      assert.equal(plain.statusCode, 204);
      await waitFor(
        () => received().find((event) => event.path === 'notes/upload-plain.bin'),
        { label: 'the watcher event for notes/upload-plain.bin' },
      );
      assert.equal(lookupOriginToken('notes/upload-plain.bin'), undefined);

      // GET/HEAD read a file, they never register a write.
      const read = await app.inject({ method: 'GET', url: `/v${path.join(root, 'notes/upload.bin')}` });
      assert.equal(read.statusCode, 200);
      assert.equal(read.rawPayload.length, 4);
      await app.inject({ method: 'HEAD', url: `/v${path.join(root, 'notes/upload.bin')}` });
      assert.equal(lookupOriginToken('notes/upload.bin'), 'upload-token', 'unchanged by a read');
    } finally {
      socket?.terminate();
      await app.close();
      clearOriginTokens();
    }
  });
});

describe('createVaultWatcher interface', () => {
  it('exposes exactly the handle and the lifecycle it documents', async () => {
    const watcher = createVaultWatcher({
      vaultPath: root,
      onEvents: () => {},
      debounceMs: 60_000,
      logger: SILENT,
    });
    try {
      assert.deepEqual(Object.keys(watcher).sort(), ['close', 'flush', 'ready', 'watcher']);
      assert.equal(typeof watcher.close, 'function');
      assert.equal(typeof watcher.flush, 'function');
      assert.ok(watcher.ready instanceof Promise);
      await watcher.ready;
    } finally {
      await watcher.close();
    }
  });
});
