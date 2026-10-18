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
				record(
					id,
					file,
					"reload",
					false,
					"enablePlugin did not load the plugin (policy.plugins=" +
						JSON.stringify(policy.plugins) + ")"
				);
			} else {
				record(id, file, "reload", true, null);
			}
		} catch (err) {
			record(id, file, "reload", false, err);
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
