/*
 * plugin-watch.js — classic script, loaded from /runtime/ after every shim and
 * before Obsidian's defer scripts.
 *
 * Obsidian reconciles notes by itself, but nothing in the renderer reacts to
 * `.obsidian/plugins/<id>/*` changing on disk. This layer subscribes to the
 * raw event feed from watch-shim and performs the unload -> load cycle the
 * desktop app performs when a plugin file changes (DESIGN.md §4).
 *
 * Every action is recorded in window.__MYOBS_PLUGIN_WATCH.events so the
 * acceptance harness can assert on it, and every failure is swallowed into
 * that array: an exception here would reach window.onerror and replace the UI
 * with the fatal overlay.
 *
 * Approximations are documented in ../shim/GAPS.md.
 */
(function () {
	"use strict";

	var DEBOUNCE_MS = 400;
	var DEFER_POLL_MS = 500;
	var DEFER_MAX_MS = 30000;
	var APP_WAIT_MS = 60000;
	var APP_POLL_MS = 100;
	var BOOT_POLL_MS = 500;
	// A plugin manager is "settled" when neither the enabled set nor the loaded
	// set has moved for this long. Plugin onload is async and sequential, so a
	// shorter window reports slow plugins as failures.
	var BOOT_SETTLE_MS = 2500;
	// layoutReady is the normal end-of-boot signal; the fallback covers a boot
	// that never reaches it (headless or fatal later in startup).
	var BOOT_FALLBACK_MS = 20000;
	var BOOT_MAX_MS = 120000;
	var EVENTS_MAX = 200;

	var PLUGIN_PATH = /^\.obsidian\/plugins\/([^/]+)\/(.+)$/;
	// Only the files Obsidian itself reloads a plugin for (DESIGN.md §4). Any
	// other path inside a plugin folder (assets, custom css) is ignored.
	var WATCHED_FILES = {
		"main.js": true,
		"manifest.json": true,
		"styles.css": true,
		"data.json": true
	};

	/** @type {Array<{at: number, id: string, file: string, action: string, ok: boolean, error: string | null}>} */
	var events = [];
	var pending = Object.create(null);
	var deferred = Object.create(null);
	var unsubscribe = null;

	function readStoredFlag() {
		try {
			return localStorage.getItem("myobs-plugin-watch") === "off";
		} catch (err) {
			return false;
		}
	}

	var api = {
		enabled: !readStoredFlag(),
		events: events,
		subscribed: false,
		reloadAll: reloadAll
	};
	window.__MYOBS_PLUGIN_WATCH = api;

	// ---------------------------------------------------------------------
	// Diagnostics
	// ---------------------------------------------------------------------

	function record(id, file, action, ok, error) {
		var message = null;
		if (error) {
			message = error && error.message ? String(error.message) : String(error);
		}
		events.push({
			at: Date.now(),
			id: id,
			file: file,
			action: action,
			ok: ok === true,
			error: message
		});
		if (events.length > EVENTS_MAX) {
			events.splice(0, events.length - EVENTS_MAX);
		}
	}

	// ---------------------------------------------------------------------
	// User-visible failures
	// ---------------------------------------------------------------------

	function notices() {
		var api = window.__MYOBS_NOTICES;
		return api && typeof api.push === "function" ? api : null;
	}

	function messageOf(error) {
		if (!error) return "未知錯誤";
		if (error.message) return String(error.message);
		return String(error);
	}

	function stackOf(error) {
		if (error && typeof error.stack === "string" && error.stack !== "") {
			return error.stack;
		}
		return null;
	}

	function notify(level, message, detail, dedupeKey, actions) {
		try {
			var api = notices();
			if (!api) return;
			var payload = {
				level: level,
				source: "plugin",
				message: message,
				detail: detail,
				dedupeKey: dedupeKey
			};
			if (actions && actions.length) payload.actions = actions;
			api.push(payload);
		} catch (err) {
			// A notice must never become the reason a reload fails.
		}
	}

	function dismissPluginNotices(id) {
		try {
			var api = notices();
			if (!api || typeof api.list !== "function" || typeof api.dismiss !== "function") {
				return;
			}
			var key = "plugin:" + id;
			var items = api.list();
			for (var i = 0; i < items.length; i += 1) {
				if (items[i].dedupeKey === key) api.dismiss(items[i].id);
			}
		} catch (err) {
			// Dismissal is cosmetic; never let it escape.
		}
	}

	function disablePlugin(id) {
		var plugins = pluginManager();
		if (!plugins || typeof plugins.disablePluginAndSave !== "function") return;
		Promise.resolve()
			.then(function () {
				return plugins.disablePluginAndSave(id);
			})
			.then(
				function () {
					record(id, "disable", "disable", true, null);
					dismissPluginNotices(id);
					notify("info", "已停用外掛「" + id + "」", null, "plugin-disabled:" + id);
				},
				function (err) {
					record(id, "disable", "disable", false, err);
					notify(
						"error",
						"停用外掛「" + id + "」失敗：" + messageOf(err),
						stackOf(err),
						"plugin-disable-failed:" + id
					);
				}
			);
	}

	/**
	 * `disablePluginAndSave` is PluginManager's own "user turned this off"
	 * path: it drops the id from enabledPlugins and rewrites
	 * community-plugins.json, so a plugin that throws on every load stops
	 * being retried at the next boot. The card offers it because a plugin that
	 * fails during onload is otherwise only fixable through Settings.
	 */
	function buildActions(id) {
		var plugins = pluginManager();
		if (!plugins || typeof plugins.disablePluginAndSave !== "function") return [];
		if (!isEnabled(plugins, id)) return [];
		return [
			{
				label: "停用此外掛",
				onClick: function () {
					disablePlugin(id);
				}
			}
		];
	}

	/**
	 * Report a load/reload failure through the notice surface. `context` is
	 * "boot" or "reload"; both use the same dedupeKey so a plugin that keeps
	 * failing every 400 ms collapses into one card with a count.
	 */
	function reportFailure(id, file, error, context) {
		var reason = messageOf(error);
		var detail = stackOf(error);
		if (context === "boot") {
			detail = [
				"外掛：" + id,
				"狀態：已啟用（community-plugins.json）但 app.plugins.plugins 沒有實例。",
				"",
				"可能原因：onload 拋錯、manifest.json／main.js 缺失、版本或 policy 不相容。",
				"Obsidian 自己會在 console 印出 \"Plugin failure: " + id + "\" 與原始堆疊。"
			].join("\n");
		}
		notify(
			"error",
			(context === "boot"
				? "外掛「" + id + "」啟動時未載入："
				: "外掛「" + id + "」重新載入失敗" + (file ? "（" + file + "）" : "") + "：") + reason,
			detail,
			"plugin:" + id,
			buildActions(id)
		);
	}

	// ---------------------------------------------------------------------
	// Plugin manager helpers
	// ---------------------------------------------------------------------

	function pluginManager() {
		var app = window.app;
		if (!app || !app.plugins) return null;
		return app.plugins;
	}

	function isEnabled(plugins, id) {
		var enabled = plugins && plugins.enabledPlugins;
		if (!enabled) return false;
		if (typeof enabled.has === "function") return enabled.has(id);
		if (Array.isArray(enabled)) return enabled.indexOf(id) !== -1;
		return false;
	}

	function settingsOpen() {
		try {
			return document.querySelector(".mod-settings") !== null;
		} catch (err) {
			return false;
		}
	}

	/**
	 * Reload one plugin. `disablePlugin(id, true)` marks the unload as *not*
	 * user-initiated so Obsidian keeps the id in enabledPlugins and does not
	 * rewrite community-plugins.json; `enablePlugin` then constructs a fresh
	 * instance from the file on disk.
	 */
	async function reloadPlugin(id, file) {
		var plugins = pluginManager();
		if (!plugins || typeof plugins.enablePlugin !== "function") {
			record(id, file, "skip", false, "app.plugins is not available yet");
			return;
		}

		try {
			// The id may only exist in manifests (disabled plugin) or the
			// manifest may have just changed; refresh before deciding.
			if (typeof plugins.loadManifests === "function") {
				await plugins.loadManifests();
			}

			if (!isEnabled(plugins, id)) {
				record(id, file, "manifest", true, null);
				return;
			}

			await plugins.disablePlugin(id, true);

			if (!isEnabled(plugins, id)) {
				// Something else disabled it while we were unloading; enabling
				// now would contradict the user's action.
				record(id, file, "skip", true, "plugin was disabled during reload");
				return;
			}

			var loaded = await plugins.enablePlugin(id);
			var instance = plugins.plugins ? plugins.plugins[id] : undefined;
			if (loaded === false || !instance) {
				/*
				 * enablePlugin returns false without throwing for several
				 * reasons; the most common is a policy that disallows
				 * community plugins (app.js checks policy.plugins from
				 * sendSync("policy"), and CONTRACTS.md §1 injects "policy": {}).
				 * Naming it here saves the next person an afternoon.
				 */
				var policy = (window.__MYOBS && window.__MYOBS.policy) || {};
				var reason =
					"enablePlugin 未建立外掛實例（policy.plugins=" +
					JSON.stringify(policy.plugins) + "）";
				record(id, file, "reload", false, reason);
				reportFailure(id, file, new Error(reason), "reload");
			} else {
				record(id, file, "reload", true, null);
				dismissPluginNotices(id);
			}
		} catch (err) {
			record(id, file, "reload", false, err);
			reportFailure(id, file, err, "reload");
		}
	}

	/**
	 * Manual "reload all plugins" action for the UI toggle (DESIGN.md §4).
	 */
	async function reloadAll() {
		var plugins = pluginManager();
		if (!plugins) {
			record("*", "*", "reload-all", false, "app.plugins is not available");
			return;
		}
		var ids = [];
		try {
			ids = Array.from(plugins.enabledPlugins || []);
		} catch (err) {
			ids = [];
		}
		for (var i = 0; i < ids.length; i++) {
			cancelDeferred(ids[i]);
			await reloadPlugin(ids[i], "reloadAll");
		}
	}

	// ---------------------------------------------------------------------
	// Scheduling
	// ---------------------------------------------------------------------

	function cancelDeferred(id) {
		var entry = deferred[id];
		if (!entry) return;
		clearInterval(entry.timer);
		delete deferred[id];
	}

	/**
	 * A settings tab for this plugin is open, so applying data.json now would
	 * fight the user's unsaved edits (DESIGN.md §4). Poll until the modal is
	 * gone, then apply; give up after 30 s rather than reloading underneath an
	 * open form.
	 */
	function deferDataReload(id, file) {
		if (deferred[id]) return;
		var entry = { file: file, startedAt: Date.now(), timer: null };
		entry.timer = setInterval(function () {
			if (!api.enabled) {
				cancelDeferred(id);
				record(id, file, "deferred-abandoned", false, "plugin watch disabled while waiting");
				return;
			}
			if (Date.now() - entry.startedAt >= DEFER_MAX_MS) {
				cancelDeferred(id);
				record(id, file, "deferred-abandoned", false, "settings modal still open after 30s");
				return;
			}
			if (settingsOpen()) return;
			cancelDeferred(id);
			void applyReload(id, entry.file);
		}, DEFER_POLL_MS);
		deferred[id] = entry;
	}

	async function applyReload(id, file) {
		if (!api.enabled) return;
		if (file === "data.json" && settingsOpen()) {
			deferDataReload(id, file);
			return;
		}
		cancelDeferred(id);
		await reloadPlugin(id, file);
	}

	/**
	 * Maestral/Dropbox writes are not atomic: one save produces several events
	 * (and often main.js + manifest.json). Collapse them per plugin.
	 */
	function schedule(id, file) {
		var entry = pending[id];
		if (entry) clearTimeout(entry.timer);
		pending[id] = {
			file: file,
			timer: setTimeout(function () {
				delete pending[id];
				void applyReload(id, file);
			}, DEBOUNCE_MS)
		};
	}

	function onEvent(event) {
		try {
			if (!api.enabled) return;
			var match = PLUGIN_PATH.exec(String((event && event.path) || ""));
			if (!match) return;
			var id = match[1];
			var file = match[2];
			if (WATCHED_FILES[file] !== true) return;
			schedule(id, file);
		} catch (err) {
			record("*", "*", "event", false, err);
		}
	}

	// ---------------------------------------------------------------------
	// Boot-time load failures
	//
	// Nothing in the renderer reports "this plugin was enabled but never came
	// up" (Obsidian's own toast for it is transient and fires per attempt).
	// The state comparison below is the reliable observation point: after the
	// plugin manager has settled, `enabledPlugins` minus `plugins` is exactly
	// the set that failed to load. console.error is deliberately NOT patched --
	// it throws away signal and would turn unrelated noise into UI cards.
	// ---------------------------------------------------------------------

	function enabledIds(plugins) {
		var out = [];
		try {
			var enabled = plugins && plugins.enabledPlugins;
			if (enabled && typeof enabled.forEach === "function") {
				enabled.forEach(function (id) {
					out.push(String(id));
				});
			} else if (Array.isArray(enabled)) {
				enabled = enabled.slice();
				for (var i = 0; i < enabled.length; i += 1) out.push(String(enabled[i]));
			}
		} catch (err) {
			return [];
		}
		out.sort();
		return out;
	}

	function reconcileBootFailures(plugins, enabled) {
		var loaded = plugins.plugins || {};
		var failed = enabled.filter(function (id) {
			return !loaded[id];
		});

		// policy.plugins is Obsidian's own gate (`policyAllows`). A missing or
		// non-array value means every community plugin was refused, which is
		// one root cause, not one failure per plugin (DESIGN.md §11.3).
		var policy = (window.__MYOBS && window.__MYOBS.policy) || {};
		var allowed = policy.plugins;
		if (allowed !== true) {
			if (Array.isArray(allowed)) {
				failed = failed.filter(function (id) {
					return allowed.indexOf(id) !== -1;
				});
			} else {
				record("*", "*", "boot-policy", false, "policy.plugins=" + JSON.stringify(allowed));
				notify(
					"error",
					"所有社群外掛都未載入：__MYOBS.policy.plugins 不是 true",
					"enablePlugin() 第一行就以 policyAllows(policy.plugins, id) 擋掉每個社群外掛，且沒有錯誤訊息。\n" +
						"請確認 server 注入的 __MYOBS.policy（packages/server/src/index.js 的 DEFAULT_POLICY）；" +
						"詳見 docs/DESIGN.md §11.3。\n\n目前值：" + JSON.stringify(allowed),
					"plugin-policy"
				);
				return;
			}
		}

		// isDesktopOnly plugins are skipped on mobile by design, not broken.
		var platform = window.Platform;
		if (platform && platform.isDesktopApp === false) {
			var manifests = plugins.manifests || {};
			failed = failed.filter(function (id) {
				var manifest = manifests[id];
				return !(manifest && manifest.isDesktopOnly === true);
			});
		}

		for (var i = 0; i < failed.length; i += 1) {
			record(failed[i], "boot", "boot", false, "enabled but not loaded");
			reportFailure(failed[i], "boot", new Error("已啟用但未建立外掛實例"), "boot");
		}
		record(
			"*",
			"*",
			"boot-scan",
			true,
			"failed=" + failed.length + " of " + enabled.length
		);
	}

	function startBootCheck() {
		var startedAt = Date.now();
		var lastSignature = null;
		var lastChangeAt = Date.now();
		var done = false;
		var timer = setInterval(function () {
			if (done) {
				clearInterval(timer);
				return;
			}
			try {
				var plugins = pluginManager();
				var app = window.app;
				if (!plugins || !app) return;

				var enabled = enabledIds(plugins);
				var loaded = Object.keys(plugins.plugins || {}).sort();
				var manifests = Object.keys(plugins.manifests || {}).length;
				var loading = plugins.loadingPluginId || null;
				var restricted =
					typeof plugins.isEnabled === "function" && plugins.isEnabled() !== true;

				var signature =
					enabled.join("|") + "::" + loaded.join("|") + "::" +
					String(loading) + "::" + manifests;
				if (signature !== lastSignature) {
					lastSignature = signature;
					lastChangeAt = Date.now();
				}

				var layoutReady = !!(app.workspace && app.workspace.layoutReady === true);
				var settled = loading === null && Date.now() - lastChangeAt >= BOOT_SETTLE_MS;
				var ready = layoutReady || Date.now() - startedAt >= BOOT_FALLBACK_MS;
				// With an empty enabled set there is nothing to load, so an
				// empty manifest map is a legitimate final state.
				var hasWork = enabled.length === 0 || manifests > 0;

				if (settled && ready && hasWork) {
					done = true;
					clearInterval(timer);
					if (restricted) {
						record("*", "*", "boot-scan", true, "community plugins are off");
						return;
					}
					reconcileBootFailures(plugins, enabled);
				} else if (Date.now() - startedAt >= BOOT_MAX_MS) {
					done = true;
					clearInterval(timer);
					record("*", "*", "boot-scan-abandoned", false, "not settled within 120s");
				}
			} catch (err) {
				done = true;
				clearInterval(timer);
				record("*", "*", "boot-scan", false, err);
			}
		}, BOOT_POLL_MS);
	}

	// ---------------------------------------------------------------------
	// Bootstrap
	// ---------------------------------------------------------------------

	function start() {
		var watch = window.__MYOBS_WATCH;
		if (!watch || typeof watch.subscribe !== "function") {
			console.warn(
				"[my-obsidian] watch-shim is not loaded; plugin hot reload is disabled"
			);
			return;
		}
		try {
			unsubscribe = watch.subscribe(onEvent);
			api.subscribed = true;
			api.unsubscribe = unsubscribe;
		} catch (err) {
			console.warn("[my-obsidian] could not subscribe to watch events", err);
		}
	}

	var waited = 0;
	var appTimer = setInterval(function () {
		waited += APP_POLL_MS;
		if (window.app) {
			clearInterval(appTimer);
			try {
				start();
			} catch (err) {
				console.warn("[my-obsidian] plugin watch failed to start", err);
			}
			try {
				startBootCheck();
			} catch (err) {
				console.warn("[my-obsidian] boot plugin check failed to start", err);
			}
			return;
		}
		if (waited >= APP_WAIT_MS) {
			clearInterval(appTimer);
			console.warn(
				"[my-obsidian] window.app did not appear within 60s; plugin hot reload is disabled"
			);
		}
	}, APP_POLL_MS);
})();
