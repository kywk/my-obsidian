/*
 * notices.js — classic script. The user-visible failure surface.
 *
 * Every failure that the operator would otherwise only find in devtools goes
 * through here: conflict copies, plugin load failures, proxy denials, watcher
 * disconnects, fs errors. DESIGN.md §5 requires conflict copies to be visible;
 * GAPS.md records that they currently are not.
 *
 * Contract (other modules may rely on this shape):
 *
 *   window.__MYOBS_NOTICES.push({
 *     level: "info" | "warn" | "error",
 *     source: string,              // "fs" | "plugin" | "proxy" | "watch" | ...
 *     message: string,             // one line, shown to the user
 *     detail?: string,             // expandable; stack traces go here
 *     dedupeKey?: string,          // repeat pushes with the same key collapse
 *     actions?: Array<{ label: string, onClick: () => void }>
 *   }) -> id: string
 *
 *   window.__MYOBS_NOTICES.dismiss(id) -> void
 *   window.__MYOBS_NOTICES.list() -> Array<notice>
 *   window.__MYOBS_NOTICES.events -> Array<{ at, action, id, ... }>   // for tests
 *   window.__MYOBS_NOTICES.enabled -> boolean                          // kill switch
 *
 * Callers must treat it as optional and never let a notice failure break the
 * calling code path: `window.__MYOBS_NOTICES?.push?.(...)`.
 *
 * Implementation notes:
 *
 * - Colours come from Obsidian's own CSS variables so themes keep working.
 *   Nothing here hard-codes a palette, and the whole stylesheet is scoped to
 *   #myobs-notices so it cannot leak into the editor.
 * - The container has pointer-events:none; only the cards opt back in. A
 *   bottom-right stack therefore never eats a click on the status bar, the
 *   sidebar, or the editor underneath it.
 * - z-index sits one above Obsidian's modal layer but below its notice/menu/
 *   tooltip layers (60/65/70) and far below the fatal overlay (2147483647).
 * - `window.__MYOBS_LAST_CONFLICT` predates this module and was the only signal
 *   fs-shim emitted for a conflict copy (GAPS.md §8). fs-shim now also pushes
 *   the card itself, with the same dedupeKey (`fs:conflict:<path>`), so the
 *   accessor below reports the conflict only when nothing else did: one
 *   conflict is one card with one count no matter which module raised it.
 *   `__MYOBS_NOTICES.consumeLastConflict = false` retires the fallback.
 */
(function () {
	"use strict";

	var INFO_MS = 8000;
	var WARN_MS = 20000;
	var EVENTS_MAX = 500;
	var MAX_ACTIONS = 2;

	var LEVELS = { info: true, warn: true, error: true };
	var ICON_NAMES = {
		info: "lucide-info",
		warn: "lucide-alert-triangle",
		error: "lucide-circle-alert"
	};
	var ICON_FALLBACK = { info: "i", warn: "!", error: "×" };

	var events = [];
	var notices = [];
	var byKey = Object.create(null);
	var seq = 0;
	var root = null;
	var styleEl = null;
	var doc = window.document;

	// ------------------------------------------------------------------
	// Small helpers
	// ------------------------------------------------------------------

	function now() {
		return Date.now();
	}

	function text(value) {
		if (value === undefined || value === null) return "";
		if (value instanceof Error) {
			return String(value.stack || value.message || value);
		}
		return String(value);
	}

	function record(action, notice, extra) {
		var entry = {
			at: now(),
			action: action,
			id: notice ? notice.id : null,
			level: notice ? notice.level : null,
			source: notice ? notice.source : null,
			message: notice ? notice.message : null,
			dedupeKey: notice ? notice.dedupeKey : null,
			count: notice ? notice.count : null
		};
		if (extra) {
			for (var key in extra) {
				if (Object.prototype.hasOwnProperty.call(extra, key)) {
					entry[key] = extra[key];
				}
			}
		}
		events.push(entry);
		if (events.length > EVENTS_MAX) {
			events.splice(0, events.length - EVENTS_MAX);
		}
	}

	function findByKey(key) {
		if (!key) return null;
		var id = byKey[key];
		if (!id) return null;
		for (var i = 0; i < notices.length; i += 1) {
			if (notices[i].id === id) return notices[i];
		}
		delete byKey[key];
		return null;
	}

	function findById(id) {
		if (id === undefined || id === null) return null;
		var wanted = String(id);
		for (var i = 0; i < notices.length; i += 1) {
			if (notices[i].id === wanted) return notices[i];
		}
		return null;
	}

	function normalize(input) {
		var source = input && typeof input === "object" ? input : {};
		var level = LEVELS[source.level] === true ? source.level : "info";
		var actions = [];
		if (Array.isArray(source.actions)) {
			for (var i = 0; i < source.actions.length && actions.length < MAX_ACTIONS; i += 1) {
				var action = source.actions[i];
				if (!action || typeof action.onClick !== "function") continue;
				actions.push({
					label: text(action.label) || "執行",
					onClick: action.onClick
				});
			}
		}
		return {
			level: level,
			source: text(source.source) || "app",
			message: text(source.message) || "（沒有訊息）",
			detail: text(source.detail),
			dedupeKey: text(source.dedupeKey) || null,
			actions: actions,
			count: 1,
			createdAt: now(),
			updatedAt: now(),
			timer: null,
			el: null,
			id: null
		};
	}

	function publicView(notice) {
		return {
			id: notice.id,
			level: notice.level,
			source: notice.source,
			message: notice.message,
			detail: notice.detail,
			dedupeKey: notice.dedupeKey,
			count: notice.count,
			createdAt: notice.createdAt,
			updatedAt: notice.updatedAt,
			actions: notice.actions.map(function (action) {
				return action.label;
			})
		};
	}

	// ------------------------------------------------------------------
	// Styles and DOM
	// ------------------------------------------------------------------

	var CSS =
		"#myobs-notices{" +
		"position:fixed;" +
		"right:calc(16px + env(safe-area-inset-right,0px));" +
		"bottom:calc(44px + env(safe-area-inset-bottom,0px));" +
		"z-index:calc(var(--layer-modal,50) + 1);" +
		"display:flex;flex-direction:column;align-items:flex-end;gap:8px;" +
		"width:min(380px,calc(100vw - 32px));" +
		"max-height:calc(100vh - 120px);overflow-y:auto;overflow-x:hidden;" +
		"pointer-events:none;" +
		'font-family:var(--font-interface,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);' +
		"}" +
		"#myobs-notices:empty{display:none;}" +
		"#myobs-notices .myobs-notice{" +
		"pointer-events:auto;box-sizing:border-box;width:100%;display:flex;" +
		"align-items:flex-start;gap:8px;padding:10px 10px 10px 11px;" +
		"border:1px solid var(--background-modifier-border);" +
		"border-left:3px solid var(--text-accent);" +
		"border-radius:var(--radius-m,8px);" +
		"background:var(--background-primary);color:var(--text-normal);" +
		"box-shadow:var(--shadow-s,0 2px 8px rgba(0,0,0,.18));" +
		"font-size:var(--font-ui-small,13px);line-height:1.45;" +
		"animation:myobs-notice-in 160ms ease-out;" +
		"}" +
		'#myobs-notices .myobs-notice[data-level="info"]{border-left-color:var(--text-accent);}' +
		'#myobs-notices .myobs-notice[data-level="warn"]{border-left-color:var(--text-warning);}' +
		'#myobs-notices .myobs-notice[data-level="error"]{' +
		"border-left-color:var(--text-error);" +
		"background:color-mix(in srgb,var(--background-modifier-error) 6%,var(--background-primary));" +
		"}" +
		"#myobs-notices .myobs-notice-icon{" +
		"flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;" +
		"width:18px;height:18px;margin-top:1px;color:var(--text-accent);" +
		"}" +
		'#myobs-notices .myobs-notice[data-level="warn"] .myobs-notice-icon{color:var(--text-warning);}' +
		'#myobs-notices .myobs-notice[data-level="error"] .myobs-notice-icon{color:var(--text-error);}' +
		"#myobs-notices .myobs-notice-icon svg{width:16px;height:16px;}" +
		"#myobs-notices .myobs-notice-icon-fallback{" +
		"width:14px;height:14px;border:1.5px solid currentColor;border-radius:50%;" +
		"font-size:10px;font-weight:700;line-height:14px;text-align:center;" +
		"}" +
		"#myobs-notices .myobs-notice-body{flex:1 1 auto;min-width:0;}" +
		"#myobs-notices .myobs-notice-message{" +
		"margin:0;color:var(--text-normal);white-space:pre-wrap;overflow-wrap:anywhere;" +
		"}" +
		"#myobs-notices .myobs-notice-meta{" +
		"display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:2px;" +
		"color:var(--text-muted);font-size:var(--font-ui-smaller,11px);" +
		"}" +
		"#myobs-notices .myobs-notice-count{" +
		"border-radius:var(--radius-s,4px);background:var(--background-modifier-hover);" +
		"padding:0 5px;font-variant-numeric:tabular-nums;" +
		"}" +
		"#myobs-notices .myobs-notice-detail{margin-top:4px;}" +
		"#myobs-notices .myobs-notice-detail summary{" +
		"cursor:pointer;color:var(--text-muted);font-size:var(--font-ui-smaller,11px);" +
		"user-select:none;" +
		"}" +
		"#myobs-notices .myobs-notice-detail pre{" +
		"margin:6px 0 0;padding:8px;max-height:180px;overflow:auto;" +
		"background:var(--background-secondary);border-radius:var(--radius-s,4px);" +
		"color:var(--text-muted);font-family:var(--font-monospace);" +
		"font-size:var(--font-ui-smaller,11px);line-height:1.4;" +
		"white-space:pre-wrap;word-break:break-word;user-select:text;" +
		"}" +
		"#myobs-notices .myobs-notice-actions{" +
		"display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;" +
		"}" +
		"#myobs-notices .myobs-notice-action{" +
		"font:inherit;font-size:var(--font-ui-smaller,11px);line-height:1.2;" +
		"padding:4px 10px;border-radius:var(--radius-s,4px);" +
		"border:1px solid var(--background-modifier-border);" +
		"background:var(--interactive-normal);color:var(--text-normal);cursor:pointer;" +
		"}" +
		"#myobs-notices .myobs-notice-action:hover{background:var(--interactive-hover);}" +
		"#myobs-notices .myobs-notice-close{" +
		"flex:0 0 auto;border:0;background:transparent;color:var(--text-muted);" +
		"cursor:pointer;font:inherit;font-size:16px;line-height:1;padding:0 2px;" +
		"margin-left:2px;border-radius:var(--radius-s,4px);" +
		"}" +
		"#myobs-notices .myobs-notice-close:hover{" +
		"color:var(--text-normal);background:var(--background-modifier-hover);" +
		"}" +
		"@keyframes myobs-notice-in{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}" +
		"@media (prefers-reduced-motion:reduce){#myobs-notices .myobs-notice{animation:none;}}" +
		"@media print{#myobs-notices{display:none !important;}}";

	function ensureStyle() {
		if (styleEl || !doc) return;
		try {
			styleEl = doc.createElement("style");
			styleEl.id = "myobs-notices-style";
			styleEl.textContent = CSS;
			(doc.head || doc.documentElement).appendChild(styleEl);
		} catch (err) {
			styleEl = null;
		}
	}

	function ensureRoot() {
		if (root && root.parentNode) return root;
		if (!doc) return null;
		try {
			root = doc.createElement("div");
			root.id = "myobs-notices";
			root.className = "myobs-notices";
			root.setAttribute("role", "region");
			root.setAttribute("aria-label", "my-obsidian 通知");
			root.setAttribute("aria-live", "polite");
			(doc.body || doc.documentElement).appendChild(root);
			return root;
		} catch (err) {
			root = null;
			return null;
		}
	}

	function buildIcon(level) {
		var icon = doc.createElement("span");
		icon.className = "myobs-notice-icon";
		icon.setAttribute("aria-hidden", "true");
		try {
			if (typeof window.setIcon === "function") {
				window.setIcon(icon, ICON_NAMES[level] || ICON_NAMES.info);
				if (icon.firstChild) return icon;
			}
		} catch (err) {
			// setIcon arrives with app.js; fall through to the glyph.
		}
		var glyph = doc.createElement("span");
		glyph.className = "myobs-notice-icon-fallback";
		glyph.textContent = ICON_FALLBACK[level] || ICON_FALLBACK.info;
		icon.appendChild(glyph);
		return icon;
	}

	function createCard(notice) {
		var card = doc.createElement("article");
		card.className = "myobs-notice myobs-notice-" + notice.level;
		card.setAttribute("data-id", notice.id);
		card.setAttribute("data-level", notice.level);
		card.setAttribute("data-source", notice.source);
		card.setAttribute("data-count", String(notice.count));
		card.setAttribute("role", "status");

		card.appendChild(buildIcon(notice.level));

		var body = doc.createElement("div");
		body.className = "myobs-notice-body";

		var message = doc.createElement("p");
		message.className = "myobs-notice-message";
		message.textContent = notice.message;
		body.appendChild(message);

		var meta = doc.createElement("div");
		meta.className = "myobs-notice-meta";
		var source = doc.createElement("span");
		source.className = "myobs-notice-source";
		source.textContent = notice.source;
		meta.appendChild(source);
		var count = doc.createElement("span");
		count.className = "myobs-notice-count";
		count.textContent = "×" + notice.count;
		meta.appendChild(count);
		body.appendChild(meta);

		var details = doc.createElement("details");
		details.className = "myobs-notice-detail";
		var summary = doc.createElement("summary");
		summary.textContent = "詳細資料";
		details.appendChild(summary);
		var pre = doc.createElement("pre");
		details.appendChild(pre);
		details.addEventListener("toggle", function () {
			// Reading a detail block should not race a timer that removes it.
			if (details.open) clearTimer(notice);
			else armTimer(notice);
		});
		body.appendChild(details);

		var actions = doc.createElement("div");
		actions.className = "myobs-notice-actions";
		body.appendChild(actions);

		card.appendChild(body);

		var close = doc.createElement("button");
		close.type = "button";
		close.className = "myobs-notice-close";
		close.setAttribute("aria-label", "關閉通知");
		close.title = "關閉";
		close.textContent = "×";
		close.addEventListener("click", function (event) {
			event.preventDefault();
			event.stopPropagation();
			dismiss(notice.id);
		});
		card.appendChild(close);

		notice.el = card;
		notice.parts = {
			message: message,
			count: count,
			source: source,
			details: details,
			pre: pre,
			actions: actions
		};
		renderDetails(notice);
		renderActions(notice);
		return card;
	}

	function renderDetails(notice) {
		var parts = notice.parts;
		if (!parts) return;
		var hasDetail = notice.detail !== "";
		parts.details.hidden = !hasDetail;
		parts.pre.textContent = hasDetail ? notice.detail : "";
	}

	function renderActions(notice) {
		var parts = notice.parts;
		if (!parts) return;
		while (parts.actions.firstChild) {
			parts.actions.removeChild(parts.actions.firstChild);
		}
		if (notice.actions.length === 0) {
			parts.actions.hidden = true;
			return;
		}
		parts.actions.hidden = false;
		for (var i = 0; i < notice.actions.length; i += 1) {
			(function (action) {
				var button = doc.createElement("button");
				button.type = "button";
				button.className = "myobs-notice-action";
				button.textContent = action.label;
				button.addEventListener("click", function (event) {
					event.preventDefault();
					event.stopPropagation();
					runAction(notice, action);
				});
				parts.actions.appendChild(button);
			})(notice.actions[i]);
		}
	}

	function renderCard(notice) {
		var parts = notice.parts;
		if (!parts || !notice.el) return;
		parts.message.textContent = notice.message;
		parts.source.textContent = notice.source;
		parts.count.textContent = "×" + notice.count;
		parts.count.hidden = notice.count < 2;
		notice.el.setAttribute("data-count", String(notice.count));
		renderDetails(notice);
		renderActions(notice);
	}

	// ------------------------------------------------------------------
	// Timers and lifecycle
	// ------------------------------------------------------------------

	function clearTimer(notice) {
		if (notice.timer) {
			clearTimeout(notice.timer);
			notice.timer = null;
		}
	}

	function armTimer(notice) {
		clearTimer(notice);
		if (notice.level === "error") return;
		if (notice.parts && notice.parts.details && notice.parts.details.open) return;
		var delay = notice.level === "warn" ? WARN_MS : INFO_MS;
		notice.timer = setTimeout(function () {
			notice.timer = null;
			dismissInternal(notice, "auto");
		}, delay);
	}

	function dismissInternal(notice, reason) {
		clearTimer(notice);
		var index = notices.indexOf(notice);
		if (index !== -1) notices.splice(index, 1);
		if (notice.dedupeKey && byKey[notice.dedupeKey] === notice.id) {
			delete byKey[notice.dedupeKey];
		}
		if (notice.el && notice.el.parentNode) {
			notice.el.parentNode.removeChild(notice.el);
		}
		notice.el = null;
		notice.parts = null;
		record(reason === "auto" ? "auto-dismiss" : "dismiss", notice, {
			reason: reason
		});
	}

	function runAction(notice, action) {
		record("action", notice, { label: action.label });
		try {
			action.onClick();
		} catch (err) {
			try {
				push({
					level: "error",
					source: "notice",
					message: "通知動作失敗：" + text(err && err.message ? err.message : err),
					detail: text(err && err.stack ? err.stack : err),
					dedupeKey: "notice-action:" + notice.id
				});
			} catch (ignored) {
				// The caller's failure path already ran; never escalate further.
			}
		}
	}

	// ------------------------------------------------------------------
	// Public API
	// ------------------------------------------------------------------

	function push(input) {
		var id = null;
		try {
			var notice = normalize(input);
			if (api.enabled === false) {
				record("push", notice, { suppressed: true });
				return null;
			}

			var existing = findByKey(notice.dedupeKey);
			if (existing) {
				existing.count += 1;
				existing.updatedAt = now();
				// The newest text wins: a repeated failure often names a new
				// conflict copy or a different error message.
				existing.message = notice.message;
				existing.detail = notice.detail;
				existing.actions = notice.actions;
				renderCard(existing);
				armTimer(existing);
				record("dedupe", existing);
				return existing.id;
			}

			notice.id = "myobs-notice-" + (++seq);
			notices.push(notice);
			if (notice.dedupeKey) byKey[notice.dedupeKey] = notice.id;

			ensureStyle();
			var host = ensureRoot();
			if (!host) {
				// No DOM (exotic embedding): the event log is still useful.
				record("push", notice, { attached: false });
				return notice.id;
			}
			host.appendChild(createCard(notice));
			renderCard(notice);
			armTimer(notice);
			record("push", notice);
			return notice.id;
		} catch (err) {
			// A notice must never be the reason a write/load path fails.
			try {
				record("error", null, {
					error: text(err && err.message ? err.message : err)
				});
			} catch (ignored) {
				// Nothing left to do.
			}
			return id;
		}
	}

	function dismiss(id) {
		try {
			var notice = findById(id);
			if (!notice) {
				record("dismiss-missing", null, { id: id === undefined ? null : String(id) });
				return;
			}
			dismissInternal(notice, "user");
		} catch (err) {
			try {
				record("error", null, {
					error: text(err && err.message ? err.message : err)
				});
			} catch (ignored) {
				// Nothing left to do.
			}
		}
	}

	function list() {
		try {
			return notices.map(publicView);
		} catch (err) {
			return [];
		}
	}

	function clear() {
		try {
			var copy = notices.slice();
			for (var i = 0; i < copy.length; i += 1) {
				dismissInternal(copy[i], "user");
			}
			record("clear", null, { remaining: notices.length });
		} catch (err) {
			// clear() is a convenience; never throw into a test teardown.
		}
	}

	var api = {
		installed: false,
		enabled: true,
		events: events,
		push: push,
		dismiss: dismiss,
		list: list,
		clear: clear,
		// The bridge below consumes fs-shim's existing signal. Set this to
		// false if fs-shim starts calling push() itself.
		consumeLastConflict: true
	};

	window.__MYOBS_NOTICES = api;

	// ------------------------------------------------------------------
	// Conflict bridge
	//
	// Rewrites that lose a race produce a conflict copy on disk; the user has
	// to be told which file and which copy (DESIGN.md §5). Two producers can
	// report it: fs-shim's `finishWrite` pushes the card itself, and this
	// bridge consumes `__MYOBS_LAST_CONFLICT`. Both are wired to the same
	// dedupeKey so a single conflict stays a single card -- see
	// `reportConflict` for why the bridge defers instead of pushing straight
	// from the setter.
	// ------------------------------------------------------------------

	function conflictKey(value) {
		var savedAs = text(value && value.conflictSavedAs);
		var path = text(value && value.path);
		return "fs:conflict:" + (path || savedAs);
	}

	/**
	 * Which card owns `key` right now, and how many reports it carries.
	 * `""` means no card yet. Used to notice a push that landed while the
	 * bridge was waiting.
	 */
	function keySignature(key) {
		var id = byKey[key];
		if (!id) return "";
		var notice = findById(id);
		return notice === null ? "" : id + ":" + notice.count;
	}

	function defer(fn) {
		if (typeof queueMicrotask === "function") queueMicrotask(fn);
		else setTimeout(fn, 0);
	}

	/**
	 * Open a vault-relative path without going through
	 * `workspace.openLinkText()`. That call falls back to
	 * `fileManager.createNewFile()` when the link does not resolve, which is
	 * exactly what happens while the vault index is still catching up with a
	 * copy the server just wrote -- it leaves a 0-byte note behind in the
	 * active file's folder. So resolve through the index only, and retry
	 * briefly: the copy reaches `app.vault` through the watch channel.
	 */
	function openVaultPath(relative, tries) {
		var app = window.app;
		if (!app || !app.vault || !app.workspace) return;
		var file = app.vault.getAbstractFileByPath(relative);
		if (
			!file &&
			app.metadataCache &&
			typeof app.metadataCache.getFirstLinkpathDest === "function"
		) {
			// The copy may have been moved since it was written.
			file = app.metadataCache.getFirstLinkpathDest(relative, "");
		}
		if (file) {
			app.workspace.getLeaf(false).openFile(file, { active: true });
			return;
		}
		if (tries <= 0) {
			push({
				level: "warn",
				source: "fs",
				message: "找不到衝突副本 " + relative + "，它可能已被移動或刪除",
				dedupeKey: "fs:conflict-missing:" + relative
			});
			return;
		}
		setTimeout(function () {
			try {
				openVaultPath(relative, tries - 1);
			} catch (err) {
				// A notice action must never throw into the app.
			}
		}, 250);
	}

	function onConflict(value) {
		if (!value || !value.conflictSavedAs) return;
		var savedAs = text(value.conflictSavedAs);
		var path = text(value.path);
		var actions = [];
		try {
			if (window.app && window.app.vault && window.app.workspace) {
				actions.push({
					label: "顯示檔案",
					onClick: function () {
						openVaultPath(savedAs, 20);
					}
				});
			}
		} catch (err) {
			actions = [];
		}

		push({
			level: "warn",
			source: "fs",
			message: "寫入衝突：外部變更與本次儲存競爭，舊版已保留為 " + savedAs,
			detail:
				"檔案：" + (path || "(未知)") + "\n" +
				"保留的副本：" + savedAs + "\n" +
				"時間：" + new Date(value.at || now()).toISOString() + "\n\n" +
				"這個副本是外部寫入者（Desktop Obsidian、Dropbox/Maestral、git 或手動編輯）" +
				"與瀏覽器寫入競爭時保留的舊版。若要找回內容，請開啟該副本。",
			dedupeKey: conflictKey(value),
			actions: actions
		});
	}

	/**
	 * Entry point for the `__MYOBS_LAST_CONFLICT` setter.
	 *
	 * The setter runs inside the failing writer's own code path, and fs-shim
	 * pushes its card synchronously right after setting the field. Waiting one
	 * microtask lets that push land first: if the same dedupeKey grew while we
	 * waited, the conflict is already on screen, so the bridge records the
	 * hand-off and adds nothing (no second card, no inflated count). A signal
	 * with no push behind it -- the fallback GAPS.md §8 describes -- still
	 * produces the card, built from the field alone.
	 */
	function reportConflict(value) {
		if (!value || !value.conflictSavedAs) return;
		var key = conflictKey(value);
		var before = keySignature(key);
		defer(function () {
			try {
				if (api.consumeLastConflict === false) return;
				if (keySignature(key) !== before) {
					record("conflict-delegated", null, { dedupeKey: key });
					return;
				}
				onConflict(value);
			} catch (err) {
				// The writer's path must not observe a notice failure.
			}
		});
	}

	function installConflictBridge() {
		try {
			var stored = window.__MYOBS_LAST_CONFLICT;
			Object.defineProperty(window, "__MYOBS_LAST_CONFLICT", {
				configurable: true,
				enumerable: true,
				get: function () {
					return stored;
				},
				set: function (value) {
					stored = value;
					// This accessor is called by fs-shim's assignment, outside any
					// try/catch of its own: it must never throw.
					try {
						reportConflict(value);
					} catch (err) {
						// Nothing to do: the writer already has the field's value.
					}
				}
			});
		} catch (err) {
			// A non-configurable global would be unusual; keep the plain field.
		}
	}

	try {
		installConflictBridge();
		api.installed = true;
	} catch (err) {
		api.reason = "install failed: " + text(err && err.message ? err.message : err);
	}
})();
