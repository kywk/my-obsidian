/*
 * platform-bridge.js — classic script, loaded before app.js.
 *
 * Obsidian 1.14.4 does not put its Platform object on `window`; the only
 * externally reachable reference is the webpack export getter
 *
 *     Object.defineProperty(exports, "Platform", { get: () => Qy })
 *
 * that app.js installs while its module graph is evaluated. Two facts make
 * the naive `Object.defineProperty(window, "Platform", ...)` trap insufficient:
 *
 *   1. The getter is defined *before* `var Qy = {...}` is assigned, so reading
 *      it at definition time returns undefined (verified against the shipped
 *      bundle).
 *   2. Nothing ever assigns `window.Platform`.
 *
 * So this module installs BOTH:
 *   - a getter/setter pair on `window.Platform` (the documented zero-patch
 *     hook, and a convenience for plugins/debugging), and
 *   - a transparent wrapper around `Object.defineProperty` that notices the
 *     export getter and re-reads it once the bundle's top-level script has
 *     finished (a microtask later).
 *
 * This is the zero-patch mechanism: vendor/obsidian/app.js stays byte
 * identical (AGENTS.md hard rule 1). When the viewport is >= 600 px nothing is
 * overridden at all — the accessors are not even installed until the first
 * width breach, so desktop/tablet behaviour is bit-for-bit the bundle's own.
 * Below 600 px the bundle's phone layout is used as a best-effort fallback;
 * phones are not a supported target (DESIGN.md §11.11).
 *
 * Contract for harnesses:
 *   window.__MYOBS_PLATFORM_BRIDGE = { installed, captured, overrides, applied, events[] }
 */
(function () {
	"use strict";

	var BREAKPOINT_PX = 600;
	var NARROW_QUERY = "(max-width: 599.98px)";
	var EVENTS_MAX = 50;

	var events = [];
	var state = {
		captured: false,
		/** @type {any} */
		platform: null,
		/** Accessors are installed lazily: on desktop the Platform object is never touched. */
		accessors: false,
		/** @type {{isPhone: boolean, isTablet: boolean} | null} */
		stored: null,
		/** Exact pre-override snapshot, restored on the way back up. */
		/** @type {null | {isPhone: boolean, isTablet: boolean, bodyPhone: boolean, bodyTablet: boolean}} */
		saved: null,
		applied: false,
	};

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

	var api = {
		installed: false,
		captured: false,
		/** @type {null | {isPhone: boolean, isTablet: boolean}} */
		overrides: null,
		applied: false,
		breakpointPx: BREAKPOINT_PX,
		events: events,
	};
	window.__MYOBS_PLATFORM_BRIDGE = api;

	/**
	 * Shape check, not identity: the object is the bundle's own literal
	 * (isPhone/isTablet data props plus canSplit/... getters).
	 *
	 * @param {unknown} value
	 * @returns {boolean}
	 */
	function looksLikePlatform(value) {
		if (!value || typeof value !== "object") return false;
		if (typeof value.isPhone !== "boolean") return false;
		if (typeof value.isMobile !== "boolean") return false;
		if (typeof value.canSplit !== "boolean") return false;
		return true;
	}

	function isNarrow() {
		return window.innerWidth < BREAKPOINT_PX;
	}

	/**
	 * Install the two accessors once. The setter keeps Obsidian's own
	 * assignments (boot-time matchMedia handler and soft-keyboard handler) in
	 * `stored`, so turning the override off restores exactly what the bundle
	 * would have had.
	 */
	function installAccessors() {
		if (state.accessors || !state.platform) return;
		var platform = state.platform;
		state.stored = {
			isPhone: Boolean(platform.isPhone),
			isTablet: Boolean(platform.isTablet),
		};
		nativeDefineProperty(platform, "isPhone", {
			configurable: true,
			enumerable: true,
			get: function () {
				return state.applied ? true : Boolean(state.stored && state.stored.isPhone);
			},
			set: function (value) {
				if (state.stored) state.stored.isPhone = Boolean(value);
			},
		});
		nativeDefineProperty(platform, "isTablet", {
			configurable: true,
			enumerable: true,
			get: function () {
				return state.applied ? false : Boolean(state.stored && state.stored.isTablet);
			},
			set: function (value) {
				if (state.stored) state.stored.isTablet = Boolean(value);
			},
		});
		state.accessors = true;
	}

	/* `obsidianBaseline` was removed deliberately: the bundle's own phone/tablet
	 * handler does not run in every boot path (observed: isTablet stays false at
	 * 1280x900 while its 600x600 media query matches). Restoring the captured
	 * pre-override values is the only exact undo. */

	/**
	 * Mirror the renderer's own body classes. `canDisplayRibbon`, `canSplit`,
	 * `canStackTabs` and `canPinSidebar` are not stored flags: app.js defines
	 * them as getters over isPhone (`!Qy.isPhone`, etc.), so overriding isPhone
	 * is sufficient and keeps their semantics authoritative.
	 *
	 * @param {{isPhone: boolean, isTablet: boolean}} flags
	 */
	function setBodyClasses(flags) {
		if (!document.body) return;
		document.body.classList.toggle("is-phone", flags.isPhone);
		document.body.classList.toggle("is-tablet", flags.isTablet);
	}

	function snapshot() {
		var platform = state.platform;
		return platform
			? {
					isPhone: platform.isPhone,
					isTablet: platform.isTablet,
					canDisplayRibbon: platform.canDisplayRibbon,
					canSplit: platform.canSplit,
					canStackTabs: platform.canStackTabs,
					canPinSidebar: platform.canPinSidebar,
				}
			: null;
	}

	function apply(reason) {
		if (!state.captured || state.applied) return;
		installAccessors();
		state.applied = true;
		api.applied = true;
		api.overrides = { isPhone: true, isTablet: false };
		state.saved = {
			isPhone: Boolean(state.stored && state.stored.isPhone),
			isTablet: Boolean(state.stored && state.stored.isTablet),
			bodyPhone: Boolean(document.body && document.body.classList.contains("is-phone")),
			bodyTablet: Boolean(document.body && document.body.classList.contains("is-tablet")),
		};
		setBodyClasses({ isPhone: true, isTablet: false });
		record("applied", {
			reason: reason,
			width: window.innerWidth,
			effective: snapshot(),
		});
	}

	function revert(reason) {
		if (!state.applied) return;
		state.applied = false;
		api.applied = false;
		api.overrides = null;
		var saved = state.saved;
		if (saved && state.stored) {
			// Exact undo, not a recomputation: Obsidian may or may not have run
			// its own 600x600 handler while the override was active.
			state.stored.isPhone = saved.isPhone;
			state.stored.isTablet = saved.isTablet;
		}
		setBodyClasses({
			isPhone: saved ? saved.bodyPhone : false,
			isTablet: saved ? saved.bodyTablet : false,
		});
		state.saved = null;
		record("reverted", {
			reason: reason,
			width: window.innerWidth,
			effective: snapshot(),
		});
	}

	/** Only a threshold crossing reaches here (matchMedia change). */
	function sync(reason) {
		if (!state.captured) return;
		var narrow = isNarrow();
		if (narrow === state.applied) return;
		if (narrow) apply(reason);
		else revert(reason);
	}

	function adopt(platform, source) {
		if (state.captured || !looksLikePlatform(platform)) return;
		state.captured = true;
		state.platform = platform;
		api.captured = true;
		record("captured", { source: source });
		// A page that boots already narrow must get the flags before the App is
		// constructed (the override is applied by the boot-time sync below).
		sync("initial");
	}

	/**
	 * The export getter exists before `var Qy = {...}` is assigned, so the first
	 * read is normally undefined. A microtask runs after the bundle's top-level
	 * script finishes; a short timer loop covers modules that are evaluated
	 * lazily.
	 *
	 * @param {() => unknown} getter
	 * @param {number} attempt
	 */
	function readPlatform(getter, attempt) {
		if (state.captured) return;
		var value;
		try {
			value = getter();
		} catch (err) {
			value = null;
		}
		if (looksLikePlatform(value)) {
			adopt(value, attempt === 0 ? "export-getter" : "export-getter-deferred");
			return;
		}
		if (attempt >= 50) return;
		window.setTimeout(function () {
			readPlatform(getter, attempt + 1);
		}, attempt === 0 ? 0 : 10);
	}

	function observePlatformExport(getter) {
		if (state.captured) return;
		record("platform-export-seen", {});
		queueMicrotask(function () {
			readPlatform(getter, 0);
		});
	}

	// ---------------------------------------------------------------------
	// 1) window.Platform trap — the literal zero-patch hook. If a bundle ever
	//    assigns the object directly, the setter adopts it. The getter also
	//    makes the captured object reachable from the console / harness.
	// ---------------------------------------------------------------------
	try {
		Object.defineProperty(window, "Platform", {
			configurable: true,
			enumerable: false,
			get: function () {
				return state.platform || undefined;
			},
			set: function (value) {
				adopt(value, "window-assignment");
			},
		});
	} catch (err) {
		record("window-trap-failed", { error: String(err && err.message ? err.message : err) });
	}

	// ---------------------------------------------------------------------
	// 2) Object.defineProperty wrapper — where the bundle actually exposes it.
	//    Transparent: the native result is returned untouched, and any error in
	//    our observation is swallowed so a defineProperty call can never fail
	//    because of the bridge.
	// ---------------------------------------------------------------------
	var nativeDefineProperty = Object.defineProperty;
	Object.defineProperty = function defineProperty(target, property, descriptor) {
		var result = nativeDefineProperty.apply(this, arguments);
		if (property === "Platform" && descriptor && typeof descriptor.get === "function") {
			try {
				observePlatformExport(descriptor.get);
			} catch (err) {
				/* observation must never break the bundle */
			}
		}
		return result;
	};

	// ---------------------------------------------------------------------
	// 3) Threshold listener. matchMedia fires only when the query flips, which
	//    is exactly the "once per crossing" requirement: resize events inside
	//    the same side of the breakpoint do not touch Obsidian's layout state.
	// ---------------------------------------------------------------------
	function onBreach(event) {
		sync(event && event.matches ? "matchmedia-enter" : "matchmedia-leave");
	}

	try {
		var query = window.matchMedia(NARROW_QUERY);
		if (typeof query.addEventListener === "function") {
			query.addEventListener("change", onBreach);
		} else if (typeof query.addListener === "function") {
			query.addListener(onBreach);
		}
	} catch (err) {
		record("matchmedia-failed", { error: String(err && err.message ? err.message : err) });
	}

	api.installed = true;
})();
