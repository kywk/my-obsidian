/*
 * electron-shim.js — classic script.
 *
 * Implements the subset of Electron's renderer API that Obsidian 1.14.4
 * touches, with an emphasis on the synchronous boot IPC channels:
 *
 *   vault, file-url, version, policy, terms, resources, documents-dir
 *   trash, desktop-dir, is-quitting, is-closing, get-documents-path,
 *   vault-list, get-icon, frame, ...
 *
 * The `terms` value is NEVER hard-coded here. It comes from the server's
 * boot payload (__MYOBS.termsText) exactly as required by DESIGN.md §8.
 */
(function () {
	"use strict";

	var boot = window.__MYOBS || {};
	var modules = window.__MYOBS_MODULES || (window.__MYOBS_MODULES = {});

	var listeners = Object.create(null); // channel -> [{ fn, once }]
	var pendingReplies = Object.create(null); // channel -> { args }
	var warnedSyncChannels = Object.create(null);
	var lastMenu = null;
	var lastMenuItems = null;

	var ipcRenderer; // assigned below; used by the event factory

	function eventFor(channel) {
		return {
			channel: channel,
			sender: ipcRenderer,
			senderId: 0,
			frameId: 0,
			preventDefault: function () {},
			stopPropagation: function () {},
			stopImmediatePropagation: function () {}
		};
	}

	function listenerList(channel) {
		return listeners[channel] || (listeners[channel] = []);
	}

	function removeListener(channel, fn) {
		var list = listeners[channel];
		if (!list) return;
		if (typeof fn !== "function") {
			delete listeners[channel];
			return;
		}
		for (var i = 0; i < list.length; i++) {
			if (list[i].fn === fn) {
				list.splice(i, 1);
				break;
			}
		}
		if (list.length === 0) {
			delete listeners[channel];
		}
	}

	function addListener(channel, fn, once) {
		if (typeof fn !== "function") {
			throw new TypeError("ipcRenderer listener must be a function");
		}
		listenerList(channel).push({ fn: fn, once: !!once });

		// A reply can arrive before the caller registers its listener (for
		// example when a send is answered from a microtask). Replay it once.
		var pending = pendingReplies[channel];
		if (pending) {
			delete pendingReplies[channel];
			queueMicrotask(function () {
				emit(channel, pending.args);
			});
		}
		return ipcRenderer;
	}

	function emit(channel, args) {
		var list = listeners[channel];
		if (!list || list.length === 0) {
			pendingReplies[channel] = { args: args || [] };
			return;
		}
		var event = eventFor(channel);
		var snapshot = list.slice();
		for (var i = 0; i < snapshot.length; i++) {
			var entry = snapshot[i];
			if (entry.once) {
				removeListener(channel, entry.fn);
			}
			try {
				entry.fn.apply(null, [event].concat(args || []));
			} catch (err) {
				console.error("[my-obsidian] ipc listener for '" + channel + "' threw", err);
			}
		}
	}

	function base64ToBytes(value) {
		var binary = atob(value || "");
		var bytes = new Uint8Array(binary.length);
		for (var i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	}

	function bytesToBase64(bytes) {
		var chunks = [];
		var size = 0x8000;
		for (var i = 0; i < bytes.length; i += size) {
			chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + size)));
		}
		return btoa(chunks.join(""));
	}

	function utf8ToBase64(value) {
		return bytesToBase64(new TextEncoder().encode(String(value)));
	}

	function base64ToUtf8(value) {
		return new TextDecoder().decode(base64ToBytes(value));
	}

	function getFetch() {
		if (typeof window.fetch === "function") {
			return window.fetch.bind(window);
		}
		if (typeof fetch === "function") {
			return fetch;
		}
		return null;
	}

	function requestUrl(request) {
		request = request || {};
		var method = String(request.method || "GET").toUpperCase();
		var headers = {};
		if (request.headers && typeof request.headers === "object") {
			Object.keys(request.headers).forEach(function (key) {
				headers[key] = request.headers[key];
			});
		}
		if (request.contentType) {
			var hasContentType = Object.keys(headers).some(function (key) {
				return key.toLowerCase() === "content-type";
			});
			if (!hasContentType) headers["Content-Type"] = request.contentType;
		}

		var options = {
			method: method,
			headers: headers,
			credentials: request.credentials || "same-origin"
		};

		if (method !== "GET" && method !== "HEAD" && request.body != null) {
			if (request.binary && typeof request.body === "string") {
				options.body = base64ToBytes(request.body);
			} else {
				options.body = request.body;
			}
		}

		var fetchFn = getFetch();
		if (!fetchFn) {
			return Promise.reject(new Error("fetch is not available in this browser"));
		}

		// net-rewrite.js installs a rewrite for hosts that do not send CORS
		// headers (github.com and friends), routing them through the server's
		// /api/proxy. Looked up at call time so the seam can be filled by a
		// script that loads after this one, and so disabling it is immediate.
		var targetUrl = request.url;
		var rewrite = window.__MYOBS_REQUEST_REWRITE;
		if (typeof rewrite === "function") {
			var rewritten = rewrite(request.url);
			if (typeof rewritten === "string" && rewritten.length > 0) targetUrl = rewritten;
		}

		return fetchFn(targetUrl, options).then(function (response) {
			return response.arrayBuffer().then(function (buffer) {
				var responseHeaders = {};
				response.headers.forEach(function (value, key) {
					responseHeaders[key] = value;
				});
				// Obsidian's IPC consumer checks `if (n.body)`, then hands the
				// body to _S() which treats it as an ArrayBuffer. Keep that
				// exact shape.
				return {
					status: response.status,
					statusText: response.statusText,
					headers: responseHeaders,
					body: buffer
				};
			});
		});
	}

	function handleRequestUrl(replyChannel, request) {
		requestUrl(request).then(
			function (response) {
				emit(replyChannel, [response]);
			},
			function (err) {
				emit(replyChannel, [{ error: err instanceof Error ? err : new Error(String(err)) }]);
			}
		);
	}

	function reloadSoon() {
		if (typeof window.location !== "undefined" && typeof window.location.reload === "function") {
			window.setTimeout(function () {
				window.location.reload();
			}, 0);
		}
	}

	var SYNC_HANDLERS = {
		vault: function () {
			return {
				id: boot.vaultId || "",
				name: boot.vaultName || "",
				path: boot.vaultPath || ""
			};
		},
		"vault-list": function () {
			return [
				{
					id: boot.vaultId || "",
					name: boot.vaultName || "",
					path: boot.vaultPath || "",
					ts: Date.now()
				}
			];
		},
		"vault-open": function () {
			// Multi-vault switching is not part of this runtime. Returning
			// false makes Obsidian show its own "failed to open vault" error.
			return false;
		},
		"file-url": function () {
			// This channel feeds Platform.resourcePathPrefix, which
			// FileSystemAdapter#getResourcePath prepends to the vault-relative
			// path to build attachment URLs (CONTRACTS.md §1: resourcePrefix is
			// "for adapter.getResourcePath"). Returning resourcesPath here --
			// the app asset root -- produced URLs like
			// "/obsidianprivate/var/…/image.png", which the /obsidian/* static
			// route swallowed as a 404. Every attachment, PDF and media URL was
			// broken and /v/* was never reached (DESIGN.md §11.7).
			//
			// `resources` below genuinely means the app resource directory and
			// must keep returning resourcesPath.
			return boot.resourcePrefix || "/v/";
		},
		resources: function () {
			return boot.resourcesPath || "/obsidian";
		},
		version: function () {
			return boot.version || "0.0.0";
		},
		policy: function () {
			return boot.policy || {};
		},
		terms: function () {
			// Do not inline the license text. The server injects it only after
			// the operator has accepted. If it is absent, boot-data already
			// stopped the boot with a visible error.
			return boot.termsAccepted ? boot.termsText || "" : "";
		},
		"documents-dir": function () {
			return boot.documentsDir || "";
		},
		"get-documents-path": function () {
			return boot.documentsDir || "";
		},
		"desktop-dir": function () {
			return boot.desktopDir || "";
		},
		trash: function () {
			// Returning false makes FileSystemAdapter.trashSystem() fall back
			// to trashLocal(), which moves the entry into <vault>/.trash via
			// the /api/fs rename op. Returning true without deleting would
			// confuse its reconcile step.
			return false;
		},
		"is-quitting": function () {
			return false;
		},
		"is-closing": function () {
			return false;
		},
		"get-icon": function () {
			return null;
		},
		"set-icon": function () {
			return undefined;
		},
		frame: function () {
			// "native" keeps Obsidian from building a custom frameless title
			// bar (and from expecting traffic-light controls) in a browser tab.
			return "native";
		},
		update: function () {
			return "update-manual-required";
		},
		"check-update": function () {
			return false;
		},
		"latest-public-version": function () {
			return boot.version || "0.0.0";
		},
		"insider-build": function () {
			return false;
		},
		"disable-gpu": function () {
			return false;
		},
		"adblock-lists": function () {
			return [];
		},
		"adblock-frequency": function () {
			return 0;
		},
		cli: function () {
			return false;
		},
		"copy-asar": function () {
			return false;
		},
		"get-sandbox-vault-path": function () {
			return "";
		},
		sandbox: function () {
			return null;
		},
		"set-language": function () {
			return undefined;
		},
		starter: function () {
			return undefined;
		},
		help: function () {
			return undefined;
		},
		relaunch: function () {
			reloadSoon();
			return true;
		}
	};

	function sendSync(channel) {
		var args = Array.prototype.slice.call(arguments, 1);
		var handler = SYNC_HANDLERS[channel];
		if (handler) {
			return handler.apply(null, args);
		}
		if (!warnedSyncChannels[channel]) {
			warnedSyncChannels[channel] = true;
			console.warn(
				"[my-obsidian] unhandled synchronous IPC channel: " + channel +
				" (returning undefined)"
			);
		}
		return undefined;
	}

	var warnedMenuHost = false;

	function callMenuHost(method, args) {
		var host = window.__MYOBS_MENU;
		if (!host || typeof host[method] !== "function") {
			if (!warnedMenuHost) {
				warnedMenuHost = true;
				console.warn("[my-obsidian] menu renderer is not installed; menu IPC is dropped");
			}
			return;
		}
		try {
			host[method].apply(host, args || []);
		} catch (err) {
			console.error("[my-obsidian] menu renderer " + method + " threw", err);
		}
	}

	/*
	 * print.js is not loaded into popout realms (popout.js only injects the
	 * /shim/* scripts), but Obsidian's Export to PDF sends print-to-pdf from
	 * the throwaway window it opens. Resolve the printer in this order:
	 *
	 *   1. this realm's own print module (normal page);
	 *   2. the page that hosts this popout (window.__MYOBS_POPOUT_WINDOW.host).
	 *
	 * The reply always comes back through *this* realm's ipcRenderer because
	 * that is where the caller registered its once("print-to-pdf") listener.
	 */
	function printHost() {
		var realm = window;
		try {
			// A popout may itself host the throwaway PDF window; walking the
			// membership chain reaches the page that actually loaded print.js.
			for (var depth = 0; depth < 4; depth++) {
				var printer = realm.__MYOBS_PRINT;
				if (printer && typeof printer.handleIpc === "function") return printer;
				var membership = realm.__MYOBS_POPOUT_WINDOW;
				var host = membership && membership.host;
				if (!host || host === realm) break;
				realm = host;
			}
		} catch (err) {
			console.warn("[my-obsidian] could not resolve the print host", err);
		}
		return null;
	}

	function printFailure(payload, error) {
		return {
			ok: false,
			reason: "print-unavailable",
			printed: false,
			fileWritten: false,
			filepath:
				payload && payload.filepath != null ? String(payload.filepath) : null,
			error: error
				? {
					code: "PRINT_FAILED",
					message: String(error && error.message ? error.message : error)
				}
				: {
					code: "PRINT_UNAVAILABLE",
					message:
						"瀏覽器列印模組未載入，無法列印。請確認 /runtime/print.js 已載入後重新載入頁面。"
				}
		};
	}

	function printViaHost(payload) {
		var host = printHost();
		if (!host) return printFailure(payload);
		try {
			if (typeof host.handleIpc === "function") {
				return host.handleIpc(payload || {});
			}
			if (typeof host.printActiveNote === "function") {
				var result = host.printActiveNote(payload || {});
				return {
					ok: Boolean(result && result.ok),
					reason: (result && result.reason) || "browser-print-dialog",
					printed: Boolean(result && result.printed),
					fileWritten: false,
					filepath:
						payload && payload.filepath != null ? String(payload.filepath) : null,
					path: result && result.path ? result.path : null,
					error: result && result.error ? result.error : undefined
				};
			}
		} catch (err) {
			console.error("[my-obsidian] print-to-pdf failed", err);
			return printFailure(payload, err);
		}
		return printFailure(payload);
	}

	function answerPrintToPdf(payload, reply) {
		// Always asynchronous: printActiveNote() calls window.print(), which
		// blocks in a real browser, and callers register their once() listener
		// right after send() returns.
		queueMicrotask(function () {
			reply(printViaHost(payload));
		});
	}

	function send(channel) {
		var args = Array.prototype.slice.call(arguments, 1);

		switch (channel) {
			case "request-url":
				handleRequestUrl(args[0], args[1]);
				return;
			case "print-to-pdf": {
				// Electron answers with a PDF buffer (or writes filepath). The
				// browser cannot, so print.js takes over and replies with the
				// explicit, honest result shape. The reply is emitted in this
				// realm because that is where the once() listener lives; when
				// this is a popout, the work happens in the hosting page.
				var payload = args[0] || null;
				answerPrintToPdf(payload, function (result) {
					emit("print-to-pdf", [result]);
				});
				return;
			}
			case "context-menu":
				// Request/reply channel: Obsidian asks the host for editFlags
				// before it draws the editor context menu, and abandons the menu
				// entirely when the reply is falsy (app.js @ 2593104). menu.js
				// computes the flags from the live selection; the fallback keeps
				// the channel usable in realms where menu.js is absent (popouts).
				queueMicrotask(function () {
					var reply = null;
					try {
						var host = window.__MYOBS_MENU;
						if (host && typeof host.buildContextReply === "function") {
							reply = host.buildContextReply();
						}
					} catch (err) {
						console.warn("[my-obsidian] context-menu flags failed", err);
					}
					emit("context-menu", [
						reply || {
							editFlags: {
								canUndo: false,
								canRedo: false,
								canCut: false,
								canCopy: true,
								canPaste: true,
								canDelete: false,
								canSelectAll: true,
								canEditRichly: false
							},
							misspelledWord: "",
							dictionarySuggestions: [],
							webContentsId: 1
						}
					]);
				});
				return;
			case "set-menu":
				// These three channels are renderer -> main in Electron; there is
				// no echo back to the renderer, so listening for them with
				// ipcRenderer.on() would never fire. The host renderer is called
				// directly instead (the menu bar is ours to draw).
				lastMenu = args[0] || null;
				callMenuHost("setTemplate", [(args[0] && args[0].template) || []]);
				return;
			case "render-menu":
				lastMenu = args[0] || null;
				lastMenuItems = args[1] || null;
				callMenuHost("renderMenuAtCursor", []);
				return;
			case "update-menu-items":
				lastMenuItems = args[0] || null;
				callMenuHost("updateMenuItems", [args[0] || []]);
				return;
			case "open-url":
				openExternal(args[0]);
				return;
			case "open-file":
				console.warn("[my-obsidian] open-file is not supported in the browser runtime:", args[0]);
				return;
			case "relaunch":
				reloadSoon();
				return;
			case "create-browser-session":
			case "insider-build":
			case "check-update":
				return;
			default:
				// Record for diagnostics; there is no main process to answer.
				console.debug("[my-obsidian] ipcRenderer.send('" + channel + "')", args);
				return;
		}
	}

	function invoke(channel) {
		var args = Array.prototype.slice.call(arguments, 1);
		switch (channel) {
			case "request-url":
				return requestUrl(args[0]);
			case "print-to-pdf":
				return Promise.resolve().then(function () {
					return printViaHost(args[0] || null);
				});
			case "register-cli":
				return Promise.resolve(false);
			default:
				return Promise.resolve(undefined);
		}
	}

	ipcRenderer = {
		sendSync: sendSync,
		send: send,
		invoke: invoke,
		on: function (channel, fn) {
			return addListener(channel, fn, false);
		},
		once: function (channel, fn) {
			return addListener(channel, fn, true);
		},
		off: function (channel, fn) {
			removeListener(channel, fn);
			return ipcRenderer;
		},
		removeListener: function (channel, fn) {
			removeListener(channel, fn);
			return ipcRenderer;
		},
		removeAllListeners: function (channel) {
			if (arguments.length === 0) {
				listeners = Object.create(null);
				pendingReplies = Object.create(null);
			} else {
				delete listeners[channel];
				delete pendingReplies[channel];
			}
			return ipcRenderer;
		},
		listenerCount: function (channel) {
			return (listeners[channel] || []).length;
		}
	};

	// ---------------------------------------------------------------------
	// webFrame — CSS zoom is a close approximation of Electron's zoom level.
	// ---------------------------------------------------------------------

	function currentZoomFactor() {
		var raw = document.documentElement && document.documentElement.style
			? document.documentElement.style.zoom
			: "";
		var value = parseFloat(raw);
		return isFinite(value) && value > 0 ? value : 1;
	}

	var webFrame = {
		getZoomLevel: function () {
			var level = Math.log(currentZoomFactor()) / Math.log(1.2);
			// Avoid returning 5.551e-17 for a zoom factor of 1.
			return Math.round(level * 1000) / 1000;
		},
		setZoomLevel: function (level) {
			var numeric = Number(level);
			if (!isFinite(numeric)) numeric = 0;
			if (document.documentElement) {
				document.documentElement.style.zoom = String(Math.pow(1.2, numeric));
			}
		},
		getZoomFactor: currentZoomFactor,
		setZoomFactor: function (factor) {
			var numeric = Number(factor);
			if (!isFinite(numeric) || numeric <= 0) numeric = 1;
			if (document.documentElement) {
				document.documentElement.style.zoom = String(numeric);
			}
		},
		setVisualZoomLevelLimits: function () {
			return Promise.resolve();
		},
		setSpellCheckerEnabled: function () {},
		insertCSS: function () {
			return Promise.resolve("");
		},
		removeInsertedCSS: function () {
			return Promise.resolve();
		},
		executeJavaScript: function () {
			return Promise.resolve(undefined);
		}
	};

	// ---------------------------------------------------------------------
	// remote.* stubs
	// ---------------------------------------------------------------------

	function pathModule() {
		return window.__MYOBS_MODULES && window.__MYOBS_MODULES.path;
	}

	function joinPath() {
		var path = pathModule();
		if (path) {
			return path.join.apply(path, arguments);
		}
		return Array.prototype.slice.call(arguments).join("/").replace(/\/+/g, "/");
	}

	function parentPath(value) {
		var text = String(value || "");
		var index = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
		if (index <= 0) return text.charAt(0) === "/" ? "/" : ".";
		return text.slice(0, index);
	}

	function osModule() {
		return window.__MYOBS_MODULES && window.__MYOBS_MODULES.os;
	}

	function makeLanguageList() {
		var list = [navigator.language || "en"];
		list.first = function () {
			return this[0];
		};
		// Obsidian patches Array.prototype.contains, but adding it here keeps
		// the spellchecker path safe in popout windows that load shims first.
		if (typeof list.contains !== "function") {
			list.contains = function (value) {
				return this.indexOf(value) !== -1;
			};
		}
		return list;
	}

	var appStub = {
		getVersion: function () {
			return boot.build || boot.version || "0.0.0";
		},
		getName: function () {
			return "Obsidian";
		},
		getLocale: function () {
			return navigator.language || "en";
		},
		getSystemLocale: function () {
			return navigator.language || "en";
		},
		getPreferredSystemLanguages: makeLanguageList,
		getAppPath: function () {
			return boot.resourcesPath || "/obsidian";
		},
		isPackaged: true,
		getPath: function (name) {
			var documents = boot.documentsDir || "/";
			var home = parentPath(documents);
			switch (name) {
				case "home":
					return home;
				case "documents":
					return boot.documentsDir || joinPath(home, "Documents");
				case "desktop":
					return boot.desktopDir || joinPath(home, "Desktop");
				case "downloads":
					return joinPath(home, "Downloads");
				case "pictures":
					return joinPath(home, "Pictures");
				case "music":
					return joinPath(home, "Music");
				case "videos":
					return joinPath(home, "Videos");
				case "temp": {
					var os = osModule();
					return os && typeof os.tmpdir === "function" ? os.tmpdir() : "/tmp";
				}
				case "userData":
					// Keep application data inside the vault so the fs shim can
					// serve it. This is only used by optional features such as
					// the custom vault icon.
					return joinPath(boot.vaultPath || "/", ".obsidian", "myobs-userdata");
				case "appData":
					return joinPath(home, ".config");
				case "logs":
					return joinPath(boot.vaultPath || "/", ".obsidian", "myobs-userdata", "logs");
				default:
					return joinPath(home, name);
			}
		},
		quit: function () {},
		exit: function () {},
		relaunch: reloadSoon,
		showAboutPanel: function () {}
	};

	var safeStorage = {
		isEncryptionAvailable: function () {
			return false;
		},
		getSelectedStorageBackend: function () {
			return "basic_text";
		},
		// No OS keychain exists in the browser. Keep a reversible base64
		// envelope so callers that ignore isEncryptionAvailable() still work.
		encryptString: function (value) {
			return utf8ToBase64(value == null ? "" : String(value));
		},
		decryptString: function (value) {
			if (typeof value === "string") {
				try {
					return base64ToUtf8(value);
				} catch (err) {
					return value;
				}
			}
			if (value instanceof ArrayBuffer) {
				return new TextDecoder().decode(new Uint8Array(value));
			}
			if (ArrayBuffer.isView(value)) {
				return new TextDecoder().decode(value);
			}
			return String(value == null ? "" : value);
		}
	};

	var nativeTheme = {
		get shouldUseDarkColors() {
			return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
		},
		get shouldUseHighContrastColors() {
			return false;
		},
		get themeSource() {
			return "system";
		},
		set themeSource(_value) {
			/* no-op: the browser follows the OS media query */
		},
		on: function () {
			return nativeTheme;
		},
		addListener: function () {
			return nativeTheme;
		},
		once: function () {
			return nativeTheme;
		},
		off: function () {
			return nativeTheme;
		},
		removeListener: function () {
			return nativeTheme;
		},
		removeAllListeners: function () {
			return nativeTheme;
		}
	};

	function makeNativeImage() {
		return {
			isEmpty: function () {
				return true;
			},
			getSize: function () {
				return { width: 0, height: 0 };
			},
			toPNG: function () {
				return new Uint8Array(0);
			},
			toJPEG: function () {
				return new Uint8Array(0);
			},
			toDataURL: function () {
				return "";
			},
			resize: function () {
				return this;
			},
			crop: function () {
				return this;
			}
		};
	}

	// Electron's Menu is the renderer's *native* menu path: on macOS the Menu
	// class defaults to useNativeMenu = true and every context menu becomes
	// Menu.buildFromTemplate(items).popup({x,y}) (app.js @ 1226079 picks the
	// native branch, the popup call is at 1227604). The shim
	// used to drop that call, which is why right-click menus did not exist.
	// menu.js renders the same template as DOM and fires "menu-will-close"
	// because the caller uses that event to reset its own menu state.
	function makeMenu(template) {
		var handlers = Object.create(null);
		var menu;

		function fire(name) {
			var list = handlers[name] || [];
			for (var i = 0; i < list.slice().length; i++) {
				try {
					list[i]();
				} catch (err) {
					console.error("[my-obsidian] Menu '" + name + "' handler threw", err);
				}
			}
		}

		menu = {
			items: template || [],
			popup: function (options) {
				var host = window.__MYOBS_MENU;
				if (!host || typeof host.popupTemplate !== "function") {
					console.warn("[my-obsidian] Menu.popup() has no renderer (menu.js missing)");
					return;
				}
				host.popupTemplate(template || [], options || {}, function () {
					fire("menu-will-close");
				});
			},
			closePopup: function () {
				var host = window.__MYOBS_MENU;
				if (host && typeof host.close === "function") host.close();
			},
			append: function () {},
			insert: function () {},
			destroy: function () {},
			on: function (name, fn) {
				if (typeof fn === "function") (handlers[name] || (handlers[name] = [])).push(fn);
				return menu;
			},
			once: function (name, fn) {
				if (typeof fn !== "function") return menu;
				function wrapped() {
					menu.removeListener(name, wrapped);
					fn();
				}
				return menu.on(name, wrapped);
			},
			removeListener: function (name, fn) {
				var list = handlers[name];
				if (!list) return menu;
				var index = list.indexOf(fn);
				if (index !== -1) list.splice(index, 1);
				return menu;
			},
			removeAllListeners: function (name) {
				if (name) delete handlers[name];
				else handlers = Object.create(null);
				return menu;
			}
		};
		return menu;
	}

	var menuModule = {
		buildFromTemplate: makeMenu,
		setApplicationMenu: function () {},
		getApplicationMenu: function () {
			return null;
		}
	};

	function MenuItemStub(options) {
		this.options = options || {};
	}

	var shellStub = {
		openExternal: function (url) {
			if (typeof url !== "string") return Promise.resolve();
			if (/^(https?:|mailto:)/i.test(url)) {
				window.open(url, "_blank", "noopener,noreferrer");
			} else {
				console.warn("[my-obsidian] shell.openExternal blocked for scheme:", url.split(":")[0]);
			}
			return Promise.resolve();
		},
		openPath: function () {
			return Promise.resolve("");
		},
		showItemInFolder: function () {},
		beep: function () {},
		trashItem: function () {
			return Promise.resolve();
		}
	};

	var clipboardStub = {
		readText: function () {
			return navigator.clipboard ? navigator.clipboard.readText() : Promise.resolve("");
		},
		writeText: function (value) {
			return navigator.clipboard ? navigator.clipboard.writeText(value) : Promise.resolve();
		},
		readImage: function () {
			return makeNativeImage();
		},
		writeImage: function () {},
		availableFormats: function () {
			return [];
		},
		has: function () {
			return false;
		}
	};

	// ---------------------------------------------------------------------
	// remote.dialog
	//
	// A browser tab has no native dialog host, so every API below either maps
	// onto a browser primitive or reports honestly that the operation cannot
	// be performed. The one that matters for Obsidian's own Export to PDF is
	// showSaveDialog: File System Access gives us a real, writable handle when
	// the browser supports it and the call happens inside a user gesture.
	//
	// `filePath` in that case is only the handle's name, not an absolute path:
	// the File System Access API deliberately hides the directory. When the
	// picker is unavailable (Firefox, Safari, a non-gesture call, or a headless
	// harness) the export chain is kept alive with a synthetic marker path;
	// the actual artifact is produced by the browser's print dialog, never by
	// this shim. Both paths report the same Electron-shaped result:
	//   { canceled, filePath, filePaths }
	// ---------------------------------------------------------------------

	var SYNTHETIC_SAVE_PATH = "<browser-print-dialog>";
	var MIME_BY_EXTENSION = {
		pdf: "application/pdf",
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		webp: "image/webp",
		svg: "image/svg+xml",
		ico: "image/x-icon",
		icns: "image/icns",
		txt: "text/plain",
		md: "text/markdown",
		markdown: "text/markdown",
		json: "application/json",
		html: "text/html",
		css: "text/css",
		js: "text/javascript",
		csv: "text/csv"
	};
	var dialogCalls = [];
	var dialogState = {
		installed: true,
		calls: dialogCalls,
		lastResult: null,
		/** "file-system-access" | "synthetic" | "canceled" for the last save dialog. */
		lastSaveSource: null,
		syntheticPath: SYNTHETIC_SAVE_PATH
	};
	var warnedOpenDialog = false;
	var warnedSaveDialog = false;

	function baseName(value) {
		var text = String(value == null ? "" : value);
		var index = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
		return index === -1 ? text : text.slice(index + 1);
	}

	/*
	 * Only a PDF save request has a browser landing path: the print dialog.
	 * For anything else (Canvas -> Export image, plugin JSON exports) a
	 * synthetic path would make the caller write a *relative* name, which the
	 * fs shim resolves under the vault root. Returning canceled is the honest
	 * answer there; returning success would silently put the file in the wrong
	 * place or fail later with a confusing ENOENT.
	 */
	function wantsPdfSave(options) {
		var opts = options || {};
		if (/\.pdf$/i.test(baseName(opts.defaultPath))) return true;
		if (!Array.isArray(opts.filters)) return false;
		for (var i = 0; i < opts.filters.length; i++) {
			var filter = opts.filters[i];
			if (!filter || !Array.isArray(filter.extensions)) continue;
			for (var j = 0; j < filter.extensions.length; j++) {
				if (String(filter.extensions[j] == null ? "" : filter.extensions[j]).toLowerCase() === "pdf") {
					return true;
				}
			}
		}
		return false;
	}

	function dialogMessage(options) {
		var opts = options || {};
		var parts = [];
		if (opts.title) parts.push(String(opts.title));
		if (opts.message) parts.push(String(opts.message));
		if (opts.detail) parts.push(String(opts.detail));
		return parts.join("\n\n") || "Obsidian";
	}

	function filePickerTypes(filters) {
		if (!Array.isArray(filters)) return undefined;
		var seenExtensions = Object.create(null);
		var types = [];
		for (var i = 0; i < filters.length; i++) {
			var filter = filters[i];
			if (!filter || !Array.isArray(filter.extensions)) continue;
			var accept = {};
			for (var j = 0; j < filter.extensions.length; j++) {
				var extension = String(filter.extensions[j] == null ? "" : filter.extensions[j])
					.trim()
					.replace(/^\./, "")
					.toLowerCase();
				// "*" (Electron's "All Files") has no File System Access
				// equivalent; omitting it leaves the picker unrestricted. Keep
				// only simple extensions: Chrome rejects some multi-dot or
				// over-long shapes, and one bad entry fails the whole picker.
				if (!extension || extension === "*" || !/^[a-z0-9]{1,16}$/.test(extension)) continue;
				if (seenExtensions[extension]) continue;
				seenExtensions[extension] = true;
				var mime = MIME_BY_EXTENSION[extension] || "application/octet-stream";
				if (!accept[mime]) accept[mime] = [];
				accept[mime].push("." + extension);
			}
			var keys = Object.keys(accept);
			if (keys.length === 0) continue;
			types.push({
				description: String(filter.name || "Files"),
				accept: accept
			});
		}
		return types.length > 0 ? types : undefined;
	}

	function summarizeDialogOptions(options) {
		var opts = options || {};
		var summary = {};
		if (opts.title != null) summary.title = String(opts.title);
		if (opts.defaultPath != null) summary.defaultPath = String(opts.defaultPath);
		if (opts.message != null) summary.message = String(opts.message);
		if (opts.detail != null) summary.detail = String(opts.detail);
		if (Array.isArray(opts.buttons)) summary.buttons = opts.buttons.map(String);
		if (Array.isArray(opts.properties)) summary.properties = opts.properties.map(String);
		if (Array.isArray(opts.filters)) {
			summary.filters = opts.filters.map(function (filter) {
				return {
					name: filter && filter.name != null ? String(filter.name) : "",
					extensions:
						filter && Array.isArray(filter.extensions)
							? filter.extensions.map(String)
							: []
				};
			});
		}
		if (opts.checkboxLabel != null) summary.checkboxLabel = String(opts.checkboxLabel);
		if (opts.checkboxChecked != null) summary.checkboxChecked = opts.checkboxChecked === true;
		return summary;
	}

	function recordDialogCall(method, options, result) {
		var entry = {
			at: Date.now(),
			method: method,
			options: summarizeDialogOptions(options),
			result: result
		};
		dialogCalls.push(entry);
		if (dialogCalls.length > 50) dialogCalls.shift();
		dialogState.lastResult = result;
		return entry;
	}

	function saveResult(filePath, source) {
		var result = {
			canceled: false,
			filePath: filePath,
			filePaths: [filePath]
		};
		dialogState.lastSaveSource = source;
		return result;
	}

	function canceledSaveResult() {
		dialogState.lastSaveSource = "canceled";
		return { canceled: true, filePath: undefined, filePaths: [] };
	}

	function handlePickerFailure(err) {
		// AbortError is the user pressing Cancel in the picker: that is a real
		// cancellation, not an unavailable API. Anything else (SecurityError
		// without a user gesture, an unsupported options shape, a headless
		// browser with no picker UI) means this realm cannot present the
		// picker; fall back to the marker so the caller's export chain still
		// reaches the browser print dialog.
		if (err && err.name === "AbortError") return canceledSaveResult();
		console.info(
			"[my-obsidian] showSaveFilePicker is unavailable here (" +
				(err && (err.name || err.message) ? err.name || err.message : String(err)) +
				"); returning the synthetic print-dialog path instead."
		);
		return saveResult(SYNTHETIC_SAVE_PATH, "synthetic");
	}

	function showSaveDialog(options) {
		var opts = options || {};
		var suggestedName = baseName(opts.defaultPath) || "obsidian-export";
		if (!wantsPdfSave(opts)) {
			if (!warnedSaveDialog) {
				warnedSaveDialog = true;
				console.info(
					"[my-obsidian] remote.dialog.showSaveDialog only continues for PDF exports: " +
						"the browser print dialog is the only place a file can be written. " +
						"Returning { canceled:true } for this save request."
				);
			}
			var canceled = canceledSaveResult();
			recordDialogCall("showSaveDialog", opts, canceled);
			return Promise.resolve(canceled);
		}
		var picker = null;
		try {
			if (typeof window.showSaveFilePicker === "function") {
				picker = window.showSaveFilePicker;
			}
		} catch (err) {
			picker = null;
		}

		if (!picker) {
			var synthetic = saveResult(SYNTHETIC_SAVE_PATH, "synthetic");
			recordDialogCall("showSaveDialog", opts, synthetic);
			return Promise.resolve(synthetic);
		}

		var pickerOptions = { suggestedName: suggestedName };
		var types = filePickerTypes(opts.filters);
		if (types) pickerOptions.types = types;

		var pending;
		try {
			// Called synchronously from the caller's task so the browser still
			// sees the user gesture. Deferring this into a .then() would turn a
			// real picker into a SecurityError in some browsers.
			pending = picker.call(window, pickerOptions);
		} catch (err) {
			var failed = handlePickerFailure(err);
			recordDialogCall("showSaveDialog", opts, failed);
			return Promise.resolve(failed);
		}

		return Promise.resolve(pending).then(
			function (handle) {
				var name = handle && handle.name ? String(handle.name) : suggestedName;
				var result = saveResult(name, "file-system-access");
				recordDialogCall("showSaveDialog", opts, result);
				return result;
			},
			function (err) {
				var result = handlePickerFailure(err);
				recordDialogCall("showSaveDialog", opts, result);
				return result;
			}
		);
	}

	function showOpenDialog(options, method) {
		if (!warnedOpenDialog) {
			warnedOpenDialog = true;
			console.info(
				"[my-obsidian] remote.dialog.showOpenDialog is not available: this runtime only " +
					"has the vault, not the host filesystem. Returning { canceled:true, filePaths:[] }. " +
					"Use the vault's own file picker or drag-and-drop instead."
			);
		}
		var result = { canceled: true, filePaths: [] };
		recordDialogCall(method || "showOpenDialog", options, result);
		return Promise.resolve(result);
	}

	function buttonIndex(options, candidate, names) {
		var buttons = Array.isArray(options.buttons) ? options.buttons : [];
		if (typeof candidate === "number" && candidate >= 0 && candidate < buttons.length) {
			return candidate;
		}
		for (var i = 0; i < buttons.length; i++) {
			var label = String(buttons[i] == null ? "" : buttons[i]).trim();
			if (names.test(label)) return i;
		}
		return 0;
	}

	function messageBoxResult(options) {
		var opts = options || {};
		var buttons = Array.isArray(opts.buttons) && opts.buttons.length > 0
			? opts.buttons.map(String)
			: ["OK"];
		var text = dialogMessage(opts);
		var response;
		try {
			if (buttons.length <= 1) {
				window.alert(text);
				response = 0;
			} else if (buttons.length === 2) {
				response = window.confirm(text)
					? buttonIndex(opts, opts.defaultId, /^(ok|yes|accept|save|delete|export)$/i)
					: buttonIndex(opts, opts.cancelId, /^(cancel|no)$/i);
			} else {
				// confirm() cannot express three or more choices; prompt() can at
				// least preserve the index mapping (and returns null on cancel).
				var lines = buttons.map(function (label, index) {
					return index + 1 + ". " + label;
				});
				var answer = window.prompt(
					text + "\n\n" + lines.join("\n") + "\n\nEnter 1-" + buttons.length + ":",
					String(buttonIndex(opts, opts.defaultId, /^(ok|yes|accept)$/i) + 1)
				);
				var picked = answer == null ? NaN : parseInt(answer, 10);
				response =
					isFinite(picked) && picked >= 1 && picked <= buttons.length
						? picked - 1
						: buttonIndex(opts, opts.cancelId, /^(cancel|no)$/i);
			}
		} catch (err) {
			// A sandboxed realm may refuse confirm/prompt. Never leave the
			// caller hanging: report the default/cancel choice instead.
			response = buttonIndex(opts, opts.cancelId, /^(cancel|no)$/i);
		}
		return {
			response: response,
			checkboxChecked: opts.checkboxLabel != null ? opts.checkboxChecked === true : false
		};
	}

	var dialogStub = {
		showOpenDialogSync: function (options) {
			showOpenDialog(options, "showOpenDialogSync");
			// Electron's sync variant returns string[] | undefined, not an object.
			return undefined;
		},
		showOpenDialog: showOpenDialog,
		showSaveDialogSync: function (options) {
			// There is no synchronous way to present showSaveFilePicker. Keep
			// Electron's sync return contract (string | undefined): the PDF
			// case gets the same marker the async path uses; other save
			// requests are canceled so callers do not write a relative name
			// into the vault root.
			if (!wantsPdfSave(options)) {
				var canceled = canceledSaveResult();
				recordDialogCall("showSaveDialogSync", options, canceled);
				return undefined;
			}
			var result = saveResult(SYNTHETIC_SAVE_PATH, "synthetic");
			recordDialogCall("showSaveDialogSync", options, result);
			return result.filePath;
		},
		showSaveDialog: showSaveDialog,
		showMessageBoxSync: function (options) {
			var result = messageBoxResult(options);
			recordDialogCall("showMessageBoxSync", options, result);
			return result.response;
		},
		showMessageBox: function (options) {
			var result = messageBoxResult(options);
			recordDialogCall("showMessageBox", options, result);
			return Promise.resolve(result);
		},
		showErrorBox: function (title, content) {
			var text = dialogMessage({ title: title, message: content });
			try {
				window.alert(text);
			} catch (err) {
				/* alert is blocked in some sandboxed realms */
			}
			console.error("[my-obsidian] " + title + ": " + content);
		}
	};

	window.__MYOBS_DIALOG = dialogState;

	function makeSession() {
		var languages = makeLanguageList();
		return {
			availableSpellCheckerLanguages: languages,
			setSpellCheckerLanguages: function () {},
			setSpellCheckerEnabled: function () {},
			getSpellCheckerLanguages: function () {
				return languages.slice();
			},
			// The editor menu's "Add to dictionary" calls these; a browser has
			// no OS spelling dictionary, so accept and move on.
			addWordToSpellCheckerDictionary: function () {
				return true;
			},
			removeWordFromSpellCheckerDictionary: function () {
				return true;
			},
			cookies: {
				get: function () {
					return Promise.resolve([]);
				},
				set: function () {
					return Promise.resolve();
				}
			}
		};
	}

	function makeDebugger() {
		return {
			attach: function () {},
			detach: function () {},
			isAttached: function () {
				return false;
			},
			sendCommand: function (_method, _params, callback) {
				if (typeof callback === "function") callback(null, {});
				return Promise.resolve({});
			},
			on: function () {
				return this;
			},
			once: function () {
				return this;
			},
			removeListener: function () {
				return this;
			}
		};
	}

	var webContentsStub = null;

	function copySelection() {
		try {
			if (document.execCommand && document.execCommand("copy")) return;
		} catch (err) {
			/* execCommand refuses outside a user gesture */
		}
		var text = "";
		try {
			text = String(window.getSelection() || "");
		} catch (err) {
			text = "";
		}
		if (text && navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(text).catch(function () {});
		}
	}

	// A browser cannot replay a native paste. Read the clipboard (same-origin
	// localhost is a secure context) and deliver it as a paste event so
	// CodeMirror's own paste handler inserts it; execCommand is the fallback.
	function pasteIntoFocused() {
		if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") return;
		navigator.clipboard.readText().then(
			function (text) {
				if (!text) return;
				var target = document.activeElement || document.body;
				var delivered = false;
				try {
					var data = new DataTransfer();
					data.setData("text/plain", text);
					var event = new ClipboardEvent("paste", {
						clipboardData: data,
						bubbles: true,
						cancelable: true
					});
					target.dispatchEvent(event);
					delivered = event.defaultPrevented;
				} catch (err) {
					delivered = false;
				}
				if (!delivered) {
					try {
						document.execCommand("insertText", false, text);
					} catch (err) {
						/* nothing editable is focused */
					}
				}
			},
			function (err) {
				console.warn("[my-obsidian] clipboard read failed", err);
			}
		);
	}

	function makeWebContents() {
		if (webContentsStub) return webContentsStub;
		var session = makeSession();
		webContentsStub = {
			id: 1,
			// Obsidian serializes the popout zoom as `webContents.zoomLevel` and
			// restores it with setFrameZoomLevel(); a hard-coded 0 would reset
			// every restored popout to 100%.
			get zoomLevel() {
				return webFrame.getZoomLevel();
			},
			set zoomLevel(level) {
				webFrame.setZoomLevel(level);
			},
			session: session,
			debugger: makeDebugger(),
			getZoomLevel: function () {
				return webFrame.getZoomLevel();
			},
			setZoomLevel: function (level) {
				webFrame.setZoomLevel(level);
			},
			getZoomFactor: function () {
				return webFrame.getZoomFactor();
			},
			setZoomFactor: function (factor) {
				webFrame.setZoomFactor(factor);
			},
			capturePage: function () {
				return Promise.resolve(makeNativeImage());
			},
			// The editor context menu acts through these (app.js @ 2593192 runs
			// the whole clipboard section on `webContents.fromId(...)`).
			cut: function () {
				try {
					if (document.execCommand && document.execCommand("cut")) return;
				} catch (err) {
					/* fall through */
				}
				copySelection();
				document.execCommand && document.execCommand("delete");
			},
			copy: copySelection,
			paste: pasteIntoFocused,
			selectAll: function () {
				document.execCommand && document.execCommand("selectAll");
			},
			undo: function () {
				document.execCommand && document.execCommand("undo");
			},
			redo: function () {
				document.execCommand && document.execCommand("redo");
			},
			insertText: function (text) {
				try {
					document.execCommand("insertText", false, String(text == null ? "" : text));
				} catch (err) {
					/* no editable target */
				}
			},
			replaceMisspelling: function (text) {
				try {
					document.execCommand("insertText", false, String(text == null ? "" : text));
				} catch (err) {
					/* no editable target */
				}
			},
			// macOS "Look up <selection>"; there is no browser equivalent.
			showDefinitionForSelection: function () {},
			isDevToolsOpened: function () {
				return false;
			},
			openDevTools: function () {},
			closeDevTools: function () {},
			focus: function () {
				if (window.focus) window.focus();
			},
			executeJavaScript: function () {
				return Promise.resolve(undefined);
			},
			getURL: function () {
				return window.location.href;
			},
			getTitle: function () {
				return document.title;
			},
			send: function () {},
			setWindowOpenHandler: function () {},
			on: function () {
				return this;
			},
			once: function () {
				return this;
			},
			removeListener: function () {
				return this;
			}
		};
		return webContentsStub;
	}

	var windowStub = null;

	function makeWindowStub() {
		if (windowStub) return windowStub;
		var bounds = {
			x: 0,
			y: 0,
			width: window.innerWidth || 1280,
			height: window.innerHeight || 800
		};
		windowStub = {
			id: 1,
			webContents: makeWebContents(),
			getBounds: function () {
				return {
					x: bounds.x,
					y: bounds.y,
					width: window.innerWidth || bounds.width,
					height: window.innerHeight || bounds.height
				};
			},
			setBounds: function (next) {
				Object.assign(bounds, next || {});
			},
			getPosition: function () {
				return [bounds.x, bounds.y];
			},
			setPosition: function (x, y) {
				bounds.x = x;
				bounds.y = y;
			},
			getSize: function () {
				return [window.innerWidth || bounds.width, window.innerHeight || bounds.height];
			},
			setSize: function (width, height) {
				bounds.width = width;
				bounds.height = height;
			},
			setFrameZoomLevel: function (level) {
				webFrame.setZoomLevel(level);
			},
			isMaximized: function () {
				return false;
			},
			isMinimized: function () {
				return false;
			},
			isFullScreen: function () {
				return !!document.fullscreenElement;
			},
			isFocused: function () {
				return document.hasFocus ? document.hasFocus() : true;
			},
			isVisible: function () {
				return true;
			},
			setMinimumSize: function () {},
			setMaximumSize: function () {},
			isDestroyed: function () {
				return false;
			},
			setFullScreen: function (value) {
				try {
					if (value && document.documentElement.requestFullscreen) {
						document.documentElement.requestFullscreen();
					} else if (!value && document.exitFullscreen && document.fullscreenElement) {
						document.exitFullscreen();
					}
				} catch (err) {
					/* browsers may reject without a user gesture */
				}
			},
			maximize: function () {},
			unmaximize: function () {},
			minimize: function () {},
			restore: function () {},
			center: function () {},
			show: function () {},
			showInactive: function () {},
			hide: function () {},
			focus: function () {},
			close: function () {},
			destroy: function () {},
			setVibrancy: function () {},
			setBackgroundColor: function () {},
			setTrafficLightPosition: function () {},
			setTitleBarOverlay: function () {},
			setTitle: function (title) {
				if (title) document.title = title;
			},
			setRepresentedFilename: function () {},
			setDocumentEdited: function () {},
			setAlwaysOnTop: function () {},
			setOpacity: function () {},
			setResizable: function () {},
			setMenuBarVisibility: function () {},
			setAutoHideMenuBar: function () {},
			setIcon: function () {},
			flashFrame: function () {},
			on: function () {
				return windowStub;
			},
			once: function () {
				return windowStub;
			},
			removeListener: function () {
				return windowStub;
			}
		};
		return windowStub;
	}

	// ---------------------------------------------------------------------
	// remote.screen — only what Obsidian reads: it asks for the displays to
	// decide whether a popout window's restored coordinates are still on a
	// screen (vendor/obsidian/app.js @ ~2831614). Without this stub that check
	// silently fails and every restored popout is re-centered.
	// ---------------------------------------------------------------------

	function makeDisplay() {
		var screenRef = window.screen || {};
		var width = screenRef.width || window.innerWidth || 1280;
		var height = screenRef.height || window.innerHeight || 800;
		// The browser does not expose work-area insets (menu bar, Dock, taskbar);
		// availWidth/availHeight are the closest thing available.
		var workWidth = screenRef.availWidth || width;
		var workHeight = screenRef.availHeight || height;
		return {
			id: 1,
			label: "my-obsidian",
			bounds: { x: 0, y: 0, width: width, height: height },
			workArea: { x: 0, y: 0, width: workWidth, height: workHeight },
			workAreaSize: { width: workWidth, height: workHeight },
			size: { width: width, height: height },
			scaleFactor: window.devicePixelRatio || 1,
			rotation: 0,
			internal: true,
			touchSupport: "unknown"
		};
	}

	var screenStub = {
		getPrimaryDisplay: makeDisplay,
		getAllDisplays: function () {
			return [makeDisplay()];
		},
		getDisplayNearestPoint: makeDisplay,
		getDisplayMatching: makeDisplay,
		getCursorScreenPoint: function () {
			return { x: Math.round(window.screenX || 0), y: Math.round(window.screenY || 0) };
		},
		on: function () {
			return screenStub;
		},
		once: function () {
			return screenStub;
		},
		addListener: function () {
			return screenStub;
		},
		off: function () {
			return screenStub;
		},
		removeListener: function () {
			return screenStub;
		}
	};

	var remote = {
		app: appStub,
		safeStorage: safeStorage,
		nativeTheme: nativeTheme,
		shell: shellStub,
		clipboard: clipboardStub,
		dialog: dialogStub,
		Menu: menuModule,
		MenuItem: MenuItemStub,
		// Context menus resolve the sender back to a WebContents to run
		// cut/copy/paste and spelling actions (app.js @ 2593192). Every id maps
		// to the one page this realm owns.
		webContents: {
			fromId: function () {
				return makeWebContents();
			},
			getFocusedWebContents: function () {
				return makeWebContents();
			},
			getAllWebContents: function () {
				return [makeWebContents()];
			}
		},
		screen: screenStub,
		nativeImage: {
			createFromPath: makeNativeImage,
			createFromBuffer: makeNativeImage,
			createFromDataURL: makeNativeImage,
			createEmpty: makeNativeImage
		},
		getCurrentWindow: makeWindowStub,
		getCurrentWebContents: makeWebContents,
		process: window.process
	};

	function openExternal(url) {
		return shellStub.openExternal(url);
	}

	var electron = {
		ipcRenderer: ipcRenderer,
		ipcMain: {
			on: function () {
				return this;
			},
			once: function () {
				return this;
			},
			handle: function () {},
			removeListener: function () {
				return this;
			},
			emit: function () {}
		},
		remote: remote,
		webFrame: webFrame,
		webContents: remote.webContents,
		app: appStub,
		safeStorage: safeStorage,
		nativeTheme: nativeTheme,
		shell: shellStub,
		clipboard: clipboardStub,
		dialog: dialogStub,
		Menu: menuModule,
		MenuItem: MenuItemStub,
		nativeImage: remote.nativeImage,
		contextBridge: {
			exposeInMainWorld: function () {},
			exposeInIsolatedWorld: function () {}
		},
		BrowserWindow: function BrowserWindow() {
			return makeWindowStub();
		}
	};

	window.electron = electron;
	modules["electron"] = electron;

	// Exposed for debugging from the console. Not used by Obsidian.
	window.__MYOBS_IPC = {
		listeners: listeners,
		lastMenu: function () {
			return lastMenu;
		},
		lastMenuItems: function () {
			return lastMenuItems;
		}
	};
})();
