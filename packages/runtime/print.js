/*
 * print.js — classic script.
 *
 * Electron's `print-to-pdf` IPC has no browser equivalent: nothing here can
 * write the requested `filepath`, and pretending otherwise would be a lie the
 * caller cannot detect. What the browser *can* do is print the active note
 * through the browser's own print dialog (which offers "Save as PDF"), so this
 * module:
 *
 *   1. owns the `print-to-pdf` channel on the renderer side (send / invoke /
 *      on / once), runs the browser print flow, and answers the caller with an
 *      explicit `{ ok:false, reason:"browser-print-dialog" }` result;
 *   2. puts the active note's view into a dedicated `<div class="print">`
 *      container and hides the rest of the application, so only that note is
 *      printed;
 *   3. restores the view's DOM position, `document.body.className` and the
 *      stylesheet afterwards, including when `window.print()` throws;
 *   4. exposes the flow for harnesses:
 *        window.__MYOBS_PRINT = { printActiveNote(), lastResult, events[] }
 *
 * Why move the view instead of only adding `@media print` rules that reveal
 * the leaf: Obsidian's own app.css already contains
 *
 *     @media print {
 *       .app-container { display: none !important; }
 *       body > :not(.print) { display: none !important; }
 *     }
 *
 * so at print time the whole app shell — including the active leaf — is
 * display:none. A stylesheet that merely tries to reveal the leaf is fighting
 * a rule that hides its ancestor, and the measured result was a blank 1 KB
 * PDF. The renderer's own Export-to-PDF path solves this the same way: it
 * renders the note into a `.print` div and lets app.css hide everything else.
 * We reuse that documented structure rather than inventing a second one.
 *
 * `beginPrintView()` / `endPrintView()` are exposed because a PDF produced by
 * CDP's Page.printToPDF needs the print view to stay applied across a
 * client-side command; they are verification helpers, not the public flow.
 *
 * Honest limitations (also reported to the caller):
 *   - `filepath` is never written; the user chooses the destination in the
 *     print dialog.
 *   - Obsidian's own "Export to PDF" dialog goes through
 *     `remote.dialog.showSaveDialog`, which electron-shim answers with
 *     `{canceled:true}`; that path never reaches this module. Plugins and any
 *     direct `ipcRenderer.send("print-to-pdf", ...)` callers do.
 *   - In source mode the CodeMirror editor virtualizes long documents, so a
 *     very long note may print only the rendered lines. Reading view prints
 *     the full document; the flow uses whichever view the leaf is showing.
 */
(function () {
	"use strict";

	var EVENTS_MAX = 50;
	var STYLE_ID = "myobs-print-style";
	var ROOT_ID = "myobs-print-root";
	var TARGET_CLASS = "myobs-print-target";
	var PRINTING_CLASS = "myobs-printing";

	var events = [];
	var lastResult = null;
	var savedBodyClass = null;
	/** @type {null | { leaf: Element, view: Element, kind: string, path: string|null, parent: Element|null, next: Node|null, root: Element }} */
	var activeTarget = null;
	var holdRestore = false;
	var ipcWrapped = false;

	/**
	 * @param {string} action
	 * @param {object} [detail]
	 */
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

	/*
	 * Why the rules are not wrapped in @media print:
	 * a harness that intercepts window.print() and reads getComputedStyle()
	 * would see screen media, where @media print never applies. Scoping every
	 * rule to body.myobs-printing makes the same stylesheet effective for the
	 * screen snapshot, for window.print(), and for CDP's Page.printToPDF
	 * (which renders with print media). The class only exists during the print
	 * call, and the view is moved out of the app shell first.
	 */
	var PRINT_CSS = [
		"body." + PRINTING_CLASS + " {",
		"	background: #fff !important;",
		"	color: #111 !important;",
		"}",
		/* The note lives in this container; every other body child is invisible. */
		"body." + PRINTING_CLASS + " > :not(#" + ROOT_ID + ") {",
		"	display: none !important;",
		"}",
		/* Explicit rules so computed styles also report the shell as hidden. */
		"body." + PRINTING_CLASS + " .status-bar,",
		"body." + PRINTING_CLASS + " .workspace-ribbon,",
		"body." + PRINTING_CLASS + " .workspace-split.mod-sidedock,",
		"body." + PRINTING_CLASS + " .workspace-tab-header-container,",
		"body." + PRINTING_CLASS + " .view-header,",
		"body." + PRINTING_CLASS + " .titlebar,",
		"body." + PRINTING_CLASS + " .menu,",
		"body." + PRINTING_CLASS + " .menu-container,",
		"body." + PRINTING_CLASS + " .modal-container,",
		"body." + PRINTING_CLASS + " .modal-bg,",
		"body." + PRINTING_CLASS + " .popover,",
		"body." + PRINTING_CLASS + " .tooltip {",
		"	display: none !important;",
		"}",
		"#" + ROOT_ID + " {",
		"	display: block !important;",
		"	position: static !important;",
		"	margin: 0 !important;",
		"	padding: 0 !important;",
		"	background: #fff !important;",
		"	color: #111 !important;",
		"}",
		"#" + ROOT_ID + " .markdown-preview-view,",
		"#" + ROOT_ID + " .markdown-preview-sizer,",
		"#" + ROOT_ID + " .markdown-source-view,",
		"#" + ROOT_ID + " .cm-scroller,",
		"#" + ROOT_ID + " .cm-content {",
		"	position: static !important;",
		"	width: auto !important;",
		"	max-width: 100% !important;",
		"	height: auto !important;",
		"	max-height: none !important;",
		"	overflow: visible !important;",
		"	transform: none !important;",
		"}",
		"#" + ROOT_ID + " .markdown-preview-view {",
		"	padding: 0 !important;",
		"}",
		/* Dark themes would print light text on white paper. */
		"#" + ROOT_ID + ",",
		"#" + ROOT_ID + " * {",
		"	color: #111 !important;",
		"}",
		"#" + ROOT_ID + " pre,",
		"#" + ROOT_ID + " code {",
		"	background: #f4f4f4 !important;",
		"	color: #111 !important;",
		"}",
		"#" + ROOT_ID + " img,",
		"#" + ROOT_ID + " svg,",
		"#" + ROOT_ID + " video,",
		"#" + ROOT_ID + " canvas {",
		"	max-width: 100% !important;",
		"	height: auto !important;",
		"}",
		"@page { margin: 16mm; }",
		"@media print {",
		"	html, body { height: auto !important; overflow: visible !important; }",
		"}",
	].join("\n");

	function isRendered(element) {
		if (!element || !element.getClientRects) return false;
		if (element.getClientRects().length === 0) return false;
		var style = window.getComputedStyle(element);
		return style.display !== "none" && style.visibility !== "hidden";
	}

	/**
	 * @param {Element} leaf
	 * @returns {{ element: Element, kind: "preview"|"source" } | null}
	 */
	function findView(leaf) {
		if (!leaf) return null;
		var preview = leaf.querySelector(".markdown-preview-view");
		if (preview && isRendered(preview)) return { element: preview, kind: "preview" };
		var source = leaf.querySelector(".markdown-source-view");
		if (source && isRendered(source)) return { element: source, kind: "source" };
		// Reading view can be rendered while the leaf is still being measured
		// (getClientRects() empty during a layout batch). Prefer preview when it
		// exists at all rather than reporting "no note".
		if (preview) return { element: preview, kind: "preview" };
		if (source) return { element: source, kind: "source" };
		return null;
	}

	function pathForView(view) {
		try {
			if (view.file && view.file.path) return view.file.path;
		} catch (err) {
			/* fall through to the workspace's active file */
		}
		try {
			var app = window.app;
			var file = app && app.workspace && app.workspace.getActiveFile
				? app.workspace.getActiveFile()
				: null;
			return file && file.path ? file.path : null;
		} catch (err) {
			return null;
		}
	}

	/**
	 * The active note, in this order:
	 *   1. the DOM leaf Obsidian marked active (what the user is looking at);
	 *   2. app.workspace.activeLeaf (keyboard/focus edge cases);
	 *   3. any leaf showing the workspace's active file (sidebar focus).
	 *
	 * @returns {{ leaf: Element, view: { element: Element, kind: "preview"|"source" }, path: string|null } | null}
	 */
	function findActiveTarget() {
		var candidates = document.querySelectorAll(".workspace-leaf.mod-active");
		for (var i = 0; i < candidates.length; i += 1) {
			var found = findView(candidates[i]);
			if (found) return { leaf: candidates[i], view: found, path: pathForView(found.element) };
		}

		var app = window.app;
		var activeLeaf = app && app.workspace ? app.workspace.activeLeaf : null;
		if (
			activeLeaf &&
			activeLeaf.containerEl &&
			activeLeaf.containerEl.ownerDocument === document
		) {
			found = findView(activeLeaf.containerEl);
			if (found) return { leaf: activeLeaf.containerEl, view: found, path: pathForView(found.element) };
		}

		var activeFile =
			app && app.workspace && typeof app.workspace.getActiveFile === "function"
				? app.workspace.getActiveFile()
				: null;
		if (!activeFile || !activeFile.path) return null;
		var leaves = document.querySelectorAll(".workspace-leaf");
		for (i = 0; i < leaves.length; i += 1) {
			found = findView(leaves[i]);
			if (!found) continue;
			var path = pathForView(found.element);
			if (path === activeFile.path) return { leaf: leaves[i], view: found, path: path };
		}
		return null;
	}

	function styleElement() {
		return document.getElementById(STYLE_ID);
	}

	function ensureStyle() {
		if (styleElement()) return;
		var style = document.createElement("style");
		style.id = STYLE_ID;
		style.textContent = PRINT_CSS;
		(document.head || document.documentElement).appendChild(style);
	}

	/**
	 * Move the active note's view into a body-level `.print` container, mark the
	 * container with the print class, and apply the stylesheet. Idempotent.
	 *
	 * @param {{ hold?: boolean }} [options] `hold` keeps the view applied across
	 *   an external print command (CDP Page.printToPDF fires afterprint itself);
	 *   verification only.
	 * @returns {{ ok: boolean, path?: string|null, kind?: string, reason?: string, error?: object }}
	 */
	function beginPrintView(options) {
		options = options || {};
		if (activeTarget) {
			return { ok: true, alreadyActive: true, path: activeTarget.path, kind: activeTarget.kind };
		}
		var target = findActiveTarget();
		if (!target) {
			return {
				ok: false,
				reason: "no-active-note",
				error: {
					code: "NO_ACTIVE_NOTE",
					message: "目前沒有開啟的筆記，取消列印；請先開啟一篇筆記再列印。",
				},
			};
		}

		var view = target.view.element;
		var parent = view.parentElement;
		var next = view.nextSibling;
		var root = document.createElement("div");
		root.id = ROOT_ID;
		// `print` is the class app.css's print rules opt into; without it,
		// `body > :not(.print)` hides this container too.
		root.className = "print " + TARGET_CLASS;
		root.setAttribute("data-path", target.path || "");

		// Exact restore target, including classes Obsidian adds while loading.
		savedBodyClass = document.body.className;
		holdRestore = options.hold === true;
		ensureStyle();
		document.body.appendChild(root);
		// The view node is moved, not cloned: CodeMirror and the preview keep
		// their internal references, and restoring the same node preserves all
		// scroll/edit state.
		root.appendChild(view);
		document.body.classList.add(PRINTING_CLASS);

		activeTarget = {
			leaf: target.leaf,
			view: view,
			kind: target.view.kind,
			path: target.path,
			parent: parent,
			next: next,
			root: root,
		};
		record("begin", { path: activeTarget.path, kind: activeTarget.kind });
		return { ok: true, path: activeTarget.path, kind: activeTarget.kind };
	}

	/**
	 * Remove the print view, move the note view back, and restore the body class
	 * verbatim. Idempotent.
	 *
	 * @param {string} [reason]
	 * @returns {{ ok: boolean, restored: boolean }}
	 */
	function endPrintView(reason) {
		if (!activeTarget) return { ok: true, restored: false };
		var target = activeTarget;
		var restored = false;
		try {
			if (target.parent && target.parent.isConnected) {
				if (target.next && target.next.parentNode === target.parent) {
					target.parent.insertBefore(target.view, target.next);
				} else {
					target.parent.appendChild(target.view);
				}
				restored = true;
			} else if (target.leaf && target.leaf.isConnected) {
				// Last resort: the original container was reparented by the app
				// while printing. Put the view back inside its leaf.
				target.leaf.appendChild(target.view);
				restored = true;
			}
			if (!restored) {
				// Never remove the root while the view is still inside it: that
				// would detach the editor's DOM from the document.
				document.body.appendChild(target.view);
				record("restore-orphaned", { path: target.path });
			}
		} catch (err) {
			record("restore-failed", { error: String(err && err.message ? err.message : err) });
		}
		if (target.root && target.root.parentNode) target.root.parentNode.removeChild(target.root);
		document.body.classList.remove(PRINTING_CLASS);
		if (savedBodyClass !== null) {
			// Verbatim restore is the contract: the harness compares the string
			// before and after, and Obsidian owns every other body class.
			document.body.className = savedBodyClass;
		}
		var style = styleElement();
		if (style && style.parentNode) style.parentNode.removeChild(style);
		record("end", { reason: reason || "manual", path: target.path, domRestored: restored });
		activeTarget = null;
		savedBodyClass = null;
		holdRestore = false;
		return { ok: true, restored: restored };
	}

	/**
	 * Print the active note through the browser's print dialog.
	 *
	 * @param {object} [options]
	 * @param {string} [options.filepath] Recorded in the result, never written.
	 * @returns {object} lastResult
	 */
	function printActiveNote(options) {
		options = options || {};
		var target = activeTarget || findActiveTarget();
		if (!target) {
			lastResult = {
				ok: false,
				reason: "no-active-note",
				error: {
					code: "NO_ACTIVE_NOTE",
					message: "目前沒有開啟的筆記，取消列印；請先開啟一篇筆記再列印。",
				},
				filepath: options.filepath != null ? String(options.filepath) : null,
				fileWritten: false,
				at: Date.now(),
			};
			api.lastResult = lastResult;
			record("aborted", { reason: "no-active-note" });
			return lastResult;
		}

		var begun = beginPrintView({ hold: true });
		if (!begun.ok) {
			lastResult = {
				ok: false,
				reason: begun.reason || "begin-failed",
				error: begun.error,
				filepath: options.filepath != null ? String(options.filepath) : null,
				fileWritten: false,
				at: Date.now(),
			};
			api.lastResult = lastResult;
			record("aborted", { reason: lastResult.reason });
			return lastResult;
		}

		var failure = null;
		try {
			window.print();
		} catch (err) {
			failure = {
				code: "PRINT_FAILED",
				message: String(err && err.message ? err.message : err),
			};
		} finally {
			endPrintView("print-returned");
		}

		lastResult = {
			ok: !failure,
			// Not "saved": the dialog decides whether the user produces a PDF.
			reason: "browser-print-dialog",
			printed: !failure,
			// The caller supplied a filepath; the browser cannot honour it.
			fileWritten: false,
			path: begun.path != null ? begun.path : target.path,
			kind: begun.kind || target.kind || (target.view && target.view.kind) || null,
			filepath: options.filepath != null ? String(options.filepath) : null,
			error: failure || undefined,
			at: Date.now(),
		};
		api.lastResult = lastResult;
		record("printed", {
			path: lastResult.path,
			kind: lastResult.kind,
			ok: lastResult.ok,
			filepath: lastResult.filepath,
		});
		return lastResult;
	}

	// ---------------------------------------------------------------------
	// IPC ownership
	// ---------------------------------------------------------------------

	/** @type {Array<{ fn: Function, once: boolean }>} */
	var printListeners = [];

	function dispatchPrint(args) {
		var list = printListeners.slice();
		printListeners = printListeners.filter(function (entry) {
			return !entry.once;
		});
		for (var i = 0; i < list.length; i += 1) {
			try {
				list[i].fn.apply(null, [{ channel: "print-to-pdf", sender: null }].concat(args));
			} catch (err) {
				console.error("[my-obsidian] print-to-pdf listener threw", err);
			}
		}
	}

	/**
	 * Electron's main process responds with a PDF buffer or writes `filepath`.
	 * Neither is possible here; answer with the explicit failure the caller can
	 * branch on instead of a null that looks like success.
	 *
	 * @param {object} result from printActiveNote()
	 * @param {object|null} payload the caller's argument
	 * @returns {object}
	 */
	function ipcResult(result, payload) {
		var noNote = Boolean(result && result.ok === false);
		return {
			ok: false,
			// "no-active-note" is a real failure the caller can fix; the normal
			// path is a successful browser print that simply did not write the
			// requested filepath.
			reason: noNote ? result.reason || "browser-print-dialog" : "browser-print-dialog",
			message: noNote
				? (result.error && result.error.message) ||
					"目前沒有開啟的筆記，取消列印。"
				: "瀏覽器無法寫入 filepath；已改用瀏覽器列印流程，請在對話框中選擇「另存為 PDF」。",
			filepath: payload && payload.filepath != null ? String(payload.filepath) : null,
			fileWritten: false,
			path: result && result.path ? result.path : null,
			printed: Boolean(result && result.printed),
			error: result && result.error ? result.error : undefined,
		};
	}

	function electronIpcRenderer() {
		try {
			var modules = window.__MYOBS_MODULES;
			var electron = modules && modules.electron;
			if (!electron && typeof window.require === "function") electron = window.require("electron");
			return electron && electron.ipcRenderer ? electron.ipcRenderer : null;
		} catch (err) {
			return null;
		}
	}

	/**
	 * Take ownership of print-to-pdf on the renderer side. Without consuming the
	 * listener registration the shim's own `send` would answer null before our
	 * print flow completes.
	 *
	 * @param {object} ipc
	 */
	function wrapIpcRenderer(ipc) {
		if (!ipc || ipc.__myobsPrintWrapped) return false;
		var originalOn = ipc.on;
		var originalOnce = ipc.once;
		var originalOff = ipc.off || ipc.removeListener;
		var originalRemoveAll = ipc.removeAllListeners;
		var originalSend = ipc.send;
		var originalInvoke = ipc.invoke;

		function remember(fn, once) {
			if (typeof fn !== "function") throw new TypeError("ipcRenderer listener must be a function");
			printListeners.push({ fn: fn, once: once });
			return ipc;
		}

		ipc.on = function (channel, fn) {
			if (channel === "print-to-pdf") return remember(fn, false);
			return originalOn.call(ipc, channel, fn);
		};
		ipc.once = function (channel, fn) {
			if (channel === "print-to-pdf") return remember(fn, true);
			return originalOnce.call(ipc, channel, fn);
		};
		ipc.off = ipc.removeListener = function (channel, fn) {
			if (channel === "print-to-pdf") {
				printListeners = printListeners.filter(function (entry) {
					return entry.fn !== fn;
				});
				return ipc;
			}
			return originalOff.call(ipc, channel, fn);
		};
		ipc.removeAllListeners = function (channel) {
			if (arguments.length === 0 || channel === "print-to-pdf") printListeners = [];
			return arguments.length === 0
				? originalRemoveAll.call(ipc)
				: originalRemoveAll.call(ipc, channel);
		};
		ipc.send = function (channel) {
			if (channel !== "print-to-pdf") return originalSend.apply(ipc, arguments);
			var payload = arguments.length > 1 ? arguments[1] : null;
			queueMicrotask(function () {
				var result = printActiveNote(payload || {});
				dispatchPrint([ipcResult(result, payload)]);
			});
			return undefined;
		};
		ipc.invoke = function (channel) {
			if (channel !== "print-to-pdf") return originalInvoke.apply(ipc, arguments);
			var payload = arguments.length > 1 ? arguments[1] : null;
			return Promise.resolve().then(function () {
				return ipcResult(printActiveNote(payload || {}), payload);
			});
		};
		ipc.__myobsPrintWrapped = true;
		return true;
	}

	function installIpcOwnership() {
		if (ipcWrapped) return;
		var ipc = electronIpcRenderer();
		if (!ipc) {
			record("ipc-unavailable", {});
			return;
		}
		ipcWrapped = wrapIpcRenderer(ipc);
		if (ipcWrapped) record("ipc-owned", {});
	}

	// ---------------------------------------------------------------------
	// Service worker registration (index.html is not ours to edit). Static
	// assets only; /api/fs, /api/watch and /v/* are never cached (DESIGN.md §3
	// item 13). Registration failure is a warning, never a boot failure.
	// ---------------------------------------------------------------------
	function registerServiceWorker() {
		if (!("serviceWorker" in navigator)) return;
		try {
			navigator.serviceWorker
				.register("/sw.js")
				.then(function (registration) {
					record("service-worker", {
						scope: registration.scope,
						active: Boolean(registration.active),
					});
				})
				.catch(function (err) {
					console.warn(
						"[my-obsidian] service worker registration failed (static assets will load without it):",
						err && err.message ? err.message : err,
					);
					record("service-worker-failed", { error: String((err && err.message) || err) });
				});
		} catch (err) {
			console.warn("[my-obsidian] service worker registration threw:", err);
			record("service-worker-failed", { error: String((err && err.message) || err) });
		}
	}

	// ---------------------------------------------------------------------
	// Public surface
	// ---------------------------------------------------------------------

	var api = {
		installed: false,
		printActiveNote: printActiveNote,
		beginPrintView: beginPrintView,
		endPrintView: endPrintView,
		lastResult: lastResult,
		events: events,
	};

	window.__MYOBS_PRINT = api;

	installIpcOwnership();
	// The browser's own print command (Ctrl/Cmd+P) never goes through our API.
	// Apply the print view synchronously for it too; afterprint restores. If no
	// note is open, leave the browser to its default behaviour (we cannot cancel
	// a print job from beforeprint) but record why.
	window.addEventListener("beforeprint", function () {
		if (activeTarget) return;
		var begun = beginPrintView();
		if (!begun.ok) record("beforeprint-no-note", { reason: begun.reason });
	});
	// `window.print()` can return before the dialog closes in some browsers;
	// make sure the styles come back even if our own finally block did not see
	// the end of the job.
	window.addEventListener("afterprint", function () {
		if (activeTarget && !holdRestore) endPrintView("afterprint");
	});

	registerServiceWorker();
	api.installed = true;
})();
