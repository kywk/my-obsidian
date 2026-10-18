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

		return fetchFn(request.url, options).then(function (response) {
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

	function send(channel) {
		var args = Array.prototype.slice.call(arguments, 1);

		switch (channel) {
			case "request-url":
				handleRequestUrl(args[0], args[1]);
				return;
			case "print-to-pdf":
				// The browser cannot produce an Electron PDF buffer. Complete
				// the reply so callers do not hang; the result is null.
				queueMicrotask(function () {
					emit("print-to-pdf", [null]);
				});
				return;
			case "context-menu":
				queueMicrotask(function () {
					emit("context-menu", [null]);
				});
				return;
			case "set-menu":
				lastMenu = args[0] || null;
				return;
			case "render-menu":
				lastMenu = args[0] || null;
				lastMenuItems = args[1] || null;
				return;
			case "update-menu-items":
				lastMenuItems = args[0] || null;
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
				return Promise.resolve(null);
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

	function makeMenu(template) {
		var menu = {
			items: template || [],
			popup: function () {},
			closePopup: function () {},
			append: function () {},
			insert: function () {},
			destroy: function () {},
			on: function () {
				return menu;
			},
			once: function () {
				return menu;
			},
			removeListener: function () {
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

	var dialogStub = {
		showOpenDialogSync: function () {
			return null;
		},
		showOpenDialog: function () {
			return Promise.resolve({ canceled: true, filePaths: [] });
		},
		showSaveDialogSync: function () {
			return null;
		},
		showSaveDialog: function () {
			return Promise.resolve({ canceled: true, filePath: undefined });
		},
		showMessageBoxSync: function () {
			return 0;
		},
		showMessageBox: function () {
			return Promise.resolve({ response: 0, checkboxChecked: false });
		},
		showErrorBox: function (title, content) {
			console.error("[my-obsidian] " + title + ": " + content);
		}
	};

	function makeSession() {
		var languages = makeLanguageList();
		return {
			availableSpellCheckerLanguages: languages,
			setSpellCheckerLanguages: function () {},
			setSpellCheckerEnabled: function () {},
			getSpellCheckerLanguages: function () {
				return languages.slice();
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
			copy: function () {
				document.execCommand && document.execCommand("copy");
			},
			cut: function () {
				document.execCommand && document.execCommand("cut");
			},
			paste: function () {
				document.execCommand && document.execCommand("paste");
			},
			selectAll: function () {
				document.execCommand && document.execCommand("selectAll");
			},
			undo: function () {
				document.execCommand && document.execCommand("undo");
			},
			redo: function () {
				document.execCommand && document.execCommand("redo");
			},
			insertText: function () {},
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
