/*
 * menu.js — classic script, loaded before Obsidian's app.js.
 *
 * The runtime has no native menu bar and no native menus at all, so every
 * Electron menu entry point has to become DOM:
 *
 *   ipcRenderer.on("set-menu", { template })      -> the application menu bar
 *   ipcRenderer.on("update-menu-items", [...])    -> checked/enabled/visible/label
 *   ipcRenderer.on("render-menu")                 -> pop the root menu at the cursor
 *   ipcRenderer.on("context-menu")                -> editFlags reply (see below)
 *   remote.Menu.buildFromTemplate(t).popup(opts)  -> HTML popup (fallback)
 *
 * Why the fallback exists: on macOS the renderer's Menu class defaults to
 * `useNativeMenu = true` (vendor/obsidian/app.js @ 3925759, `updateUseNativeMenu`),
 * and in that mode every context menu is built as an Electron template and
 * handed to `Menu.popup()`, which our shim used to drop on the floor. Obsidian's
 * own HTML menu path is better (icons, sections, plugin items), and setting
 * `nativeMenus: false` selects it — but the setting lives in
 * `.obsidian/appearance.json` on 1.14.4 (it is migrated out of app.json), so it
 * is a per-vault choice we cannot make for the user. The template path keeps
 * right-click working for vaults that never touch that setting.
 *
 * The context-menu reply is not optional. The renderer asks the host for
 * `editFlags` before it draws the editor menu and bails out completely when the
 * reply is falsy (app.js @ 2593104: `if (!(d = O.sent()) || e.defaultPrevented)
 * return;`). Replying `null`, as the shim did, is why right-clicking the editor
 * produced nothing even when the renderer would have drawn the menu itself.
 *
 * Everything here is wrapped so a failure can never reach the runtime's fatal
 * error surface (index.html replaces window.onerror with a full-screen panel).
 */
(function () {
	"use strict";

	var BAR_CLASS = "myobs-menubar";
	var BAR_ITEM_CLASS = "myobs-menubar-item";
	var PANEL_CLASS = "myobs-menu-panel";
	var ROW_CLASS = "myobs-menu-row";
	var STYLE_ID = "myobs-menu-style";

	var MAC = detectMac();

	var state = {
		template: null,
		barEl: null,
		barButtons: [],
		barDoc: null,
		barVisible: false,
		toggleEl: null,
		returnFocus: null,
		mountTimer: null,
		mountObserver: null,
		altPending: false,
		// The panel currently shown from the bar; `parent` links a submenu.
		rootPanel: null,
		// Popup opened through Menu.popup() (the native fallback).
		popupPanel: null,
		popupClose: null,
		openTopIndex: -1,
		pointer: { x: 24, y: 24 },
		rows: [],
		listeners: null,
		keyDocs: [],
		activeRow: null,
		lastContextReply: null,
		lastPopup: null,
		lastClose: null,
		lastUpdate: null,
		installError: null
	};

	function detectMac() {
		try {
			if (typeof process !== "undefined" && process && process.platform) {
				return process.platform === "darwin";
			}
		} catch (err) {
			/* process shim missing: fall through to the UA */
		}
		return /Mac/i.test(navigator.platform || navigator.userAgent || "");
	}

	function warn(message, err) {
		try {
			console.warn("[my-obsidian] menu: " + message, err || "");
		} catch (ignored) {
			/* console may itself be gone */
		}
	}

	// Nothing in this file may reach window.onerror: index.html turns that into
	// a full-screen fatal panel and the user would lose the editor over a
	// menu bug. Every listener goes through here.
	function guard(name, fn) {
		return function (event) {
			try {
				return fn(event);
			} catch (err) {
				warn(name + " failed", err);
			}
		};
	}

	// ------------------------------------------------------------------
	// Documents. Obsidian renders popouts as additional documents over the
	// same heap; a context menu opened by a right-click in a popout belongs
	// to that document, not to the main one.
	// ------------------------------------------------------------------

	function coerceDoc(doc) {
		if (doc && doc.body && typeof doc.createElement === "function") return doc;
		return document;
	}

	function activeDoc() {
		try {
			var doc = window.activeDocument;
			if (doc && doc.body) return doc;
		} catch (err) {
			/* no activeDocument yet */
		}
		return document;
	}

	function docWindow(doc) {
		return (doc && doc.defaultView) || window;
	}

	// ------------------------------------------------------------------
	// Model helpers
	// ------------------------------------------------------------------

	function itemId(item) {
		if (!item) return null;
		// The desktop main process folds appCommand into the MenuItem id
		// (main.js @ 177318, `kt()`: `o.id = i`), and update-menu-items keys
		// off that id. Mirror it so `markdown:toggle-preview` updates land.
		if (item.id) return String(item.id);
		if (item.appCommand) return String(item.appCommand);
		return null;
	}

	function isSeparator(item) {
		return !!item && item.type === "separator";
	}

	function isVisible(item) {
		return !!item && item.visible !== false;
	}

	function isEnabled(item) {
		return !!item && item.enabled !== false && item.disabled !== true;
	}

	function isCheckable(item) {
		return !!item && (item.type === "checkbox" || item.type === "radio" || typeof item.checked === "boolean");
	}

	function displayLabel(label) {
		if (label == null) return "";
		// Native menus use "&&" for a literal ampersand and a single "&" as the
		// mnemonic marker (main.js passes "&File"). Show neither.
		return String(label)
			.replace(/&&/g, "\u0000")
			.replace(/&/g, "")
			.replace(/\u0000/g, "&");
	}

	var ACCEL_MAC = {
		CommandOrControl: "\u2318",
		Command: "\u2318",
		Cmd: "\u2318",
		Control: "\u2303",
		Ctrl: "\u2303",
		Alt: "\u2325",
		Option: "\u2325",
		Shift: "\u21e7",
		Super: "\u2318",
		Meta: "\u2318"
	};

	var ACCEL_PC = {
		CommandOrControl: "Ctrl",
		Command: "Ctrl",
		Cmd: "Ctrl",
		Control: "Ctrl",
		Ctrl: "Ctrl",
		Alt: "Alt",
		Option: "Alt",
		Shift: "Shift",
		Super: "Win",
		Meta: "Win"
	};

	var KEY_SYMBOL_MAC = {
		ArrowLeft: "\u2190",
		ArrowRight: "\u2192",
		ArrowUp: "\u2191",
		ArrowDown: "\u2193",
		Enter: "\u21a9",
		Escape: "\u238b",
		Backspace: "\u232b",
		Delete: "\u2326",
		Tab: "\u21e5",
		" ": "Space",
		Plus: "+",
		Comma: ",",
		Minus: "-",
		Period: ".",
		Slash: "/"
	};

	// Accelerators are Electron spellings ("CommandOrControl+Shift+T"). We do
	// not bind them — Obsidian's keymap owns shortcuts — only display them.
	function formatAccelerator(value) {
		if (value == null) return "";
		var raw = String(value).trim();
		if (!raw) return "";
		var map = MAC ? ACCEL_MAC : ACCEL_PC;
		var parts = raw.split("+");
		var out = [];
		for (var i = 0; i < parts.length; i++) {
			var part = parts[i];
			if (!part) {
				// A trailing "+" is the Plus key itself.
				out.push("+");
				continue;
			}
			if (map[part]) {
				out.push(map[part]);
				continue;
			}
			if (MAC && KEY_SYMBOL_MAC[part]) {
				out.push(KEY_SYMBOL_MAC[part]);
				continue;
			}
			// "KeyE" / "Digit1" forms are not produced by Obsidian's
			// getAcceleratorFromHotkey, but normalise them if they appear.
			out.push(part.replace(/^Key/, "").replace(/^Digit/, ""));
		}
		if (MAC) return out.join("");
		return out.join("+");
	}

	// ------------------------------------------------------------------
	// DOM helpers (no Obsidian prototypes: enhance.js may not have run yet)
	// ------------------------------------------------------------------

	function make(doc, tag, className, text) {
		var node = doc.createElement(tag);
		if (className) node.className = className;
		if (text != null) node.textContent = text;
		return node;
	}

	function placePanel(doc, panel, x, y) {
		var win = docWindow(doc);
		var vw = win.innerWidth || 1280;
		var vh = win.innerHeight || 800;
		panel.style.left = "-9999px";
		panel.style.top = "-9999px";
		var rect = panel.getBoundingClientRect();
		var left = x;
		var top = y;
		if (left + rect.width > vw - 8) left = Math.max(8, x - rect.width);
		if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8);
		panel.style.left = Math.round(left) + "px";
		panel.style.top = Math.round(top) + "px";
	}

	// ------------------------------------------------------------------
	// Stylesheet
	// ------------------------------------------------------------------

	var CSS = [
		"#myobs-application-menu." + BAR_CLASS + "{",
		"  position:fixed;z-index:2147482990;display:flex;align-items:center;",
		"  height:36px;max-width:calc(100vw - 12px);box-sizing:border-box;",
		"  padding:2px;gap:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;user-select:none;-webkit-user-select:none;",
		"  font-family:var(--font-interface,system-ui,-apple-system,sans-serif);",
		"  font-size:var(--font-ui-smaller,12px);",
		"  color:var(--text-muted,var(--text-normal,#ccc));",
		"  background:var(--background-secondary,var(--background-primary,#1e1e1e));",
		"  border:1px solid var(--background-modifier-border,rgba(128,128,128,.25));border-radius:6px;",
		"  -webkit-app-region:no-drag;",
		"}",
		"#myobs-application-menu[hidden]{display:none !important;}",
		"#myobs-application-menu::-webkit-scrollbar{display:none;}",
		"#myobs-application-menu>button." + BAR_ITEM_CLASS + "{",
		"  all:unset;appearance:none;box-sizing:border-box;border:0;background:transparent;color:inherit;font:inherit;",
		"  display:flex;flex:0 0 auto;align-items:center;height:30px;min-height:0;min-width:0;",
		"  padding:0 10px;margin:0;border-radius:4px;box-shadow:none;line-height:1.2;",
		"  cursor:default;white-space:nowrap;",
		"}",
		"#myobs-application-menu>button." + BAR_ITEM_CLASS + ":hover,#myobs-application-menu>button." + BAR_ITEM_CLASS + ".is-open{",
		"  background:var(--background-modifier-hover,rgba(128,128,128,.2));",
		"  color:var(--text-normal,#ddd);",
		"}",
		"#myobs-application-menu>button." + BAR_ITEM_CLASS + ":focus-visible{outline:2px solid var(--interactive-accent,#5b8def);outline-offset:-2px;}",
		"button.myobs-menu-toggle.clickable-icon{all:unset;box-sizing:border-box;display:flex;flex:0 0 auto;align-items:center;justify-content:center;",
		"  width:32px;height:32px;min-height:0;min-width:0;padding:0;margin:4px auto;border:0;border-radius:4px;box-shadow:none;",
		"  background:transparent;color:var(--icon-color,var(--text-muted,#aaa));cursor:pointer;line-height:1;}",
		"button.myobs-menu-toggle.clickable-icon:hover,button.myobs-menu-toggle.clickable-icon[aria-expanded=true]{background:var(--background-modifier-hover);color:var(--text-normal);}",
		"button.myobs-menu-toggle.clickable-icon:focus-visible{outline:2px solid var(--interactive-accent,#5b8def);outline-offset:2px;}",
		"button.myobs-menu-toggle.clickable-icon.is-floating{position:fixed;z-index:2147482990;top:48px;right:8px;margin:0;background:var(--background-secondary,#202020);}",
		"button.myobs-menu-toggle.clickable-icon>svg{display:block;width:18px;height:18px;pointer-events:none;}",
		"button.myobs-menu-toggle[hidden]{display:none !important;}",
		"." + PANEL_CLASS + "{",
		"  position:fixed;z-index:2147483000;box-sizing:border-box;",
		"  min-width:200px;max-width:min(420px,92vw);max-height:min(80vh,640px);overflow-y:auto;",
		"  padding:5px;border:1px solid var(--menu-border-color,var(--background-modifier-border-hover,#3a3a3a));",
		"  border-radius:var(--menu-radius,8px);",
		"  background:var(--menu-background,var(--background-secondary,#202020));",
		"  box-shadow:var(--menu-shadow,0 8px 24px rgba(0,0,0,.45));",
		"  color:var(--text-normal,#ddd);",
		"  font-family:var(--font-interface,system-ui,-apple-system,sans-serif);",
		"  font-size:var(--font-ui-small,13px);",
		"  user-select:none;-webkit-user-select:none;",
		"}",
		"." + ROW_CLASS + "{",
		"  display:flex;align-items:center;gap:8px;min-height:26px;box-sizing:border-box;",
		"  padding:3px 8px;border-radius:4px;cursor:default;white-space:nowrap;",
		"}",
		"." + ROW_CLASS + "[hidden]{display:none !important;}",
		"." + ROW_CLASS + ":hover:not([aria-disabled=true]),." + ROW_CLASS + ".is-active{",
		"  background:var(--background-modifier-hover,rgba(128,128,128,.22));",
		"}",
		"." + ROW_CLASS + "[aria-disabled=true]{opacity:.45;cursor:default;}",
		"." + ROW_CLASS + ":focus{outline:none;}",
		".myobs-menu-check{flex:0 0 14px;text-align:center;color:var(--interactive-accent,#5b8def);font-size:11px;}",
		".myobs-menu-label{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;}",
		".myobs-menu-accel{flex:0 0 auto;color:var(--text-faint,#8a8a8a);font-size:.92em;letter-spacing:.02em;}",
		".myobs-menu-arrow{flex:0 0 auto;color:var(--text-faint,#8a8a8a);}",
		".myobs-menu-sep{height:1px;margin:5px 6px;background:var(--background-modifier-border,rgba(128,128,128,.28));}",
		".myobs-menu-sep:first-child,.myobs-menu-sep:last-child{display:none;}",
		"@media print{#myobs-application-menu,button.myobs-menu-toggle.clickable-icon{display:none !important;}}"
	].join("\n");

	function injectStyle(doc) {
		if (!doc || !doc.head) return;
		if (doc.getElementById(STYLE_ID)) return;
		var style = doc.createElement("style");
		style.id = STYLE_ID;
		style.textContent = CSS;
		doc.head.appendChild(style);
	}

	// ------------------------------------------------------------------
	// Panels and rows
	// ------------------------------------------------------------------

	function clearRows(panel) {
		state.rows = state.rows.filter(function (entry) {
			return entry.panel !== panel && !panel.contains(entry.el);
		});
	}

	function openSubmenu(row, item, immediate) {
		if (!row || !item || !item.submenu || !item.submenu.length) return;
		var doc = row.ownerDocument;
		closeSubmenu(row);
		var panel = buildPanel(doc, item.submenu, {
			parentRow: row,
			root: false
		});
		doc.body.appendChild(panel);
		var rect = row.getBoundingClientRect();
		placePanel(doc, panel, rect.right - 3, rect.top - 5);
		row._myobsSubmenu = panel;
		row.classList.add("is-open");
		state.rootPanel = state.rootPanel || panel;
		if (immediate) focusFirst(panel);
	}

	function closeSubmenu(row) {
		if (!row) return;
		var pending = row._myobsTimer;
		if (pending) {
			clearTimeout(pending);
			row._myobsTimer = null;
		}
		var panel = row._myobsSubmenu;
		if (panel) {
			row._myobsSubmenu = null;
			closePanel(panel);
		}
		row.classList.remove("is-open");
	}

	function closePanel(panel) {
		if (!panel) return;
		if (state.activeRow && panel.contains(state.activeRow)) state.activeRow = null;
		var parent = panel._myobsParentRow;
		panel._myobsParentRow = null;
		if (parent) {
			// Detach the back-reference before descending: calling closeSubmenu
			// here would re-enter closePanel on this same panel indefinitely.
			if (parent._myobsSubmenu === panel) {
				if (parent._myobsTimer) clearTimeout(parent._myobsTimer);
				parent._myobsTimer = null;
				parent._myobsSubmenu = null;
				parent.classList.remove("is-open");
			}
			var parentPanel = parent._myobsPanel;
			if (parentPanel && parentPanel._myobsChildren) {
				parentPanel._myobsChildren = parentPanel._myobsChildren.filter(function (child) {
					return child !== panel;
				});
			}
		}
		// A pending hover must not recreate a submenu after its parent closes.
		var rows = panel.children;
		for (var r = 0; r < rows.length; r++) {
			if (rows[r]._myobsTimer) clearTimeout(rows[r]._myobsTimer);
			rows[r]._myobsTimer = null;
		}
		// Children first so their close hooks see a live parent.
		var children = panel._myobsChildren ? panel._myobsChildren.slice() : [];
		panel._myobsChildren = [];
		for (var i = 0; i < children.length; i++) closePanel(children[i]);
		clearRows(panel);
		panel.remove();
		if (state.rootPanel === panel) state.rootPanel = null;
		if (state.popupPanel === panel) state.popupPanel = null;
	}

	function rowsOf(panel) {
		var out = [];
		for (var i = 0; i < panel.children.length; i++) {
			var child = panel.children[i];
			if (child.classList && child.classList.contains(ROW_CLASS) && !child.hidden) out.push(child);
		}
		return out;
	}

	/*
	 * Keyboard state is ours, not the DOM's. Obsidian's Keymap.onFocusIn
	 * (app.js @ 1217269) blurs any focused element that lives outside its tab
	 * focus container, so a focused menu row loses focus on the next tick.
	 * Tracking an "active row" also matches how Obsidian's own menus work.
	 */
	function setActive(row) {
		if (state.activeRow === row) return;
		if (state.activeRow) state.activeRow.classList.remove("is-active");
		state.activeRow = row || null;
		if (!row) return;
		row.classList.add("is-active");
		var panel = row._myobsPanel;
		if (!panel) return;
		var top = row.offsetTop;
		var bottom = top + row.offsetHeight;
		if (top < panel.scrollTop) panel.scrollTop = top;
		else if (bottom > panel.scrollTop + panel.clientHeight) {
			panel.scrollTop = bottom - panel.clientHeight;
		}
	}

	// Focus is still useful for accessibility where it survives; the active
	// row class is the source of truth for key handling.
	function focusRow(row) {
		if (!row) return;
		try {
			row.focus({ preventScroll: true });
		} catch (err) {
			/* Obsidian blurs it on the next tick anyway */
		}
	}

	function focusFirst(panel) {
		var rows = rowsOf(panel);
		for (var i = 0; i < rows.length; i++) {
			if (rows[i].getAttribute("aria-disabled") !== "true") {
				setActive(rows[i]);
				focusRow(rows[i]);
				return;
			}
		}
	}

	function moveFocus(panel, delta) {
		var rows = rowsOf(panel).filter(function (row) {
			return row.getAttribute("aria-disabled") !== "true";
		});
		if (!rows.length) return;
		var index = rows.indexOf(state.activeRow);
		if (index === -1) index = delta > 0 ? -1 : 0;
		var next = (index + delta + rows.length) % rows.length;
		setActive(rows[next]);
		focusRow(rows[next]);
	}

	function syncRow(row) {
		var item = row._myobsItem;
		if (!item) return;
		row.hidden = !isVisible(item);
		row.setAttribute("aria-disabled", isEnabled(item) ? "false" : "true");
		if (isCheckable(item)) {
			row.setAttribute("aria-checked", item.checked ? "true" : "false");
			var check = row.querySelector(".myobs-menu-check");
			if (check) {
				check.textContent = item.checked ? (item.type === "radio" ? "\u25cf" : "\u2713") : "";
			}
		}
		var label = row.querySelector(".myobs-menu-label");
		if (label) label.textContent = displayLabel(item.label);
		var accel = row.querySelector(".myobs-menu-accel");
		if (accel) accel.textContent = formatAccelerator(item.accelerator);
		var arrow = row.querySelector(".myobs-menu-arrow");
		if (arrow) arrow.textContent = item.submenu && item.submenu.length ? "\u203a" : "";
		row.classList.toggle("is-checked", !!item.checked);
	}

	function pick(item, panel, row, event) {
		if (!isEnabled(item)) return;
		if (item.submenu && item.submenu.length) {
			closeSubmenu(row);
			openSubmenu(row, item, true);
			return;
		}
		// Close first: the native menu does the same, and menu-will-close
		// callbacks (Obsidian resets its internal menu state there) must run
		// before the command mutates the workspace.
		closeAll();
		try {
			runAction(item, event);
		} catch (err) {
			warn("menu action threw for " + displayLabel(item.label), err);
		}
	}

	function runAction(item, event) {
		if (typeof item.click === "function") {
			// Electron signature: (menuItem, browserWindow, event). Obsidian's
			// native-template closures wrap the event into a MouseEvent, so pass
			// a plain modifier object.
			var init = event
				? {
						metaKey: !!event.metaKey,
						ctrlKey: !!event.ctrlKey,
						shiftKey: !!event.shiftKey,
						altKey: !!event.altKey,
						button: 0
					}
				: {};
			item.click({ id: itemId(item), label: item.label, checked: item.checked }, null, init);
			return;
		}
		var id = item.appCommand || (item.role === "appCommand" ? item.id : null);
		if (!id) return;
		var app = window.app;
		if (!app || !app.commands || typeof app.commands.executeCommandById !== "function") {
			warn("app.commands is not ready; cannot run " + id);
			return;
		}
		app.commands.executeCommandById(id);
	}

	function buildPanel(doc, items, options) {
		options = options || {};
		doc = coerceDoc(doc);
		injectStyle(doc);
		var panel = make(doc, "div", PANEL_CLASS);
		panel.setAttribute("role", "menu");
		panel._myobsItems = items || [];
		panel._myobsParentRow = options.parentRow || null;
		if (options.parentRow) {
			var parentPanel = options.parentRow._myobsPanel;
			if (parentPanel) {
				parentPanel._myobsChildren = parentPanel._myobsChildren || [];
				parentPanel._myobsChildren.push(panel);
			}
		}

		var list = items || [];
		for (var i = 0; i < list.length; i++) {
			var item = list[i];
			if (!item) continue;
			if (isSeparator(item)) {
				var sep = make(doc, "div", "myobs-menu-sep");
				sep.setAttribute("role", "separator");
				sep._myobsItem = item;
				panel.appendChild(sep);
				continue;
			}
			if (!isVisible(item)) continue;

			var checkable = isCheckable(item);
			var row = make(doc, "div", ROW_CLASS);
			row.setAttribute("role", checkable ? (item.type === "radio" ? "menuitemradio" : "menuitemcheckbox") : "menuitem");
			row.setAttribute("tabindex", "-1");
			row._myobsItem = item;
			row._myobsPanel = panel;

			var check = make(doc, "span", "myobs-menu-check");
			check.setAttribute("aria-hidden", "true");
			if (!checkable) check.style.visibility = "hidden";
			row.appendChild(check);

			var label = make(doc, "span", "myobs-menu-label", displayLabel(item.label));
			row.appendChild(label);

			var accel = make(doc, "span", "myobs-menu-accel");
			if (item.accelerator) accel.textContent = formatAccelerator(item.accelerator);
			row.appendChild(accel);

			var arrow = make(doc, "span", "myobs-menu-arrow");
			if (item.submenu && item.submenu.length) arrow.textContent = "\u203a";
			row.appendChild(arrow);

			syncRow(row);
			state.rows.push({ el: row, item: item, panel: panel });

			row.addEventListener("mouseenter", guard("row hover", onRowEnter));
			row.addEventListener("click", guard("row click", onRowClick));
			panel.appendChild(row);
		}

		return panel;
	}

	function onRowEnter(event) {
		var row = event.currentTarget;
		var panel = row._myobsPanel;
		var item = row._myobsItem;
		if (!panel || !item) return;
		// Keep the keyboard position in sync with the pointer, like a native menu.
		setActive(row);
		var siblings = panel.querySelectorAll("." + ROW_CLASS);
		for (var i = 0; i < siblings.length; i++) {
			if (siblings[i] !== row && siblings[i]._myobsSubmenu) closeSubmenu(siblings[i]);
		}
		if (!row._myobsSubmenu) {
			row._myobsTimer = setTimeout(function () {
				row._myobsTimer = null;
				openSubmenu(row, item, false);
			}, 140);
		}
	}

	function onRowClick(event) {
		var row = event.currentTarget;
		if (row.getAttribute("aria-disabled") === "true") {
			event.preventDefault();
			return;
		}
		pick(row._myobsItem, row._myobsPanel, row, event);
	}

	/*
	 * One key handler for the whole menu tree. It is registered on the document
	 * at load time (before Obsidian's keymap) and only does anything while a
	 * menu is open, so it can stop the event before the workspace reacts.
	 */
	function onDocKey(event) {
		var key = event.key;
		if (key === "Alt" && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
			if (!event.repeat) state.altPending = true;
			return;
		}
		state.altPending = false;
		if (key === "F10" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
			event.preventDefault();
			event.stopImmediatePropagation();
			if (event.repeat) return;
			if (state.barVisible) closeAll(true, "keyboard-toggle");
			else showBar(true);
			return;
		}
		if (!state.rootPanel && !state.popupPanel) {
			if (state.barVisible) onBarKeyDown(event);
			return;
		}
		var handled =
			key === "Escape" ||
			key === "Tab" ||
			key === "ArrowDown" ||
			key === "ArrowUp" ||
			key === "ArrowLeft" ||
			key === "ArrowRight" ||
			key === "Home" ||
			key === "End" ||
			key === "Enter" ||
			key === " ";
		if (!handled) return;
		event.preventDefault();
		event.stopPropagation();
		if (event.stopImmediatePropagation) event.stopImmediatePropagation();

		if (key === "Escape") {
			closeAll(true);
			return;
		}
		if (key === "Tab") {
			closeAll();
			return;
		}
		var row = state.activeRow;
		var panel = row && row._myobsPanel ? row._myobsPanel : state.rootPanel || state.popupPanel;
		if (!panel) {
			closeAll();
			return;
		}
		if (!row || row._myobsPanel !== panel) {
			var rows = rowsOf(panel);
			if (rows.length) {
				row = rows[0];
				setActive(row);
			}
		}
		if (key === "ArrowDown") {
			moveFocus(panel, 1);
		} else if (key === "ArrowUp") {
			moveFocus(panel, -1);
		} else if (key === "Home") {
			var first = rowsOf(panel);
			if (first.length) {
				setActive(first[0]);
				focusRow(first[0]);
			}
		} else if (key === "End") {
			var all = rowsOf(panel);
			if (all.length) {
				setActive(all[all.length - 1]);
				focusRow(all[all.length - 1]);
			}
		} else if (key === "ArrowRight") {
			if (row && row._myobsItem && row._myobsItem.submenu && row._myobsItem.submenu.length) {
				closeSubmenu(row);
				openSubmenu(row, row._myobsItem, true);
			} else if (panel === state.popupPanel) {
				closeAll();
			} else {
				openTop(state.openTopIndex + 1, true);
			}
		} else if (key === "ArrowLeft") {
			var parentRow = panel._myobsParentRow;
			if (parentRow) {
				var parentPanel = parentRow._myobsPanel;
				closePanel(panel);
				if (parentPanel) {
					setActive(parentRow);
					focusRow(parentRow);
				}
			} else if (panel === state.popupPanel) {
				closeAll();
			} else {
				openTop(state.openTopIndex - 1, true);
			}
		} else if (key === "Enter" || key === " ") {
			if (row) {
				onRowClick({
					currentTarget: row,
					preventDefault: function () {},
					metaKey: event.metaKey,
					ctrlKey: event.ctrlKey,
					shiftKey: event.shiftKey,
					altKey: event.altKey
				});
			}
		}
	}

	// ------------------------------------------------------------------
	// Application menu bar
	// ------------------------------------------------------------------

	function barItems() {
		var items = state.template || [];
		var out = [];
		for (var i = 0; i < items.length; i++) {
			if (!items[i] || isSeparator(items[i]) || !isVisible(items[i])) continue;
			out.push(items[i]);
		}
		return out;
	}

	function ensureBar() {
		var doc = document;
		if (!doc.body) return null;
		injectStyle(doc);
		var bar = doc.querySelector("." + BAR_CLASS);
		if (!bar) {
			bar = make(doc, "div", BAR_CLASS);
			bar.id = "myobs-application-menu";
			bar.hidden = true;
			bar.setAttribute("role", "menubar");
			bar.setAttribute("aria-label", "功能選單");
			bar.setAttribute("data-myobs-menubar", "1");
			doc.body.appendChild(bar);
		}
		state.barEl = bar;
		state.barDoc = doc;
		if (!state.toggleEl) {
			var toggle = make(doc, "button", "clickable-icon myobs-menu-toggle");
			toggle.type = "button";
			toggle.setAttribute("aria-label", "功能選單");
			toggle.title = "功能選單（F10 / Alt）";
			toggle.setAttribute("aria-expanded", "false");
			toggle.setAttribute("aria-controls", bar.id);
			var svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("viewBox", "0 0 24 24");
			svg.setAttribute("fill", "none");
			svg.setAttribute("stroke", "currentColor");
			svg.setAttribute("stroke-width", "2");
			svg.setAttribute("stroke-linecap", "round");
			svg.setAttribute("aria-hidden", "true");
			var lines = doc.createElementNS("http://www.w3.org/2000/svg", "path");
			lines.setAttribute("d", "M4 6h16M4 12h16M4 18h16");
			svg.appendChild(lines);
			toggle.appendChild(svg);
			toggle.addEventListener("mousedown", function () {
				if (!state.barVisible) state.returnFocus = doc.activeElement;
			});
			toggle.addEventListener("click", guard("toggle", function (event) {
				event.preventDefault();
				if (state.barVisible) closeAll(true, "toggle");
				else showBar(false);
			}));
			state.toggleEl = toggle;
			mountToggle(50);
		}
		return bar;
	}

	function mountToggle(retries) {
		if (!state.toggleEl || !document.body) return;
		if (state.mountTimer) clearTimeout(state.mountTimer);
		state.mountTimer = null;
		var ribbon = document.querySelector(".workspace-ribbon.mod-primary, .side-dock-ribbon.mod-primary");
		var actions = ribbon && ribbon.querySelector(".side-dock-actions");
		if (!state.mountObserver && typeof MutationObserver === "function") {
			state.mountObserver = new MutationObserver(guard("ribbon visibility", function () { mountToggle(0); }));
		}
		if (state.mountObserver) {
			// Observe only the shell, not its note tree: ribbon visibility must
			// preserve the entry point without reacting to every editor change.
			var options = { childList: true, attributes: true, attributeFilter: ["class", "style"] };
			state.mountObserver.observe(document.body, options);
			var container = document.querySelector(".app-container");
			if (container) state.mountObserver.observe(container, options);
			if (ribbon) state.mountObserver.observe(ribbon, { childList: true, attributes: true, attributeFilter: ["class", "style"] });
		}
		var visible = actions && actions.getBoundingClientRect().width > 0;
		if (visible) {
			if (state.toggleEl.parentElement !== actions) actions.insertBefore(state.toggleEl, actions.firstChild);
			state.toggleEl.classList.remove("is-floating");
		} else {
			if (state.toggleEl.parentElement !== document.body) document.body.appendChild(state.toggleEl);
			state.toggleEl.classList.add("is-floating");
			// The renderer sends its template before building the ribbon.
			if (retries > 0) state.mountTimer = setTimeout(function () { mountToggle(retries - 1); }, 200);
		}
		if (state.barVisible) placeBar();
	}

	function placeBar() {
		var bar = state.barEl;
		if (!bar || bar.hidden) return;
		var rect = state.toggleEl.getBoundingClientRect();
		var width = document.documentElement.clientWidth;
		var height = document.documentElement.clientHeight;
		bar.style.maxWidth = Math.max(0, width - 12) + "px";
		var beside = !state.toggleEl.classList.contains("is-floating") && rect.right + bar.offsetWidth + 12 <= width;
		var left = beside ? rect.right + 6 : Math.min(rect.left, width - bar.offsetWidth - 6);
		var top = beside ? rect.top : rect.bottom + 6;
		if (top + bar.offsetHeight > height - 6) top = rect.top - bar.offsetHeight - 6;
		bar.style.left = Math.max(6, left) + "px";
		bar.style.top = Math.max(6, Math.min(top, height - bar.offsetHeight - 6)) + "px";
	}

	function showBar(focusFirstButton) {
		if (!ensureBar() || !state.barButtons.length) return;
		if (!state.barVisible && (!state.returnFocus || state.returnFocus === state.toggleEl)) {
			state.returnFocus = document.activeElement;
		}
		mountToggle(0);
		state.barVisible = true;
		state.barEl.hidden = false;
		state.toggleEl.setAttribute("aria-expanded", "true");
		placeBar();
		attachDismissHandlers(document);
		if (focusFirstButton) focusBarButton(0);
	}

	function focusBarButton(index) {
		if (!state.barButtons.length) return;
		index = (index + state.barButtons.length) % state.barButtons.length;
		state.focusTopIndex = index;
		var button = state.barButtons[index];
		button.scrollIntoView({ block: "nearest", inline: "nearest" });
		focusRow(button);
	}

	function renderBar() {
		var bar = ensureBar();
		if (!bar) return;
		var doc = bar.ownerDocument;
		while (bar.firstChild) bar.removeChild(bar.firstChild);
		state.barButtons = [];
		var items = barItems();
		state.toggleEl.hidden = items.length === 0;
		for (var i = 0; i < items.length; i++) {
			(function (item, index) {
				var button = make(doc, "button", BAR_ITEM_CLASS, displayLabel(item.label));
				button.type = "button";
				button.setAttribute("role", "menuitem");
				button.setAttribute("aria-haspopup", "true");
				button.setAttribute("aria-expanded", "false");
				button.setAttribute("data-myobs-top", String(index));
				button.addEventListener("click", guard("bar click", function (event) {
					event.preventDefault();
					if (state.openTopIndex === index) closeAll(true);
					else openTop(index, false);
				}));
				button.addEventListener("mouseenter", guard("bar hover", function () {
					if (state.openTopIndex >= 0 && state.openTopIndex !== index) openTop(index, false);
				}));
				bar.appendChild(button);
				state.barButtons.push(button);
			})(items[i], i);
		}
		if (state.openTopIndex >= 0) openTop(Math.min(state.openTopIndex, items.length - 1), true);
	}

	function onBarKeyDown(event) {
		var key = event.key;
		var handled = ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "Escape", "Tab"].indexOf(key) !== -1;
		if (!handled) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		var index = state.barButtons.indexOf(event.target);
		if (index < 0) index = state.focusTopIndex || 0;
		if (key === "ArrowRight" || key === "ArrowLeft") {
			event.preventDefault();
			if (!state.barButtons.length) return;
			var delta = key === "ArrowRight" ? 1 : -1;
			var next = (index + delta + state.barButtons.length) % state.barButtons.length;
			focusBarButton(next);
			if (state.openTopIndex >= 0) openTop(next, true);
		} else if (key === "Home" || key === "End") {
			focusBarButton(key === "Home" ? 0 : state.barButtons.length - 1);
		} else if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
			event.preventDefault();
			openTop(index >= 0 ? index : 0, true);
		} else if (key === "Escape" || key === "Tab") {
			event.preventDefault();
			closeAll(true);
		}
	}

	function openTop(index, focusFirstRow) {
		var items = barItems();
		if (!items.length) return;
		if (index < 0) index = items.length - 1;
		if (index >= items.length) index = 0;
		var item = items[index];
		var button = state.barButtons[index];
		if (!button) return;
		if (!state.barVisible) showBar(false);
		if (!item.submenu || !item.submenu.length) {
			// A top-level item with no submenu behaves like a command.
			closeAll();
			try {
				runAction(item, null);
			} catch (err) {
				warn("top-level action threw", err);
			}
			return;
		}
		if (state.openTopIndex === index && state.rootPanel) {
			if (focusFirstRow) focusFirst(state.rootPanel);
			return;
		}
		closeAll(false, "switch-top", true);
		focusBarButton(index);
		var doc = button.ownerDocument;
		var panel = buildPanel(doc, item.submenu, { root: true });
		doc.body.appendChild(panel);
		var rect = button.getBoundingClientRect();
		placePanel(doc, panel, rect.left, rect.bottom + 1);
		panel._myobsTopIndex = index;
		state.rootPanel = panel;
		state.openTopIndex = index;
		state.focusTopIndex = index;
		button.classList.add("is-open");
		button.setAttribute("aria-expanded", "true");
		attachDismissHandlers(doc);
		// Obsidian calls preventDefault() on mousedown, so a click does not focus
		// the button. Drive focus ourselves or every arrow key lands on <body>
		// and the bar never sees a keydown.
		focusRow(button);
		focusFirst(panel);
	}

	function setTopClosed() {
		state.openTopIndex = -1;
		if (state.barButtons) {
			for (var i = 0; i < state.barButtons.length; i++) {
				state.barButtons[i].classList.remove("is-open");
				state.barButtons[i].setAttribute("aria-expanded", "false");
			}
		}
	}

	// ------------------------------------------------------------------
	// Popup at cursor (render-menu) and the native-template fallback
	// ------------------------------------------------------------------

	function popupAt(items, x, y, closeHook) {
		var doc = activeDoc();
		injectStyle(doc);
		var returnFocus = doc.activeElement;
		closeAll();
		state.returnFocus = returnFocus;
		var panel = buildPanel(doc, items, { root: true });
		doc.body.appendChild(panel);
		placePanel(doc, panel, x, y);
		state.popupPanel = panel;
		state.popupClose = closeHook || null;
		panel._myobsPopup = true;
		attachDismissHandlers(doc);
		focusFirst(panel);
		return panel;
	}

	function renderMenuAtCursor() {
		if (!state.template || !state.template.length) return;
		popupAt(state.template, state.pointer.x, state.pointer.y, null);
	}

	function popupTemplate(template, options, closeHook) {
		try {
			var opts = options || {};
			var scale = 1;
			try {
				var electron = window.__MYOBS_MODULES && window.__MYOBS_MODULES.electron;
				if (electron && electron.webFrame && typeof electron.webFrame.getZoomFactor === "function") {
					scale = electron.webFrame.getZoomFactor() || 1;
				}
			} catch (err) {
				scale = 1;
			}
			// Electron popup coordinates are DIP; this DOM is in (possibly zoomed)
			// CSS pixels. showAtPosition() multiplies by 1.2^zoomLevel before
			// popup(), so undo that here.
			var x = typeof opts.x === "number" ? opts.x / scale : state.pointer.x;
			var y = typeof opts.y === "number" ? opts.y / scale : state.pointer.y;
			state.lastPopup = { x: x, y: y, count: (template || []).length, at: Date.now() };
			return popupAt(template || [], x, y, closeHook);
		} catch (err) {
			warn("popup failed", err);
			// Still fire the close hook: the caller registered menu-will-close and
			// would otherwise keep its own state marked as "menu open".
			if (typeof closeHook === "function") {
				try {
					closeHook();
				} catch (ignored) {
					/* nothing left to do */
				}
			}
			return null;
		}
	}

	// ------------------------------------------------------------------
	// Dismissal
	// ------------------------------------------------------------------

	function attachDismissHandlers(doc) {
		removeDismissHandlers();
		var win = docWindow(doc);
		var onDown = guard("outside click", function (event) {
			var target = event.target;
			if (!target) return;
			if (state.toggleEl && state.toggleEl.contains(target)) return;
			if (state.barEl && state.barEl.contains(target)) return;
			var panels = doc.querySelectorAll("." + PANEL_CLASS);
			for (var i = 0; i < panels.length; i++) {
				if (panels[i].contains(target)) return;
			}
			closeAll(false, "outside-mousedown");
		});
		var onResize = guard("resize", function () {
			closeAll(false, "resize");
		});
		var onScroll = guard("scroll", function (event) {
			var target = event.target;
			if (target && target.closest && target.closest("." + PANEL_CLASS + ", ." + BAR_CLASS)) return;
			closeAll(false, "scroll");
		});
		doc.addEventListener("mousedown", onDown, true);
		// The main document gets its key handler at install() time so it runs
		// before Obsidian's keymap. A popout document needs its own copy.
		if (doc !== document && state.keyDocs.indexOf(doc) === -1) {
			state.keyDocs.push(doc);
			doc.addEventListener("keydown", guard("keydown", onDocKey), true);
		}
		win.addEventListener("resize", onResize, true);
		doc.addEventListener("scroll", onScroll, true);
		state.listeners = { doc: doc, win: win, onDown: onDown, onResize: onResize, onScroll: onScroll };
	}

	function removeDismissHandlers() {
		var l = state.listeners;
		if (!l) return;
		try {
			l.doc.removeEventListener("mousedown", l.onDown, true);
			l.doc.removeEventListener("scroll", l.onScroll, true);
			l.win.removeEventListener("resize", l.onResize, true);
		} catch (err) {
			/* document may be gone */
		}
		state.listeners = null;
	}

	function closeAll(refocusBar, reason, keepBar) {
		if (state.rootPanel || state.popupPanel || state.barVisible) {
			state.lastClose = { reason: reason || "explicit", at: Date.now() };
		}
		var returnFocus = state.returnFocus;
		var popup = state.popupPanel;
		var hook = state.popupClose;
		state.popupClose = null;
		var root = state.rootPanel;
		if (root) closePanel(root);
		state.rootPanel = null;
		if (popup && popup !== root) closePanel(popup);
		state.popupPanel = null;
		removeDismissHandlers();
		setTopClosed();
		if (!keepBar) {
			state.barVisible = false;
			if (state.barEl) state.barEl.hidden = true;
			if (state.toggleEl) state.toggleEl.setAttribute("aria-expanded", "false");
			state.returnFocus = null;
		}
		if (hook) {
			try {
				hook();
			} catch (err) {
				warn("popup close hook threw", err);
			}
		}
		if (refocusBar) {
			if (returnFocus && returnFocus.isConnected && returnFocus !== document.body) focusRow(returnFocus);
			else if (state.toggleEl) focusRow(state.toggleEl);
		}
	}

	// ------------------------------------------------------------------
	// update-menu-items
	// ------------------------------------------------------------------

	function applyMenuItems(updates) {
		state.lastUpdate = updates || null;
		if (!state.template || !updates || !updates.length) return;
		var byId = Object.create(null);
		(function walk(items) {
			for (var i = 0; i < items.length; i++) {
				var item = items[i];
				if (!item) continue;
				var id = itemId(item);
				if (id) byId[id] = item;
				if (item.submenu) walk(item.submenu);
			}
		})(state.template);
		var touched = false;
		for (var i = 0; i < updates.length; i++) {
			var update = updates[i];
			if (!update || !update.itemId) continue;
			var item = byId[String(update.itemId)];
			if (!item) continue;
			var eState = update.eState || {};
			for (var key in eState) {
				if (!Object.prototype.hasOwnProperty.call(eState, key)) continue;
				// `sharingItem` is a macOS share-menu payload; keep it on the model
				// so nothing is lost, it is simply not rendered.
				item[key] = eState[key];
			}
			touched = true;
		}
		if (!touched) return;
		// While a menu is open the rows hold live references to the model, so a
		// sync is enough — no rebuild, no lost submenu state.
		if (state.rootPanel || state.popupPanel) {
			for (var r = 0; r < state.rows.length; r++) {
				try {
					syncRow(state.rows[r].el);
				} catch (err) {
					warn("row sync failed", err);
				}
			}
		}
	}

	// ------------------------------------------------------------------
	// context-menu reply
	// ------------------------------------------------------------------

	function isEditableElement(el) {
		if (!el || el.nodeType !== 1) return false;
		try {
			if (el.isContentEditable) return true;
			var tag = (el.tagName || "").toLowerCase();
			if (tag === "textarea") return !el.disabled && !el.readOnly;
			if (tag === "input") {
				var type = (el.type || "text").toLowerCase();
				var textual = ["text", "search", "url", "tel", "email", "password", "number", "date", "datetime-local", "month", "time", "week"].indexOf(type) !== -1;
				return textual && !el.disabled && !el.readOnly;
			}
			if (el.closest && el.closest(".cm-content, .cm-editor")) return true;
		} catch (err) {
			return false;
		}
		return false;
	}

	function buildContextReply() {
		var doc = activeDoc();
		var win = docWindow(doc);
		var flags = {
			canUndo: false,
			canRedo: false,
			canCut: false,
			canCopy: false,
			canPaste: false,
			canDelete: false,
			canSelectAll: true,
			canEditRichly: false
		};
		var editable = false;
		var text = "";
		try {
			var active = doc.activeElement;
			editable = isEditableElement(active);
			var selection = win.getSelection ? win.getSelection() : null;
			text = selection ? String(selection) : "";
			if (!text && active && typeof active.value === "string") {
				try {
					text = String(active.value).slice(active.selectionStart || 0, active.selectionEnd || 0);
				} catch (err) {
					text = "";
				}
			}
		} catch (err) {
			/* a missing selection is not an error */
		}
		flags.canCopy = text.length > 0;
		flags.canCut = editable && text.length > 0;
		flags.canDelete = editable && text.length > 0;
		flags.canPaste = editable;
		flags.canUndo = editable;
		flags.canRedo = editable;
		flags.canEditRichly = editable;
		var reply = {
			editFlags: flags,
			misspelledWord: "",
			dictionarySuggestions: [],
			webContentsId: 1
		};
		state.lastContextReply = reply;
		return reply;
	}

	// ------------------------------------------------------------------
	// IPC wiring
	// ------------------------------------------------------------------

	function withApp(retries) {
		if (!state.template || !state.template.length) return;
		if (window.app) {
			try {
				renderBar();
			} catch (err) {
				warn("bar render failed", err);
			}
			return;
		}
		if (retries <= 0) return;
		setTimeout(function () {
			withApp(retries - 1);
		}, 100);
	}

	function setTemplate(template) {
		state.template = Array.isArray(template) ? template : [];
		// A new template invalidates every row that referenced the old one.
		closeAll(false, "set-menu");
		if (state.template.length) withApp(200);
		else if (state.barEl) renderBar();
	}

	function updateMenuItems(updates) {
		applyMenuItems(updates);
	}

	/*
	 * These channels are renderer -> main in Electron: `set-menu`,
	 * `update-menu-items` and `render-menu` are sent by app.js and handled by
	 * main.js. There is no reply, so ipcRenderer.on() for them would never fire.
	 * electron-shim's send() calls these three functions directly; that is the
	 * real seam. The only genuine reply channel is `context-menu`, and the shim
	 * asks buildContextReply() for it.
	 */
	function install() {
		document.addEventListener("keydown", guard("keydown", onDocKey), true);
		function cancelAltGesture() { state.altPending = false; }
		document.addEventListener("pointerdown", cancelAltGesture, true);
		document.addEventListener("mousedown", cancelAltGesture, true);
		document.addEventListener("keyup", guard("alt keyup", function (event) {
			if (event.key !== "Alt" || !state.altPending) return;
			state.altPending = false;
			event.preventDefault();
			event.stopImmediatePropagation();
			if (state.barVisible) closeAll(true, "alt-toggle");
			else showBar(true);
		}), true);
		window.addEventListener("blur", function () {
			state.altPending = false;
			closeAll(false, "window-blur");
		});
		window.addEventListener("resize", guard("toggle placement", function () { mountToggle(0); }));
		document.addEventListener(
			"pointermove",
			function (event) {
				state.pointer.x = event.clientX;
				state.pointer.y = event.clientY;
			},
			{ capture: true, passive: true }
		);
		return true;
	}

	// ------------------------------------------------------------------
	// Public surface (also the seam the shim and tools/menu-check.mjs use)
	// ------------------------------------------------------------------

	var api = {
		installed: false,
		source: "html",
		version: 1,
		reason: null,
		// Test/debug helpers
		getTemplate: function () {
			return state.template;
		},
		getBarLabels: function () {
			var out = [];
			for (var i = 0; i < state.barButtons.length; i++) out.push(state.barButtons[i].textContent);
			return out;
		},
		isOpen: function () {
			return !!(state.rootPanel || state.popupPanel);
		},
		showBar: function () { showBar(true); },
		hideBar: function () { closeAll(true); },
		isBarVisible: function () { return state.barVisible; },
		getActiveRow: function () {
			var row = state.activeRow;
			if (!row) return null;
			var label = row.querySelector(".myobs-menu-label");
			return label ? label.textContent : row.textContent;
		},
		openTop: function (index) {
			openTop(index, false);
			return state.rootPanel;
		},
		close: function () {
			closeAll();
		},
		renderMenuAtCursor: renderMenuAtCursor,
		setTemplate: setTemplate,
		updateMenuItems: updateMenuItems,
		popupTemplate: popupTemplate,
		buildContextReply: buildContextReply,
		getLastContextReply: function () {
			return state.lastContextReply;
		},
		getLastPopup: function () {
			return state.lastPopup;
		},
		getLastClose: function () {
			return state.lastClose;
		},
		getLastUpdate: function () {
			return state.lastUpdate;
		},
		getState: function () {
			return {
				top: state.openTopIndex,
				rows: state.rows.length,
				barItems: state.barButtons.length,
				barVisible: state.barVisible,
				template: state.template ? state.template.length : 0
			};
		}
	};

	window.__MYOBS_MENU = api;

	try {
		api.installed = install();
		if (!api.installed) api.reason = state.installError || "IPC unavailable";
	} catch (err) {
		api.installed = false;
		api.reason = err && err.message ? err.message : String(err);
		warn("install failed", err);
	}
})();
