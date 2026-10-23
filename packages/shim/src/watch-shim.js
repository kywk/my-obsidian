/*
 * watch-shim.js — classic script.
 *
 * Bridges the server's /api/watch WebSocket (CONTRACTS.md §4) onto the
 * `fs.watch` surface Obsidian's FileSystemAdapter expects.
 *
 * The adapter builds its watcher like this:
 *
 *   var w = this.fs.watch(absolutePath, { recursive: true });
 *   w.on("change", function (eventType, filename) { ... });
 *
 * and treats `filename` as a path relative to the *watched directory*. Server
 * events carry a path relative to the vault root, so every watcher keeps the
 * vault-relative prefix of its own root and strips it before dispatch.
 *
 * This file is loaded after fs-shim.js (which delegates to
 * window.__MYOBS_WATCH when present) and before Obsidian's defer scripts, so
 * the adapter's first watch() call already reaches the delegate.
 *
 * Approximations are documented in ../GAPS.md.
 */
(function () {
	"use strict";

	var boot = window.__MYOBS || {};
	var PLATFORM = boot.platform || "darwin";
	var CASE_INSENSITIVE = PLATFORM === "darwin" || PLATFORM === "win32";

	/**
	 * Observable counters. Tests assert against these, so they are plain
	 * numbers on a stable object rather than getters.
	 *
	 * received   events parsed out of WS payloads
	 * dispatched deliveries to at least one watcher (one per watcher)
	 * filtered   events suppressed because their token identifies our own echo
	 */
	var state = {
		connected: false,
		reconnects: 0,
		received: 0,
		dispatched: 0,
		filtered: 0
	};

	var MIN_RETRY_MS = 1000;
	var MAX_RETRY_MS = 15000;

	/** @type {Array<any>} */
	var watchers = [];
	/** @type {Array<(event: object) => void>} */
	var subscribers = [];

	var socket = null;
	var retryTimer = null;
	var retryDelay = MIN_RETRY_MS;
	var openedOnce = false;

	var sessionToken =
		typeof boot.sessionToken === "string" ? boot.sessionToken : "";

	var vaultRoot = normalizeAbs(boot.vaultPath || "");

	// ---------------------------------------------------------------------
	// Path helpers
	// ---------------------------------------------------------------------

	function toSlash(value) {
		return String(value == null ? "" : value).replace(/\\/g, "/");
	}

	function normalizeAbs(value) {
		var text = toSlash(value);
		if (!text) return "";
		text = text.replace(/\/+/g, "/");
		if (text.length > 1) text = text.replace(/\/+$/, "");
		return text;
	}

	function fold(value) {
		return CASE_INSENSITIVE ? String(value).toLowerCase() : String(value);
	}

	/**
	 * Vault-relative path of an absolute watcher root, "" for the vault root,
	 * or null when the path is outside the vault (or vaultPath is unknown).
	 *
	 * @param {string} absolute
	 * @returns {string | null}
	 */
	function relativeToVault(absolute) {
		if (!vaultRoot) return null;
		var candidate = normalizeAbs(absolute);
		if (!candidate) return null;
		var foldedCandidate = fold(candidate);
		var foldedRoot = fold(vaultRoot);
		if (foldedCandidate === foldedRoot) return "";
		if (foldedCandidate.indexOf(foldedRoot + "/") === 0) {
			return candidate.slice(vaultRoot.length + 1);
		}
		return null;
	}

	/**
	 * True when `eventPath` is `watcherRel` itself or below it. The boundary
	 * check matters: a watcher on "notes" must not receive "notes-old/a.md".
	 */
	function isInside(watcherRel, eventPath) {
		if (watcherRel === "") return true;
		var base = fold(watcherRel);
		var candidate = fold(eventPath);
		return candidate === base || candidate.indexOf(base + "/") === 0;
	}

	// ---------------------------------------------------------------------
	// Watcher emitter
	// ---------------------------------------------------------------------

	function makeWatcher(absolutePath, options) {
		var record = {
			path: normalizeAbs(absolutePath),
			rel: relativeToVault(absolutePath),
			options: options || {},
			listeners: Object.create(null),
			closed: false
		};

		function bucket(event) {
			var list = record.listeners[event];
			if (!list) {
				list = record.listeners[event] = [];
			}
			return list;
		}

		function add(event, fn, once) {
			if (typeof fn === "function") bucket(event).push({ fn: fn, once: once });
			return handle;
		}

		function remove(event, fn) {
			var list = record.listeners[event];
			if (!list) return handle;
			for (var i = list.length - 1; i >= 0; i--) {
				if (list[i].fn === fn) list.splice(i, 1);
			}
			return handle;
		}

		var handle = {
			on: function (event, fn) {
				return add(event, fn, false);
			},
			once: function (event, fn) {
				return add(event, fn, true);
			},
			addListener: function (event, fn) {
				return add(event, fn, false);
			},
			removeListener: function (event, fn) {
				return remove(event, fn);
			},
			removeAllListeners: function (event) {
				if (event === undefined) record.listeners = Object.create(null);
				else delete record.listeners[event];
				return handle;
			},
			close: function () {
				if (record.closed) return;
				record.closed = true;
				record.listeners = Object.create(null);
				var index = watchers.indexOf(record);
				if (index !== -1) watchers.splice(index, 1);
			},
			ref: function () {
				return handle;
			},
			unref: function () {
				return handle;
			}
		};

		return { record: record, handle: handle };
	}

	/**
	 * Deliver one fs.watch-shaped event. A throwing listener must not stop the
	 * remaining listeners or the WS receive loop (Obsidian plugins register on
	 * the same emitter surface indirectly through the adapter).
	 */
	function emit(record, event, args) {
		var list = record.listeners[event];
		if (!list || list.length === 0) return;
		var snapshot = list.slice();
		for (var i = 0; i < snapshot.length; i++) {
			if (record.closed) return;
			var entry = snapshot[i];
			if (entry.once) {
				var index = list.indexOf(entry);
				if (index !== -1) list.splice(index, 1);
			}
			try {
				entry.fn.apply(null, args);
			} catch (err) {
				console.error("[my-obsidian] fs.watch listener failed", err);
			}
		}
	}

	// ---------------------------------------------------------------------
	// Routing
	// ---------------------------------------------------------------------

	function notifySubscribers(event) {
		var snapshot = subscribers.slice();
		for (var i = 0; i < snapshot.length; i++) {
			try {
				snapshot[i](event);
			} catch (err) {
				console.error("[my-obsidian] watch subscriber failed", err);
			}
		}
	}

	/**
	 * @param {{ path: string, kind: string, mtimeMs?: number, size?: number }} event
	 */
	function dispatch(event) {
		var eventPath = toSlash(event.path).replace(/^\/+/, "");
		if (!eventPath) return;

		// The adapter only distinguishes create/delete from change; keep the
		// Node vocabulary ("rename") rather than inventing a third value.
		var eventType = event.kind === "change" ? "change" : "rename";

		var snapshot = watchers.slice();
		for (var i = 0; i < snapshot.length; i++) {
			var record = snapshot[i];
			if (record.closed) continue;
			if (record.rel === null) continue;
			if (!isInside(record.rel, eventPath)) continue;

			var filename;
			if (record.rel === "") {
				filename = eventPath;
			} else if (fold(eventPath) === fold(record.rel)) {
				// A change to the watched directory itself has no child name;
				// Node would report the directory's own basename. Skipping is
				// safer than making the adapter reconcile "" (the vault root).
				continue;
			} else {
				filename = eventPath.slice(record.rel.length + 1);
			}
			if (!filename) continue;

			state.dispatched += 1;
			emit(record, "change", [eventType, filename, event]);
		}
	}

	// ---------------------------------------------------------------------
	// WebSocket
	// ---------------------------------------------------------------------

	function watchUrl() {
		var protocol = location.protocol === "https:" ? "wss:" : "ws:";
		return protocol + "//" + location.host + "/api/watch";
	}

	function handleMessage(data) {
		var message;
		try {
			message = JSON.parse(typeof data === "string" ? data : String(data));
		} catch (err) {
			return;
		}
		if (!message || message.type !== "change" || !Array.isArray(message.events)) {
			return;
		}

		var batch = [];
		for (var i = 0; i < message.events.length; i++) {
			var raw = message.events[i];
			if (!raw || typeof raw.path !== "string" || raw.path === "") continue;
			batch.push(raw);
		}
		state.received += batch.length;
		if (batch.length === 0) return;

		/*
		 * Echo suppression. The server verifies the observed disk version
		 * against a successful write carrying this session's token (fs-shim
		 * stamps it, see TOKEN_OPS); our versions must not re-enter the reload
		 * path, or "save plugin file -> reload -> plugin saves data.json ->
		 * reload" never terminates.
		 *
		 * The filter is per event, not per batch. The server aggregates every
		 * writer into one 150 ms window, so a batch routinely contains our own
		 * writes next to a genuinely external edit; dropping the batch would
		 * swallow the external edit. Even a same-path sibling may represent
		 * an external version or another tab's write; only its own token can
		 * establish provenance. The server retains matching versions across
		 * batches, so repeated echoes remain tagged without client guesses.
		 */
		var deliverable = [];
		for (var j = 0; j < batch.length; j++) {
			var candidate = batch[j];
			if (sessionToken && candidate.originToken === sessionToken) {
				state.filtered += 1;
				continue;
			}
			deliverable.push(candidate);
		}

		for (var k = 0; k < deliverable.length; k++) {
			var source = deliverable[k];
			var event = {
				path: toSlash(source.path).replace(/^\/+/, ""),
				kind: source.kind === "create" || source.kind === "delete" ? source.kind : "change",
				mtimeMs: Number(source.mtimeMs) || 0,
				size: Number(source.size) || 0
			};
			notifySubscribers(event);
			dispatch(event);
		}
	}

	function scheduleReconnect() {
		if (retryTimer !== null) return;
		var delay = retryDelay;
		retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
		retryTimer = setTimeout(function () {
			retryTimer = null;
			connect();
		}, delay);
	}

	function connect() {
		if (typeof WebSocket !== "function") {
			console.warn("[my-obsidian] WebSocket is unavailable; external changes will not arrive");
			return;
		}

		var ws;
		try {
			ws = new WebSocket(watchUrl());
		} catch (err) {
			scheduleReconnect();
			return;
		}
		socket = ws;

		ws.onopen = function () {
			if (socket !== ws) return;
			state.connected = true;
			retryDelay = MIN_RETRY_MS;
			if (openedOnce) state.reconnects += 1;
			openedOnce = true;
		};

		ws.onmessage = function (messageEvent) {
			try {
				handleMessage(messageEvent.data);
			} catch (err) {
				console.error("[my-obsidian] watch message handling failed", err);
			}
		};

		ws.onerror = function () {
			// onclose always follows; swallowing here keeps a transient network
			// error out of window.onerror (which shows the fatal overlay).
		};

		ws.onclose = function () {
			if (socket === ws) socket = null;
			state.connected = false;
			/*
			 * Missed events are not replayed by design (requested contract):
			 * Obsidian's own reconcile catches up on the next event for a path.
			 * A full rescan on every reconnect would be far more expensive.
			 */
			scheduleReconnect();
		};
	}

	function ensureSocket() {
		if (socket || retryTimer !== null) return;
		connect();
	}

	// ---------------------------------------------------------------------
	// Public surface
	// ---------------------------------------------------------------------

	/**
	 * @param {string} path absolute watcher root (usually the vault root)
	 * @param {object} [options]
	 * @param {(eventType: string, filename: string) => void} [listener]
	 */
	function watch(path, options, listener) {
		if (typeof path !== "string" || path === "") {
			// Node throws for a missing path; the adapter always passes one.
			throw new TypeError("fs.watch requires a path");
		}
		var made = makeWatcher(path, options);
		watchers.push(made.record);
		if (made.record.rel === null) {
			console.warn(
				"[my-obsidian] fs.watch root is outside __MYOBS.vaultPath; no events will be delivered: " +
					made.record.path
			);
		}
		if (typeof listener === "function") made.handle.on("change", listener);
		ensureSocket();
		return made.handle;
	}

	/**
	 * Raw event feed for the runtime layer (plugin-watch.js).
	 *
	 * @param {(event: { path: string, kind: string, mtimeMs: number, size: number }) => void} fn
	 * @returns {() => void} unsubscribe
	 */
	function subscribe(fn) {
		if (typeof fn !== "function") return function () {};
		subscribers.push(fn);
		ensureSocket();
		return function unsubscribe() {
			var index = subscribers.indexOf(fn);
			if (index !== -1) subscribers.splice(index, 1);
		};
	}

	window.__MYOBS_WATCH = {
		watch: watch,
		subscribe: subscribe,
		state: state
	};
})();
