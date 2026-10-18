/*
 * resilience.js — classic script, loaded before Obsidian's app.js.
 *
 * A self-hosted backend gets restarted: `npm start` again, laptop sleep, a
 * dropped tunnel, Docker restart. watch-shim already reconnects its WebSocket,
 * but three things were missing and all three are user-visible:
 *
 *   1. nothing says "the backend is gone", so a failed save looks like an
 *      Obsidian bug (the editor notice says "Failed to save", then the runtime
 *      fatal overlay replaces the app because the rejection is unhandled);
 *   2. writes attempted while offline fail with a generic EIO;
 *   3. after reconnecting, state changed on disk during the outage is never
 *      discovered, because /api/watch does not replay missed events.
 *
 * This module owns detection, the offline write gate, and the post-reconnect
 * reconcile. It does not implement the notice UI; notices.js owns that and may
 * still be a stub, so every push is optional.
 *
 * Reconcile entry point (verified against vendor/obsidian/app.js 1.14.4):
 *   FileSystemAdapter.prototype.reconcileFile(realPath, normalizedPath)
 *   character offset 560701, byte offset 565222
 *
 * That is the same function the adapter's own fs watcher calls for a single
 * path (onFileChange -> reconcileFile; character 560372 / byte 564893). It:
 *   - reconciles the parent folder chain first (new folders included),
 *   - lstat()s the path and adds/changes/removes the entry in adapter.files,
 *   - triggers file-created / modified, which is what Vault.onChange
 *     (character 1420456 / byte 1425324) turns into app.vault file objects.
 *
 * Rejected alternative: adapter.listAll() (character 546769 / byte 551290).
 * It resets adapter.files before walking, so every existing file looks newly
 * created and Vault.onChange would push a second abstract file into the same
 * folder. Rejected alternative: adapter.watch(adapter.handler) — same reason:
 * it ends in listAll().
 */
(function () {
	"use strict";

	var ONLINE_POLL_MS = 2000;
	var OFFLINE_POLL_MS = 1000;
	// 5s, not 2.5s: the probe competes with real work (cold boot fires ~19k fs
	// requests; an export renders a 700KB PDF). A probe timeout is a health-check
	// signal, not a write path, so it can afford to be patient.
	var PROBE_TIMEOUT_MS = 5000;
	// Consecutive probe failures required before the write gate closes. One
	// timeout must never block a save; see the failure handler in probe().
	var PROBE_FAILURES_BEFORE_OFFLINE = 2;
	var WS_CHECK_MS = 1000;
	var RECONCILE_CONCURRENCY = 8;
	var APP_WAIT_MS = 60000;
	var EVENTS_MAX = 400;

	var events = [];
	var probes = 0;
	var probeFailures = 0;
	var lastProbe = null;
	var networkFailures = 0;
	var timer = null;
	var probing = null;
	var wsTimer = null;
	var sawSocketOpen = false;
	var wasOffline = false;
	var offlineSince = 0;
	var offlineSource = null;
	var pendingReconcile = false;
	var reconcilePromise = null;

	var api = {
		installed: true,
		online: true,
		probes: 0,
		events: events,
		lastProbe: null,
		networkFailures: 0,
		reconciling: false,
		lastReconcile: null,
		offlineSince: 0,
		noteNetworkFailure: noteNetworkFailure,
		noteWriteBlocked: noteWriteBlocked,
		probeNow: probeNow,
		reconcileNow: reconcileNow
	};
	window.__MYOBS_RESILIENCE = api;

	// ---------------------------------------------------------------------
	// Diagnostics
	// ---------------------------------------------------------------------

	function record(type, detail) {
		try {
			var entry = { at: Date.now(), type: type };
			if (detail && typeof detail === "object") {
				for (var key in detail) {
					if (Object.prototype.hasOwnProperty.call(detail, key)) {
						entry[key] = detail[key];
					}
				}
			}
			events.push(entry);
			if (events.length > EVENTS_MAX) events.splice(0, events.length - EVENTS_MAX);
		} catch (err) {
			/* diagnostics must never break the caller */
		}
	}

	function notify(notice) {
		/*
		 * notices.js is a separate workstream and may still be the stub. A
		 * notice implementation that throws must not turn an already-handled
		 * backend failure into a fatal renderer error.
		 */
		try {
			window.__MYOBS_NOTICES?.push?.(notice);
		} catch (err) {
			try {
				console.warn("[my-obsidian] notice push failed", err);
			} catch (ignored) {
				/* console is gone */
			}
		}
	}

	function errorText(err) {
		if (!err) return "unknown error";
		if (err.message) return String(err.message);
		return String(err);
	}

	function isOfflineError(err) {
		if (!err) return false;
		return err.code === "EOFFLINE" || err.code === "ECONNREFUSED";
	}

	// ---------------------------------------------------------------------
	// Reachability probe
	//
	// navigator.onLine only describes the local link; a self-hosted server on
	// another port can be dead while the network is fine. HEAD / is the
	// cheapest endpoint that exists in every deployment (there is no
	// /api/health). Any HTTP response — 200, 403, even 404 — proves a server
	// answered; only a network-level rejection or timeout means "gone".
	// ---------------------------------------------------------------------

	function probe() {
		if (probing) return probing;
		probes += 1;
		api.probes = probes;

		var started = Date.now();
		var controller = typeof AbortController === "function" ? new AbortController() : null;
		var timeout = controller
			? setTimeout(function () {
				try {
					controller.abort();
				} catch (err) {
					/* already settled */
				}
			}, PROBE_TIMEOUT_MS)
			: null;

		var init = {
			method: "HEAD",
			cache: "no-store",
			credentials: "same-origin"
		};
		if (controller) init.signal = controller.signal;

		try {
			probing = fetch("/?myobs-probe=" + Date.now(), init)
				.then(
					function (response) {
						probeFailures = 0;
						lastProbe = {
							at: Date.now(),
							ok: true,
							status: response.status,
							ms: Date.now() - started
						};
						api.lastProbe = lastProbe;
						markReachable(response.status);
						return true;
					},
					function (err) {
						lastProbe = {
							at: Date.now(),
							ok: false,
							status: null,
							ms: Date.now() - started,
							error: errorText(err)
						};
						api.lastProbe = lastProbe;
						// A single failed probe is NOT evidence that the backend is
						// gone. The probe has a 2.5s budget while the app can be
						// saturated (cold boot issues ~19k fs requests, an export
						// prints a 700KB PDF), so a timeout here is routinely a
						// slow moment rather than a dead server. Flipping offline on
						// one timeout blocks every write with EOFFLINE -- telling
						// the user "your change was not saved" while the server was
						// healthy the whole time.
						//
						// Require consecutive failures instead. Two probes at the
						// 2s online cadence means ~4s of unreachability before the
						// gate closes, which still recovers fast (see
						// tools/resilience-check.mjs: offline detected in <5s).
						probeFailures += 1;
						if (probeFailures >= PROBE_FAILURES_BEFORE_OFFLINE) {
							markOffline("probe: " + errorText(err));
						}
						return false;
					}
				)
				.then(function (value) {
					if (timeout) clearTimeout(timeout);
					probing = null;
					return value;
				});
		} catch (err) {
			// fetch() missing or throwing synchronously (very old browser, CSP):
			// report it as unreachable instead of letting it reach window.onerror.
			if (timeout) clearTimeout(timeout);
			probing = null;
			lastProbe = { at: Date.now(), ok: false, status: null, error: errorText(err) };
			api.lastProbe = lastProbe;
			markOffline("probe: " + errorText(err));
			return Promise.resolve(false);
		}

		return probing;
	}

	function schedule(delay) {
		if (timer !== null) return;
		timer = setTimeout(function () {
			timer = null;
			var attempt;
			try {
				attempt = probe();
			} catch (err) {
				attempt = Promise.resolve(false);
			}
			attempt
				.then(function () {
					schedule(api.online ? ONLINE_POLL_MS : OFFLINE_POLL_MS);
				})
				.catch(function () {
					schedule(api.online ? ONLINE_POLL_MS : OFFLINE_POLL_MS);
				});
		}, delay);
	}

	function probeNow() {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		var attempt;
		try {
			attempt = probe();
		} catch (err) {
			attempt = Promise.resolve(false);
		}
		return attempt.then(function (ok) {
			schedule(ok ? ONLINE_POLL_MS : OFFLINE_POLL_MS);
			return ok;
		});
	}

	function markOffline(source) {
		if (!api.online) return;
		api.online = false;
		offlineSince = Date.now();
		offlineSource = source;
		api.offlineSince = offlineSince;
		wasOffline = true;
		record("offline", { source: source });
		notify({
			level: "error",
			source: "server",
			message:
				"後端連線中斷。這段期間的修改不會存到磁碟；恢復連線後會自動重新整理離線期間的變更。",
			detail: source,
			dedupeKey: "server:offline"
		});
	}

	function markReachable(status) {
		if (!api.online) {
			var downtime = offlineSince ? Date.now() - offlineSince : 0;
			api.online = true;
			api.offlineSince = 0;
			record("online", { status: status, downtimeMs: downtime, source: offlineSource });
			record("reconnected", { status: status, downtimeMs: downtime });
			notify({
				level: "info",
				source: "server",
				message: "後端已重新連線，正在同步離線期間的變更。",
				dedupeKey: "server:reconnected"
			});
			if (wasOffline) {
				wasOffline = false;
				scheduleReconcile();
			}
			return;
		}
		wasOffline = false;
	}

	// ---------------------------------------------------------------------
	// Signals that do not wait for the next poll
	// ---------------------------------------------------------------------

	function noteNetworkFailure(op, path) {
		try {
			networkFailures += 1;
			api.networkFailures = networkFailures;
			/*
			 * One record per outage, not per failed read. Obsidian's vault walk
			 * fans out through Promise.all, so a single dead server produces
			 * thousands of failed reads in a second; recording each one would
			 * evict the events tests and operators care about.
			 */
			if (!api.online) return;
			record("network-failure", { op: op, path: path });
			markOffline("fs:" + (op || "?"));
		} catch (err) {
			/* never let diagnostics throw */
		}
	}

	function noteWriteBlocked(op, path, detail) {
		try {
			var where = path == null || path === "" ? "/" : String(path);
			record("write-blocked", { op: op, path: where, detail: detail || null });
			notify({
				level: "error",
				source: "fs",
				message:
					"後端中斷，這次修改沒有存到磁碟（" +
					where +
					"）。請確認 my-obsidian server 正在執行；恢復連線後請重新儲存。",
				detail: detail || op,
				dedupeKey: "write-blocked:" + where
			});
		} catch (err) {
			/* never let diagnostics throw */
		}
	}

	function checkSocket() {
		try {
			var watch = window.__MYOBS_WATCH;
			if (!watch || !watch.state) return;
			if (watch.state.connected === true) {
				sawSocketOpen = true;
				/*
				 * The probe is authoritative, but a connected socket is a
				 * positive signal too: a tunnel can proxy HEAD while the
				 * WebSocket is already back.
				 */
				if (!api.online) void probeNow();
				return;
			}
			/*
			 * Do not call this offline directly. On boot the socket is not
			 * connected yet, and during a normal restart the first attempts
			 * fail before the server is ready. Only turn a *lost* socket into
			 * an immediate probe; the probe decides.
			 */
			if (sawSocketOpen && api.online && !probing) {
				void probe().then(function (ok) {
					if (ok) schedule(ONLINE_POLL_MS);
				});
			}
		} catch (err) {
			/* ignore */
		}
	}

	/*
	 * Obsidian's save path awaits adapter.write but does not attach a rejection
	 * handler in every branch. The runtime's early error hook (index.html)
	 * treats any unhandled rejection as fatal and covers the app with the
	 * startup-failure overlay. A failed save while the backend is away is
	 * already reported twice (Obsidian's own notice, plus ours), so keep the
	 * overlay out of the way for *write* errors only. A read/boot error still
	 * deserves the overlay.
	 */
	window.addEventListener("unhandledrejection", function (event) {
		try {
			var reason = event.reason;
			if (!reason || !reason.myobs || reason.myobs.write !== true) return;
			if (!isOfflineError(reason)) return;
			record("fatal-suppressed", {
				op: reason.myobs.op,
				path: reason.myobs.path,
				code: reason.code
			});
			setTimeout(function () {
				try {
					var root = document.getElementById("myobs-fatal");
					if (!root) return;
					root.hidden = true;
					root.style.display = "none";
				} catch (err) {
					/* ignore */
				}
			}, 0);
		} catch (err) {
			/* never throw from an error handler */
		}
	});

	window.addEventListener("online", function () {
		void probeNow();
	});
	window.addEventListener("offline", function () {
		void probe();
	});
	document.addEventListener("visibilitychange", function () {
		if (document.visibilityState === "visible") void probeNow();
	});

	// ---------------------------------------------------------------------
	// Post-reconnect reconcile
	// ---------------------------------------------------------------------

	function scheduleReconcile() {
		if (reconcilePromise) {
			// A flap while reconciling must not lose the second pass.
			pendingReconcile = true;
			return;
		}
		reconcilePromise = reconcileVault()
			.catch(function (err) {
				record("reconcile-done", {
					ok: false,
					error: errorText(err),
					code: err && err.code ? err.code : null
				});
				notify({
					level: "warn",
					source: "server",
					message: "後端已恢復，但離線期間的變更同步失敗：" + errorText(err),
					dedupeKey: "server:reconcile-failed"
				});
				if (isOfflineError(err)) markOffline("reconcile");
			})
			.then(function () {
				reconcilePromise = null;
				if (pendingReconcile) {
					pendingReconcile = false;
					scheduleReconcile();
				}
			});
	}

	function waitForAdapter() {
		return new Promise(function (resolve) {
			var started = Date.now();
			var timerId = setInterval(function () {
				var app = window.app;
				var adapter = app && app.vault && app.vault.adapter;
				if (adapter && typeof adapter.reconcileFile === "function") {
					clearInterval(timerId);
					resolve(adapter);
					return;
				}
				if (Date.now() - started >= APP_WAIT_MS) {
					clearInterval(timerId);
					resolve(null);
				}
			}, 250);
		});
	}

	function absoluteFor(adapter, rel) {
		if (rel === "") {
			if (typeof adapter.getBasePath === "function") return adapter.getBasePath();
			return String((window.__MYOBS && window.__MYOBS.vaultPath) || "");
		}
		return adapter.getFullPath(rel);
	}

	function isDirectoryEntry(entry) {
		try {
			return typeof entry.isDirectory === "function" && entry.isDirectory();
		} catch (err) {
			return false;
		}
	}

	function entryName(entry) {
		if (typeof entry === "string") return entry;
		if (entry && typeof entry.name === "string") return entry.name;
		return String(entry);
	}

	/*
	 * Obsidian's own walker ignores every path with a hidden component
	 * (`Al()` at character 543441 / byte 547962: `Tl(e).startsWith(".")`), and
	 * keeps `.obsidian` on a separate watcher (watchHiddenRecursive). Walking
	 * hidden trees here would double the request count and report config files
	 * as "created during the outage" when they are simply not part of
	 * adapter.files by design.
	 */
	function isHiddenName(name) {
		return typeof name === "string" && name.charAt(0) === ".";
	}

	async function reconcileVault() {
		if (api.reconciling) {
			pendingReconcile = true;
			return;
		}
		api.reconciling = true;

		var started = Date.now();
		record("reconcile-start", {});

		var adapter = await waitForAdapter();
		if (!adapter) {
			api.reconciling = false;
			record("reconcile-done", {
				ok: false,
				error: "app.vault.adapter did not become available",
				durationMs: Date.now() - started
			});
			return;
		}

		var known = adapter.files || {};
		var seenFiles = new Set();
		var seenFolders = new Set();
		var files = [];
		var counts = {
			checked: 0,
			created: 0,
			changed: 0,
			deletedFiles: 0,
			deletedFolders: 0,
			createdFolders: 0,
			skipped: 0,
			errors: 0
		};
		var sampleCreated = [];
		var sampleDeleted = [];
		var SAMPLE_MAX = 20;

		async function walk(rel) {
			var entries = await adapter.fsPromises.readdir(absoluteFor(adapter, rel), {
				withFileTypes: true
			});
			entries = Array.from(entries || []).sort(function (a, b) {
				return entryName(a).localeCompare(entryName(b));
			});
			seenFolders.add(rel === "" ? "/" : rel);

			/*
			 * An empty folder has no file to pull its parent chain in via
			 * reconcileFile, so it would otherwise stay invisible until the
			 * next restart. Creating it here is cheap because listRecursive()
			 * on an empty folder only issues one readdir.
			 */
			if (entries.length === 0 && rel !== "" && !known[rel]) {
				await adapter.reconcileFolderCreation(adapter.getRealPath(rel), rel);
				counts.createdFolders += 1;
			}

			for (var i = 0; i < entries.length; i++) {
				var entry = entries[i];
				var name = entryName(entry);
				if (!name || isHiddenName(name)) continue;
				var child = rel === "" ? name : rel + "/" + name;
				if (isDirectoryEntry(entry)) {
					await walk(child);
				} else {
					files.push(child);
				}
			}
		}

		async function processFile(rel) {
			if (!api.online) {
				var offline = new Error("backend went away during reconcile");
				offline.code = "EOFFLINE";
				throw offline;
			}

			var recordBefore = known[rel];
			var stats;
			try {
				stats = await adapter.fsPromises.stat(absoluteFor(adapter, rel));
			} catch (err) {
				if (err && err.code === "ENOENT") return;
				throw err;
			}
			if (!stats || (typeof stats.isFile === "function" && !stats.isFile())) return;

			counts.checked += 1;
			var mtime = Math.round(stats.mtimeMs);
			var size = stats.size;
			var vanished = !recordBefore || recordBefore.type !== "file";
			var changed =
				!vanished &&
				(recordBefore.mtime !== mtime || recordBefore.size !== size);

			if (!vanished && !changed) {
				seenFiles.add(rel);
				return;
			}

			await adapter.reconcileFile(adapter.getRealPath(rel), rel);
			seenFiles.add(rel);
			if (vanished) {
				counts.created += 1;
				if (sampleCreated.length < SAMPLE_MAX) sampleCreated.push(rel);
			} else {
				counts.changed += 1;
			}
		}

		try {
			await walk("");

			var index = 0;
			async function worker() {
				while (true) {
					var current = index;
					index += 1;
					if (current >= files.length) return;
					var rel = files[current];
					try {
						await processFile(rel);
					} catch (err) {
						if (isOfflineError(err)) throw err;
						counts.errors += 1;
						if (counts.errors <= 10) {
							record("reconcile-path-error", {
								path: rel,
								code: err && err.code ? err.code : null,
								error: errorText(err)
							});
						}
					}
				}
			}

			var workers = [];
			var workerCount = Math.min(RECONCILE_CONCURRENCY, Math.max(files.length, 1));
			for (var w = 0; w < workerCount; w++) workers.push(worker());
			await Promise.all(workers);

			/*
			 * Deletions only after a complete walk. A half-finished walk must
			 * never be interpreted as "everything else was deleted".
			 */
			var knownKeys = Object.keys(known);
			for (var d = 0; d < knownKeys.length; d++) {
				var relToCheck = knownKeys[d];
				if (relToCheck === "/" || relToCheck === "") continue;
				var prior = known[relToCheck];
				if (!prior) continue;
				if (prior.type === "folder" && !seenFolders.has(relToCheck)) {
					await adapter.reconcileDeletion(relToCheck, relToCheck, true);
					counts.deletedFolders += 1;
					if (sampleDeleted.length < SAMPLE_MAX) sampleDeleted.push(relToCheck + "/");
				}
			}
			for (var f = 0; f < knownKeys.length; f++) {
				var fileRel = knownKeys[f];
				if (fileRel === "/" || fileRel === "") continue;
				var filePrior = known[fileRel];
				if (!filePrior || filePrior.type !== "file" || seenFiles.has(fileRel)) continue;
				await adapter.reconcileDeletion(fileRel, fileRel, true);
				counts.deletedFiles += 1;
				if (sampleDeleted.length < SAMPLE_MAX) sampleDeleted.push(fileRel);
			}
		} finally {
			api.reconciling = false;
		}

		var result = {
			ok: true,
			durationMs: Date.now() - started,
			checked: counts.checked,
			created: counts.created,
			changed: counts.changed,
			deletedFiles: counts.deletedFiles,
			deletedFolders: counts.deletedFolders,
			createdFolders: counts.createdFolders,
			skipped: counts.skipped,
			errors: counts.errors,
			sampleCreated: sampleCreated,
			sampleDeleted: sampleDeleted
		};
		api.lastReconcile = result;
		record("reconcile-done", result);

		var touched =
			counts.created + counts.changed + counts.deletedFiles + counts.deletedFolders + counts.createdFolders;
		if (touched > 0) {
			notify({
				level: "info",
				source: "server",
				message:
					"已同步離線期間的變更：新增 " +
					counts.created +
					"、修改 " +
					counts.changed +
					"、刪除 " +
					(counts.deletedFiles + counts.deletedFolders) +
					"（掃描 " +
					counts.checked +
					" 個檔案）。",
				dedupeKey: "server:reconciled"
			});
		} else {
			notify({
				level: "info",
				source: "server",
				message: "後端已重新連線；離線期間沒有檔案變更。",
				dedupeKey: "server:reconciled-none"
			});
		}
	}

	function reconcileNow() {
		if (!api.online) return Promise.resolve(false);
		return reconcileVault().then(function () {
			return true;
		});
	}

	// ---------------------------------------------------------------------
	// Bootstrap
	// ---------------------------------------------------------------------

	function start() {
		// The first probe is delayed a little so a page that is still parsing
		// does not compete with app.js for the single connection pool.
		schedule(1000);
		wsTimer = setInterval(checkSocket, WS_CHECK_MS);
		record("installed", { pollMs: ONLINE_POLL_MS, offlinePollMs: OFFLINE_POLL_MS });
	}

	try {
		start();
	} catch (err) {
		api.reason = "resilience bootstrap failed: " + errorText(err);
		try {
			console.warn("[my-obsidian] resilience bootstrap failed", err);
		} catch (ignored) {
			/* ignore */
		}
	}
})();
