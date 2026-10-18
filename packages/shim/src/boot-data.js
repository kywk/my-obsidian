/*
 * boot-data.js — classic script (no modules, no imports).
 *
 * Responsibilities:
 *   1. Validate the boot JSON injected by the server (CONTRACTS.md §1).
 *   2. Create the module registry used by the other shims.
 *   3. Surface configuration errors before Obsidian's bundle starts.
 *   4. Normalise the two worker URLs that the shipped bundle hard-codes.
 *
 * The server replaces the `<!-- MYOBS_BOOT -->` marker in
 * packages/runtime/index.html with:
 *
 *   <script>window.__MYOBS = { ... }</script>
 *
 * so this file must run after that inline script and before every other
 * shim (index.html guarantees that order).
 */
(function () {
	"use strict";

	var MODULES = {};
	window.__MYOBS_MODULES = MODULES;

	function makeBootError(message, details) {
		var err = new Error(message);
		err.code = "MYOBS_BOOT_DATA_INVALID";
		err.details = details || [];
		return err;
	}

	/**
	 * Display a fatal error. index.html installs window.__myobsFatal before
	 * this script runs; the DOM fallback below keeps this file usable in
	 * isolation (for example when loaded by a test harness).
	 */
	function fatal(title, detail) {
		var text = String(detail == null ? "" : detail);
		console.error("[my-obsidian] " + title + (text ? "\n" + text : ""));

		if (typeof window.__myobsFatal === "function") {
			try {
				window.__myobsFatal(title, text);
				return;
			} catch (err) {
				/* fall through to the minimal fallback */
			}
		}

		var root = document.getElementById("myobs-fatal");
		if (!root) {
			return;
		}
		var titleEl = document.getElementById("myobs-fatal-title");
		var messageEl = document.getElementById("myobs-fatal-message");
		var detailEl = document.getElementById("myobs-fatal-detail");
		if (titleEl) titleEl.textContent = title;
		if (messageEl) messageEl.textContent = text.split("\n")[0] || title;
		if (detailEl) detailEl.textContent = text;
		root.hidden = false;
		root.style.display = "flex";
	}

	function isAbsolutePath(value) {
		return value.charAt(0) === "/" || /^[A-Za-z]:[\\/]/.test(value);
	}

	function isNonEmptyString(value) {
		return typeof value === "string" && value.length > 0;
	}

	function validate(raw) {
		var errors = [];

		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			errors.push("window.__MYOBS 不存在或不是物件；server 是否替換了 <!-- MYOBS_BOOT -->？");
			return errors;
		}

		function requireString(name, nonEmpty) {
			var value = raw[name];
			if (typeof value !== "string" || (nonEmpty !== false && value.length === 0)) {
				errors.push("__MYOBS." + name + " 必須是" + (nonEmpty === false ? "" : "非空") + "字串");
			}
		}

		requireString("vaultId");
		requireString("vaultName");
		requireString("vaultPath");
		requireString("resourcesPath");
		requireString("resourcePrefix");
		requireString("version");
		requireString("build");
		requireString("platform");
		requireString("arch");
		requireString("documentsDir");
		requireString("desktopDir");

		if (isNonEmptyString(raw.vaultPath) && !isAbsolutePath(raw.vaultPath)) {
			errors.push("__MYOBS.vaultPath 必須是絕對路徑（目前：" + raw.vaultPath + "）");
		}
		if (isNonEmptyString(raw.vaultPath) && /[\\/]$/.test(raw.vaultPath) && raw.vaultPath !== "/") {
			errors.push("__MYOBS.vaultPath 結尾不可有斜線（CONTRACTS.md §1）");
		}
		if (isNonEmptyString(raw.resourcesPath) && raw.resourcesPath.charAt(0) !== "/") {
			errors.push("__MYOBS.resourcesPath 必須以 / 開頭（URL 前綴）");
		}
		if (isNonEmptyString(raw.resourcePrefix) && raw.resourcePrefix.charAt(0) !== "/") {
			errors.push("__MYOBS.resourcePrefix 必須以 / 開頭");
		}
		if (!raw.policy || typeof raw.policy !== "object" || Array.isArray(raw.policy)) {
			errors.push("__MYOBS.policy 必須是物件");
		}
		if (typeof raw.termsAccepted !== "boolean") {
			errors.push("__MYOBS.termsAccepted 必須是 boolean");
		}
		if (raw.termsAccepted === true && !isNonEmptyString(raw.termsText)) {
			// Without this check Obsidian compares "" with its own constant and
			// calls window.close(), leaving the user on a blank screen.
			errors.push(
				"__MYOBS.termsAccepted 為 true，但 __MYOBS.termsText 缺少或為空；" +
				"server 必須注入使用者已同意的條文字串（DESIGN.md §8）"
			);
		}
		if (raw.termsAccepted === false) {
			errors.push("__MYOBS.termsAccepted 為 false；server 不應提供 app.js，應顯示同意畫面（DESIGN.md §8）");
		}
		if (Object.prototype.hasOwnProperty.call(raw, "devMode") && typeof raw.devMode !== "boolean") {
			errors.push("__MYOBS.devMode 必須是 boolean");
		}

		// The prefix is concatenated with an absolute path in
		// FileSystemAdapter.getResourcePath(), so it must end in "/".
		if (isNonEmptyString(raw.resourcePrefix) && raw.resourcePrefix.charAt(raw.resourcePrefix.length - 1) !== "/") {
			raw.resourcePrefix += "/";
		}

		return errors;
	}

	var errors = validate(window.__MYOBS);
	if (errors.length > 0) {
		var bootError = makeBootError("my-obsidian boot data is invalid", errors);
		window.__MYOBS_BOOT_OK = false;
		window.__MYOBS_BOOT_ERROR = bootError;
		fatal("my-obsidian 設定錯誤", errors.join("\n"));
		throw bootError;
	}

	window.__MYOBS_BOOT_OK = true;

	/*
	 * Per-session write token. fs-shim stamps it onto every mutation and
	 * watch-shim drops WS events that carry it back (CONTRACTS.md §4), which is
	 * what stops "our save -> reload -> plugin saves data.json -> reload" from
	 * becoming a loop.
	 *
	 * The server does not inject one today, but if it ever does its value must
	 * win: a tab-scoped token generated here would not match a token the server
	 * had already associated with this session.
	 */
	(function ensureSessionToken() {
		var boot = window.__MYOBS;
		if (!boot || typeof boot !== "object") return;
		if (typeof boot.sessionToken === "string" && boot.sessionToken !== "") return;

		function bytesToHex(value) {
			var out = "";
			for (var i = 0; i < value.length; i++) {
				out += (value[i] < 16 ? "0" : "") + value[i].toString(16);
			}
			return out;
		}

		var token = "";
		try {
			if (window.crypto && typeof window.crypto.randomUUID === "function") {
				token = window.crypto.randomUUID();
			} else if (window.crypto && typeof window.crypto.getRandomValues === "function") {
				var bytes = new Uint8Array(16);
				window.crypto.getRandomValues(bytes);
				token = bytesToHex(bytes);
			}
		} catch (err) {
			/* randomUUID can throw outside a secure context; fall through */
		}

		if (!token) {
			// Last resort only: still unique per tab, but not cryptographically
			// random. It is an echo marker, not an authorization credential.
			token = "myobs-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
		}

		boot.sessionToken = token;
	})();

	/*
	 * The shipped renderer creates these workers with paths relative to the
	 * document URL (or, for the graph worker, with a root-absolute path):
	 *
	 *   new Worker("worker.js", { name: "Metadata Cache Worker" })
	 *   new Worker("/sim.js",   { name: "Graph Worker" })
	 *   new Worker("/worker.js")                       // publish renderer
	 *
	 * The runtime page is normally served from "/", while the vendor assets
	 * live under resourcesPath ("/obsidian"). Rewriting only these three known
	 * spellings keeps plugin workers (blob URLs, plugin resource paths) intact.
	 */
	(function installWorkerResolver() {
		var NativeWorker = window.Worker;
		if (typeof NativeWorker !== "function" || NativeWorker.__myobsPatched) {
			return;
		}

		var base = String(window.__MYOBS.resourcesPath || "/obsidian").replace(/\/+$/, "");
		var known = Object.create(null);
		known["worker.js"] = base + "/worker.js";
		known["/worker.js"] = base + "/worker.js";
		known["sim.js"] = base + "/sim.js";
		known["/sim.js"] = base + "/sim.js";

		function MyObsWorker(url, options) {
			if (typeof url === "string" && Object.prototype.hasOwnProperty.call(known, url)) {
				url = known[url];
			}
			return new NativeWorker(url, options);
		}

		MyObsWorker.prototype = NativeWorker.prototype;
		MyObsWorker.__myobsPatched = true;
		window.Worker = MyObsWorker;
	})();
})();
