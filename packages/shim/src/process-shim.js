/*
 * process-shim.js — classic script.
 *
 * Obsidian reads process.platform / process.arch very early (both for the
 * FileSystemAdapter case-sensitivity probe and for UI branches), and also
 * reads process.versions.electron when it decides which Electron APIs exist.
 * Everything else is a browser-safe approximation.
 */
(function () {
	"use strict";

	var boot = window.__MYOBS || {};
	var modules = window.__MYOBS_MODULES || (window.__MYOBS_MODULES = {});

	var processShim = {
		// Boot contract values.
		platform: boot.platform || "darwin",
		arch: boot.arch || "arm64",

		// Electron 35 / Node 22 / Chromium 128 are the values the 1.14.4
		// renderer expects when it gates APIs by major version.
		versions: {
			electron: "35.0.0",
			node: "22.0.0",
			chrome: "128.0.0"
		},

		env: {},
		argv: [],
		execPath: "/obsidian/obsidian",
		pid: 1,
		title: "node",
		browser: true,
		type: "renderer",

		cwd: function () {
			return "/";
		},

		nextTick: function (fn) {
			var args = Array.prototype.slice.call(arguments, 1);
			if (typeof fn !== "function") {
				throw new TypeError("process.nextTick callback must be a function");
			}
			queueMicrotask(function () {
				fn.apply(null, args);
			});
		},

		// Obsidian installs/removes a few process listeners in popout windows.
		// A no-op that returns the process object is enough there.
		on: function () {
			return processShim;
		},
		once: function () {
			return processShim;
		},
		off: function () {
			return processShim;
		},
		removeListener: function () {
			return processShim;
		},
		removeAllListeners: function () {
			return processShim;
		},
		emit: function () {
			return false;
		}
	};

	// The renderer also reaches for process.resourcesPath through a few
	// code paths; expose the URL prefix as the virtual resources root.
	processShim.resourcesPath = boot.resourcesPath || "/obsidian";

	window.process = processShim;
	modules["process"] = processShim;
})();
