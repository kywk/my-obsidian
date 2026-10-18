/*
 * popout.js — classic script, loaded from /runtime/ after every shim and before
 * Obsidian's defer scripts.
 *
 * Multi-window ("Open in new window") support for the browser runtime. The
 * shipped bundle implements this feature itself and reaches the host through
 * exactly one call (vendor/obsidian/app.js @ ~2620310):
 *
 *   function p0(e) {
 *     var o = ["popup"];
 *     e.parented && o.push("parented=1");
 *     o.push("width=" + t, "height=" + n, "x=" + i, "y=" + r);
 *     o.push("background=" + $x(color));
 *     var s = window.open("about:blank", "_blank", o.join(","));
 *     if (!s) return null;
 *     s.document.head.appendChild(createEl("base", { href: location.href }));
 *     w0(s);            // eval enhance.js INTO the new window
 *     h0(s);            // attach electron + electronWindow to the new window
 *     jM(s.document); woe(s); b0(s); gb(s.document); m0(s);
 *     var c = y0(s, [baseEl]);          // style relay (head -> head)
 *     s.addEventListener("focus", function () {
 *       activeWindow = s; activeDocument = s.document;
 *     });
 *     return { win: s, baseEl: baseEl, cleanup: c };
 *   }
 *
 * The returned window is an *initial about:blank document*: same origin as this
 * page, same renderer process, never navigated. Obsidian therefore writes into
 * it synchronously and keeps a live reference to it as a Workspace "window"
 * node (x3):
 *
 *   var c = r.win = l.win;
 *   c.app = t.app;                     // the SAME app object, not a copy
 *   r.doc = c.document;
 *
 * That is the desktop model and it works in a browser tab as well: the popout
 * is a second DOM surface over the *same* JavaScript heap, not a second app.
 * The Workspace keeps one leaf tree, `activeWindow` / `activeDocument` follow
 * focus, popout input is relayed to the main window (m0), and styles are
 * mirrored by the relay in y0. A second boot of this page would be a different
 * product: two vault scans, two metadata caches, two plugin sets writing
 * .obsidian/workspace-server.json.
 *
 * What a browser does *not* provide, and this file adds:
 *
 *   1. h0() needs a working `require("electron")` in the *popout's own* global
 *      scope (Electron gives the popout renderer nodeIntegration). Without it
 *      the popout window has no `electron` / `electronWindow` at all, and
 *      several paths in the bundle use them unguarded — for example x3's
 *      beforeunload handler (`c.electron.ipcRenderer.sendSync("is-quitting")`)
 *      and `moveLeafToPopout`'s zoom read
 *      (`containerEl.win.electron.webFrame.getZoomLevel()`).
 *   2. window.open() can be blocked by the browser; the bundle then throws
 *      "Unable to open a new window." and nothing is visible to the user.
 *   3. A URL cannot address the popout document (it is about:blank), so
 *      `#popout=<vault path>` / `?popout=<vault path>` is handled as a request
 *      that the user confirms with a click (a popup needs a user gesture).
 *
 * Approximations are documented in ../shim/GAPS.md.
 */
(function () {
	"use strict";

	var EVENTS_MAX = 100;
	var APP_POLL_MS = 100;
	var APP_WAIT_MS = 60000;
	var FILE_POLL_MS = 200;
	// Long enough to cover the workspace load that recreates popouts, short
	// enough to stop polling abandoned windows.
	var FILE_TRACK_MS = 15000;
	// Electron's default BrowserWindow size, used when Obsidian asks for a
	// popout without one (openPopoutLeaf from the command palette does).
	var DEFAULT_POPOUT_WIDTH = 800;
	var DEFAULT_POPOUT_HEIGHT = 600;

	/*
	 * Classic shims, in index.html's dependency order. They run inside the
	 * popout realm so that `h0()` finds `require` where it looks for it (on the
	 * popout's own window, which is the top window of that document).
	 *
	 * watch-shim is deliberately absent: a popout realm has no vault adapter and
	 * therefore no fs.watch consumer, so a second /api/watch WebSocket per
	 * popout would carry events nobody reads. fs-shim keeps its documented
	 * no-op watcher fallback in that case (GAPS.md §3).
	 */
	var SHIM_FILES = [
		"/shim/boot-data.js",
		"/shim/node-globals-shim.js",
		"/shim/process-shim.js",
		"/shim/electron-shim.js",
		"/shim/fs-shim.js",
		"/shim/path-shim.js",
		"/shim/os-shim.js",
		"/shim/url-shim.js",
		"/shim/crypto-shim.js",
		"/shim/btime-shim.js",
		"/shim/require-shim.js"
	];

	/** @type {Array<{at: number, action: string, [key: string]: any}>} */
	var events = [];
	/** @type {string[] | null} shim sources, once loaded */
	var sources = null;
	/** @type {{root: HTMLElement, text: HTMLElement, actions: HTMLElement} | null} */
	var banner = null;
	var appWaiter = null;

	function describeError(error) {
		if (!error) return "unknown";
		return error && error.message ? String(error.message) : String(error);
	}

	function record(action, detail) {
		var entry = { at: Date.now(), action: action };
		if (detail) {
			for (var key in detail) {
				if (Object.prototype.hasOwnProperty.call(detail, key)) entry[key] = detail[key];
			}
		}
		events.push(entry);
		if (events.length > EVENTS_MAX) events.shift();
		return entry;
	}

	var api = {
		installed: false,
		/** One record per popout window this page opened. */
		frames: [],
		events: events,
		blocked: 0,
		request: null,
		openInNewWindow: openInNewWindow
	};
	window.__MYOBS_POPOUT = api;

	// ---------------------------------------------------------------------
	// Child window environment
	// ---------------------------------------------------------------------

	function freshToken() {
		/*
		 * Echo filtering is per document (CONTRACTS.md §4, GAPS.md §3b): the
		 * popout realm issues its own fs writes, so it needs its own token. The
		 * parent's token must not be reused — the parent would then ignore
		 * events caused by popout-side writes.
		 */
		var token = "";
		try {
			if (window.crypto && typeof window.crypto.randomUUID === "function") {
				token = window.crypto.randomUUID();
			} else if (window.crypto && typeof window.crypto.getRandomValues === "function") {
				var bytes = new Uint8Array(16);
				window.crypto.getRandomValues(bytes);
				for (var i = 0; i < bytes.length; i++) {
					token += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
				}
			}
		} catch (err) {
			/* randomUUID throws outside a secure context; fall through */
		}
		if (!token) {
			// Last resort: unique per popout, but not cryptographically random.
			// It is an echo marker, not a credential (boot-data.js does the
			// same for the main document).
			token = "myobs-popout-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
		}
		return token;
	}

	function childBoot() {
		var parent = window.__MYOBS || {};
		var boot = {};
		for (var key in parent) {
			if (Object.prototype.hasOwnProperty.call(parent, key)) boot[key] = parent[key];
		}
		boot.sessionToken = freshToken();
		return boot;
	}

	function fetchSources() {
		return Promise.all(
			SHIM_FILES.map(function (url) {
				return fetch(url, { credentials: "same-origin" }).then(function (response) {
					if (!response.ok) throw new Error(url + ": HTTP " + response.status);
					return response.text();
				});
			})
		);
	}

	/*
	 * window.open() has to return a fully instrumented window to Obsidian's very
	 * next statement, so this path cannot be asynchronous. Sources are
	 * prefetched at load time; the synchronous XHR loop below only runs if the
	 * prefetch has not finished (or failed) by the time a popout is requested.
	 */
	function loadSourcesSync() {
		if (sources) return sources;
		var out = [];
		var xhr = new XMLHttpRequest();
		for (var i = 0; i < SHIM_FILES.length; i++) {
			xhr.open("GET", SHIM_FILES[i], false);
			xhr.send(null);
			if (xhr.status !== 200) {
				throw new Error("cannot load " + SHIM_FILES[i] + " (HTTP " + xhr.status + ")");
			}
			out.push(xhr.responseText);
		}
		sources = out;
		return out;
	}

	/**
	 * Give the popout realm the same host environment this document has.
	 * Must run synchronously between window.open() and Obsidian's next line
	 * (h0), because h0 reads `require` from the popout window.
	 *
	 * @param {Window} win
	 * @param {{at: number}} frame
	 */
	function instrumentPopout(win, frame) {
		if (win.__MYOBS_POPOUT_WINDOW) {
			frame.instrumented = true;
			return;
		}
		if (!win.document || !win.document.head) {
			throw new Error("popout document is not reachable synchronously");
		}

		win.__MYOBS = childBoot();
		win.__MYOBS_MODULES = {};
		/*
		 * Same name as the page-level API would be misleading: this object is
		 * the popout's *membership record*, and it is the only way the popout
		 * realm can name the page that hosts it.
		 */
		win.__MYOBS_POPOUT_WINDOW = {
			host: window,
			hostApi: api,
			at: frame.at,
			file: null,
			/** The popout is hosted by this page, not by a navigation. */
			hostedBy: "window.open(about:blank)"
		};

		var code = loadSourcesSync();
		for (var i = 0; i < code.length; i++) {
			// win.eval() runs the shim in the popout's realm, so every shim's
			// `window` / `document` is the popout's own.
			win.eval(code[i]);
		}
		frame.shims = code.length;
		frame.instrumented = true;
		record("instrumented", { shims: code.length });
	}

	/**
	 * The popout document is filled by Obsidian *after* window.open() returns,
	 * so the file it ends up showing is only knowable from the shared
	 * workspace. Poll briefly and record it: the acceptance harness and the
	 * user-facing notice both need a path, not a window handle.
	 *
	 * @param {{win: Window, file: string | null}} frame
	 */
	function trackFile(frame) {
		var win = frame.win;
		var deadline = Date.now() + FILE_TRACK_MS;

		function poll() {
			if (frame.file || !win || win.closed) return;
			var app = window.app;
			if (app && app.workspace && typeof app.workspace.iterateAllLeaves === "function") {
				var found = null;
				try {
					app.workspace.iterateAllLeaves(function (leaf) {
						if (found || !leaf || !leaf.containerEl || !leaf.view) return;
						if (leaf.containerEl.ownerDocument !== win.document) return;
						if (leaf.view.file && leaf.view.file.path) found = leaf.view.file.path;
					});
				} catch (err) {
					record("file-track-failed", { error: describeError(err) });
					return;
				}
				if (found) {
					frame.file = found;
					win.__MYOBS_POPOUT_WINDOW.file = found;
					record("file", { file: found });
					return;
				}
			}
			if (Date.now() < deadline) window.setTimeout(poll, FILE_POLL_MS);
		}

		window.setTimeout(poll, 0);
	}

	// ---------------------------------------------------------------------
	// window.open interception
	// ---------------------------------------------------------------------

	/**
	 * Obsidian's own shape only: about:blank plus a "popup" feature string.
	 * Everything else (plugins calling window.open, shell.openExternal ->
	 * window.open from electron-shim) is passed through untouched.
	 */
	function isPopoutRequest(url, features) {
		if (url !== "about:blank") return false;
		if (typeof features !== "string") return false;
		return /^popup([,;]|$)/.test(features);
	}

	/**
	 * Split Obsidian's feature string into host facts.
	 *
	 * The bundle builds it for Electron, where Obsidian's own main process
	 * parses it (`setWindowOpenHandler` -> overrideBrowserWindowOptions):
	 * `popup`, `parented=1`, `width`, `height`, `x`, `y` and `background`.
	 * Chromium cannot be handed that string: an unparsable feature makes
	 * window.open() return null in this build even with popups allowed
	 * (measured: `popup,background=#202020` -> null, `popup,width=700,height=500`
	 * -> Window). The translator below is the browser equivalent of that main
	 * process parser, not a convenience.
	 */
	function parseFeatures(features) {
		var parsed = {
			width: null,
			height: null,
			x: null,
			y: null,
			background: null,
			parented: false,
			ignored: []
		};
		String(features || "")
			.split(",")
			.forEach(function (token) {
				var text = token.trim();
				if (!text) return;
				var separator = text.indexOf("=");
				var key = (separator === -1 ? text : text.slice(0, separator)).toLowerCase().trim();
				var value = separator === -1 ? "" : text.slice(separator + 1).trim();
				if (key === "popup") return;
				if (key === "background") {
					parsed.background = value;
					return;
				}
				if (key === "parented") {
					parsed.parented = value === "1" || value === "true";
					return;
				}
				var number = Number(value);
				if (key === "width" && isFinite(number)) parsed.width = number;
				else if (key === "height" && isFinite(number)) parsed.height = number;
				else if ((key === "x" || key === "left") && isFinite(number)) parsed.x = number;
				else if ((key === "y" || key === "top") && isFinite(number)) parsed.y = number;
				else parsed.ignored.push(key);
			});
		return parsed;
	}

	/**
	 * @param {{width: number|null, height: number|null, x: number|null, y: number|null}} parsed
	 * @returns {string} a features string Chromium accepts
	 */
	function browserFeatures(parsed) {
		var width = parsed.width === null ? DEFAULT_POPOUT_WIDTH : parsed.width;
		var height = parsed.height === null ? DEFAULT_POPOUT_HEIGHT : parsed.height;
		var parts = ["popup", "width=" + Math.round(width), "height=" + Math.round(height)];
		if (parsed.x !== null && parsed.y !== null) {
			// The spec aliases x/y to left/top; emit the canonical spelling.
			parts.push("left=" + Math.round(parsed.x), "top=" + Math.round(parsed.y));
		}
		return parts.join(",");
	}

	/**
	 * `background=` is Obsidian asking the host to paint the new window before
	 * the web content is ready (its Electron main process passes it to
	 * BrowserWindow.backgroundColor). Browsers have no such knob, so stand in
	 * for it with a fixed overlay that is dropped once Obsidian's own container
	 * exists.
	 */
	function paintWindowBackground(win, color) {
		if (!color || !win.document || !win.document.body) return;
		var veil = win.document.createElement("div");
		veil.setAttribute("data-myobs-popout-background", color);
		veil.style.cssText =
			"position:fixed;inset:0;z-index:-1;pointer-events:none;background:" + color + ";";
		win.document.body.appendChild(veil);
		var deadline = Date.now() + 5000;
		(function clear() {
			if (!win || win.closed) return;
			var container = win.document.querySelector(".app-container");
			if (container || Date.now() > deadline) {
				veil.remove();
				return;
			}
			win.setTimeout(clear, 100);
		})();
	}

	function installOpenInterceptor() {
		var nativeOpen = window.open;
		if (typeof nativeOpen !== "function") return false;

		window.open = function (url, target, features) {
			if (!isPopoutRequest(url, features)) {
				return nativeOpen.apply(window, arguments);
			}

			var parsed = parseFeatures(features);
			var requested = browserFeatures(parsed);
			var win = nativeOpen.call(window, url, target, requested);
			if (!win) {
				/*
				 * Popup blocked. Obsidian throws "Unable to open a new window."
				 * (x3's constructor) and, on the workspace restore path, logs
				 * "Failed to restore popout window" — both without any user
				 * visible message. Surface it instead.
				 */
				api.blocked += 1;
				record("blocked", { features: String(features || ""), requested: requested });
				notifyBlocked();
				return null;
			}

			var frame = {
				at: Date.now(),
				features: String(features || ""),
				requested: requested,
				background: parsed.background,
				parented: parsed.parented,
				ignoredFeatures: parsed.ignored,
				win: win,
				file: null,
				instrumented: false,
				error: null
			};
			api.frames.push(frame);

			try {
				instrumentPopout(win, frame);
				paintWindowBackground(win, parsed.background);
			} catch (err) {
				frame.error = describeError(err);
				record("instrument-failed", { error: frame.error });
				notifyInstrumentFailed(frame.error);
			}
			trackFile(frame);
			return win;
		};

		api.installed = true;
		return true;
	}

	// ---------------------------------------------------------------------
	// Notice bar
	// ---------------------------------------------------------------------

	function button(label, onClick) {
		var el = document.createElement("button");
		el.type = "button";
		el.textContent = label;
		el.style.cssText =
			"font:500 12px/1 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;" +
			"color:#101012;background:#e8e8ea;border:0;border-radius:6px;padding:8px 12px;cursor:pointer;";
		el.addEventListener("click", function () {
			el.disabled = true;
			try {
				onClick();
			} finally {
				el.disabled = false;
			}
		});
		return el;
	}

	function ensureBanner() {
		if (banner && banner.root.isConnected) return banner;
		var root = document.createElement("div");
		root.id = "myobs-popout-notice";
		root.setAttribute("role", "status");
		root.style.cssText =
			"position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483646;" +
			"display:flex;gap:12px;align-items:center;max-width:min(720px,92vw);padding:12px 14px;" +
			"border:1px solid #3a3a40;border-radius:10px;background:#18181b;color:#e8e8ea;" +
			"box-shadow:0 18px 48px rgba(0,0,0,.5);" +
			"font:13px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;";
		var text = document.createElement("span");
		var actions = document.createElement("span");
		actions.style.cssText = "display:flex;gap:8px;margin-left:auto;flex:0 0 auto;";
		root.appendChild(text);
		root.appendChild(actions);
		document.body.appendChild(root);
		banner = { root: root, text: text, actions: actions };
		return banner;
	}

	/**
	 * @param {{text: string, actions?: Array<{label: string, run: () => void}>}} notice
	 */
	function showNotice(notice) {
		var ui = ensureBanner();
		ui.text.textContent = notice.text;
		ui.actions.textContent = "";
		var list = (notice.actions || []).concat([
			{
				label: "關閉",
				run: function () {
					hideNotice();
				}
			}
		]);
		for (var i = 0; i < list.length; i++) {
			ui.actions.appendChild(button(list[i].label, list[i].run));
		}
		return ui;
	}

	function hideNotice() {
		if (banner && banner.root.isConnected) banner.root.remove();
		banner = null;
	}

	function notifyBlocked() {
		showNotice({
			text:
				"瀏覽器阻擋了彈出視窗，Obsidian 的新視窗沒有開啟。請允許本站的彈出視窗後再試一次，" +
				"或按下方按鈕（需要你的點擊）重開目前筆記。",
			actions: [
				{
					label: "在新視窗開啟目前筆記",
					run: function () {
						retryOpen();
					}
				}
			]
		});
	}

	function notifyInstrumentFailed(error) {
		showNotice({
			text: "新視窗已開啟，但 shim 注入失敗，該視窗可能無法正常運作：" + error
		});
	}

	function retryOpen() {
		var path = api.request && api.request.path ? api.request.path : null;
		if (openInNewWindow(path)) {
			hideNotice();
			return true;
		}
		showNotice({ text: "仍無法開啟新視窗；請確認瀏覽器允許本站的彈出視窗。" });
		return false;
	}

	// ---------------------------------------------------------------------
	// Opening a specific note in a new window
	// ---------------------------------------------------------------------

	/**
	 * Obsidian's own path for "open this note in a new window"
	 * (workspace:open-in-new-window -> getLeaf("window") -> openPopoutLeaf).
	 * Must be called from a user gesture: the browser blocks window.open()
	 * otherwise and the caller gets the "blocked" notice.
	 *
	 * @param {string | null} [path] vault-relative path; the active file when omitted
	 * @returns {boolean}
	 */
	function openInNewWindow(path) {
		var app = window.app;
		if (!app || !app.workspace) return false;
		var target = path || ((app.workspace.getActiveFile ? app.workspace.getActiveFile() : null) || {}).path || "";
		if (!target) {
			showNotice({ text: "沒有可開啟的筆記（目前沒有作用中的檔案）。" });
			return false;
		}
		try {
			if (app.vault && app.vault.getAbstractFileByPath(target)) {
				var opened = app.workspace.openLinkText(target, "", "window");
				if (opened && typeof opened.catch === "function") {
					opened.catch(function (err) {
						record("open-failed", { file: target, error: describeError(err) });
					});
				}
				return true;
			}
			// Not resolvable as a vault file: move the active tab instead, which
			// is what "Move to new window" does.
			if (app.workspace.activeLeaf) {
				app.workspace.moveLeafToPopout(app.workspace.activeLeaf);
				return true;
			}
		} catch (err) {
			record("open-failed", { file: target, error: describeError(err) });
			showNotice({ text: "開啟新視窗失敗：" + describeError(err) });
			return false;
		}
		return false;
	}

	/**
	 * `#popout=<vault-relative path>` (or `?popout=`) asks for a popout. It
	 * cannot be honoured before a user gesture exists, so this renders the
	 * request as a clickable notice instead of silently doing nothing.
	 */
	function readRequest() {
		var sources = [
			{ source: "hash", query: String(window.location.hash || "").replace(/^#/, "") },
			{ source: "search", query: String(window.location.search || "").replace(/^\?/, "") }
		];
		for (var i = 0; i < sources.length; i++) {
			var value = null;
			try {
				value = new URLSearchParams(sources[i].query).get("popout");
			} catch (err) {
				value = null;
			}
			if (value) {
				return { source: sources[i].source, path: value.replace(/^\/+/, "") };
			}
		}
		return null;
	}

	function whenAppReady(callback) {
		if (window.app) {
			callback();
			return;
		}
		if (appWaiter) return;
		var deadline = Date.now() + APP_WAIT_MS;
		appWaiter = window.setInterval(function () {
			if (window.app || Date.now() > deadline) {
				window.clearInterval(appWaiter);
				appWaiter = null;
				if (window.app) callback();
			}
		}, APP_POLL_MS);
	}

	function presentRequest() {
		var request = readRequest();
		api.request = request;
		if (!request) return;
		whenAppReady(function () {
			showNotice({
				text: "URL 要求在「新視窗」開啟：" + request.path + "（彈出視窗需要你的點擊）",
				actions: [
					{
						label: "開啟",
						run: function () {
							retryOpen();
						}
					}
				]
			});
			record("request", { path: request.path, source: request.source });
		});
	}

	// ---------------------------------------------------------------------
	// Wiring
	// ---------------------------------------------------------------------

	(function prefetch() {
		if (typeof window.fetch !== "function") return;
		fetchSources().then(
			function (texts) {
				if (!sources) sources = texts;
			},
			function (err) {
				// Not fatal: the synchronous XHR path in loadSourcesSync() is the
				// fallback, and it is the path the acceptance harness exercises.
				record("prefetch-failed", { error: describeError(err) });
			}
		);
	})();

	installOpenInterceptor();
	presentRequest();
	window.addEventListener("hashchange", presentRequest);
})();
