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

	var SUPPORTED = ["electron", "fs", "original-fs", "path", "os", "url", "crypto", "btime", "process"];

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
			"Cannot find module '" + name + "'. The browser shim provides: " + SUPPORTED.join(", ") + "."
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

	function builtinNotSupported(name) {
		var error = new Error(
			"Node.js built-in module '" + name + "' is not provided by the browser shim. " +
			"Supported modules: " + SUPPORTED.join(", ") + "."
		);
		error.code = "MODULE_NOT_SUPPORTED";
		error.moduleName = name;
		error.reason = "node-builtin";
		return error;
	}

	function requireModule(name) {
		if (typeof name !== "string" || name.length === 0) {
			var typeError = new TypeError("module name must be a non-empty string");
			typeError.code = "MODULE_NOT_SUPPORTED";
			throw typeError;
		}

		var normalized = name.slice(0, 5) === "node:" ? name.slice(5) : name;

		if (Object.prototype.hasOwnProperty.call(modules, normalized)) {
			return modules[normalized];
		}

		if (SERVER_SIDE[normalized]) {
			throw serverSideNotSupported(name);
		}
		if (NODE_BUILTINS[normalized]) {
			throw builtinNotSupported(name);
		}
		throw moduleNotFound(name);
	}

	requireModule.resolve = function (name) {
		if (typeof name === "string" && Object.prototype.hasOwnProperty.call(modules, name)) {
			return name;
		}
		throw moduleNotFound(name);
	};

	requireModule.cache = Object.create(null);

	window.require = requireModule;
})();
