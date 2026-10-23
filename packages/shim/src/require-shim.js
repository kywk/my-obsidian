/*
 * require-shim.js — classic script, loaded LAST.
 *
 * Window.require() is the only module entry point plugins (and a few internal
 * code paths) see. It resolves names against the registry that the previous
 * shims filled in; every other name fails loudly with
 * code = "MODULE_NOT_SUPPORTED" instead of returning undefined.
 */
(function () {
	"use strict";

	var modules = window.__MYOBS_MODULES || (window.__MYOBS_MODULES = {});

	// Derived from the registry rather than hard-coded: the error messages below
	// are the only place a plugin author learns what this runtime offers, and a
	// stale list there is worse than no list.
	function supportedNames() {
		return Object.keys(modules).sort();
	}

	// Modules that would require server-side execution rights. These get a
	// dedicated message because Obsidian surfaces it to the user.
	var SERVER_SIDE = {
		child_process: true,
		net: true,
		worker_threads: true,
		dgram: true,
		tls: true,
		http: true,
		https: true
	};

	var NODE_BUILTINS = {
		assert: true,
		async_hooks: true,
		buffer: true,
		cluster: true,
		console: true,
		constants: true,
		diagnostics_channel: true,
		dns: true,
		domain: true,
		events: true,
		http2: true,
		inspector: true,
		module: true,
		perf_hooks: true,
		punycode: true,
		querystring: true,
		readline: true,
		repl: true,
		stream: true,
		string_decoder: true,
		sys: true,
		timers: true,
		trace_events: true,
		tty: true,
		util: true,
		v8: true,
		vm: true,
		wasi: true,
		zlib: true,
		test: true
	};

	function moduleNotFound(name) {
		var error = new Error(
			"Cannot find module '" + name + "'. The browser shim provides: " + supportedNames().join(", ") + "."
		);
		error.code = "MODULE_NOT_SUPPORTED";
		error.moduleName = name;
		return error;
	}

	function serverSideNotSupported(name) {
		var error = new Error(
			"Module '" + name + "' requires server-side execution rights and is not available in the " +
			"browser runtime. This plugin cannot run here (DESIGN.md §7)."
		);
		error.code = "MODULE_NOT_SUPPORTED";
		error.moduleName = name;
		error.reason = "server-side-module";
		return error;
	}

	// These plugins import process helpers eagerly but only invoke them for
	// optional shell/AI features. Importing is harmless; execution stays local
	// to this refusal with no RPC or pretend ChildProcess/empty output.
	var processFacade = Object.create(null);
	["exec", "execFile", "execSync", "execFileSync", "spawn", "spawnSync", "fork", "ChildProcess", "_forkChild"].forEach(function (operation) {
		processFacade[operation] = function () {
			var error = serverSideNotSupported("child_process");
			error.operation = operation;
			error.message = "目前瀏覽器版本不支援執行外部程式（child_process." + operation +
				"）。請停用外掛的 shell／本機 AI 功能，改用不需外部程式的操作。";
			try {
				var notices = window.__MYOBS_NOTICES;
				if (notices && typeof notices.push === "function") {
					notices.push({ level: "warn", source: "plugin", message: error.message,
						dedupeKey: "capability:child_process:" + operation });
				}
			} catch (_) { /* A notification cannot change the refusal contract. */ }
			throw error;
		};
	});
	modules.child_process = Object.freeze(processFacade);

	function builtinNotSupported(name) {
		var error = new Error(
			"Node.js built-in module '" + name + "' is not provided by the browser shim. " +
			"Supported modules: " + supportedNames().join(", ") + "."
		);
		error.code = "MODULE_NOT_SUPPORTED";
		error.moduleName = name;
		error.reason = "node-builtin";
		return error;
	}

	var SUBPATHS = {
		"fs/promises": ["fs", "promises"],
		"path/posix": ["path", "posix"],
		"path/win32": ["path", "win32"]
	};

	function has(object, name) {
		return Object.prototype.hasOwnProperty.call(object, name);
	}

	function lookup(name) {
		if (typeof name !== "string" || name.length === 0) {
			var typeError = new TypeError("module name must be a non-empty string");
			typeError.code = "MODULE_NOT_SUPPORTED";
			throw typeError;
		}

		var normalized = name.slice(0, 5) === "node:" ? name.slice(5) : name;

		if (has(modules, normalized)) {
			return modules[normalized];
		}
		if (has(SUBPATHS, normalized)) {
			var target = SUBPATHS[normalized];
			if (has(modules, target[0]) && has(modules[target[0]], target[1])) {
				return modules[target[0]][target[1]];
			}
		}

		var root = normalized.split("/")[0];
		if (has(SERVER_SIDE, root)) {
			throw serverSideNotSupported(name);
		}
		if (has(NODE_BUILTINS, root)) {
			throw builtinNotSupported(name);
		}
		throw moduleNotFound(name);
	}

	function requireModule(name) {
		return lookup(name);
	}

	requireModule.resolve = function (name) {
		// Resolving a built-in must apply the same aliases and refusal as loading
		// it; plugins commonly feature-detect with resolve before require.
		lookup(name);
		return name;
	};

	requireModule.cache = Object.create(null);

	window.require = requireModule;
})();
