/*
 * path-shim.js — classic script.
 *
 * A small Node `path` polyfill. The default flavour is chosen from
 * __MYOBS.platform (darwin/linux -> posix, win32 -> win32); both flavours are
 * always exposed as path.posix and path.win32, matching Node.
 *
 * This is not a byte-for-byte port of Node's implementation. It covers the
 * calls the Obsidian renderer and common plugins make; see GAPS.md.
 */
(function () {
	"use strict";

	var boot = window.__MYOBS || {};
	var modules = window.__MYOBS_MODULES || (window.__MYOBS_MODULES = {});
	var WINDOWS = boot.platform === "win32";

	function toSlash(value) {
		return String(value).replace(/\\/g, "/");
	}

	function currentNodeCwd() {
		try {
			if (typeof process !== "undefined" && typeof process.cwd === "function") {
				var value = process.cwd();
				if (typeof value === "string" && value) return value;
			}
		} catch (err) {
			/* ignore */
		}
		return WINDOWS ? "C:\\" : "/";
	}

	// ---------------------------------------------------------------------
	// POSIX
	// ---------------------------------------------------------------------

	function normalizePosix(value) {
		var text = String(value);
		if (!text) return ".";

		var absolute = text.charAt(0) === "/";
		var trailing = text.length > 1 && text.charAt(text.length - 1) === "/";
		var parts = text.split("/");
		var out = [];

		for (var i = 0; i < parts.length; i++) {
			var part = parts[i];
			if (!part || part === ".") continue;
			if (part === "..") {
				if (out.length > 0 && out[out.length - 1] !== "..") {
					out.pop();
				} else if (!absolute) {
					out.push("..");
				}
				continue;
			}
			out.push(part);
		}

		var result = (absolute ? "/" : "") + out.join("/");
		if (!result) result = absolute ? "/" : ".";
		if (trailing && result !== "/") result += "/";
		return result;
	}

	function joinPosix() {
		var args = Array.prototype.slice.call(arguments);
		var parts = [];
		for (var i = 0; i < args.length; i++) {
			var value = String(args[i]);
			if (value) parts.push(value);
		}
		return normalizePosix(parts.join("/"));
	}

	function resolvePosix() {
		var args = Array.prototype.slice.call(arguments);
		var resolved = "";
		var cwd = currentNodeCwd();
		if (cwd.charAt(0) !== "/") cwd = "/";

		for (var i = args.length - 1; i >= -1; i--) {
			var value = i >= 0 ? String(args[i]) : cwd;
			if (!value) continue;
			resolved = value + "/" + resolved;
			if (value.charAt(0) === "/") break;
		}

		var result = normalizePosix(resolved || "/");
		if (result.length > 1) {
			result = result.replace(/\/+$/, "");
		}
		return result || "/";
	}

	function dirnamePosix(value) {
		var text = String(value);
		if (!text) return ".";
		var end = text.length;
		while (end > 1 && text.charAt(end - 1) === "/") end--;
		var trimmed = text.slice(0, end);
		var index = trimmed.lastIndexOf("/");
		if (index === -1) return ".";
		// POSIX allows a double-slash root; Node keeps it for "//a".
		if (index === 1 && trimmed.slice(0, 2) === "//") return "//";
		if (index === 0) return "/";
		return trimmed.slice(0, index);
	}

	function basenamePosix(value, ext) {
		var text = String(value);
		var end = text.length;
		while (end > 1 && text.charAt(end - 1) === "/") end--;
		text = text.slice(0, end);
		var index = text.lastIndexOf("/");
		var base = index === -1 ? text : text.slice(index + 1);
		if (typeof ext === "string" && ext.length > 0 && base.length > ext.length && base.slice(-ext.length) === ext) {
			base = base.slice(0, -ext.length);
		}
		return base;
	}

	function extnamePosix(value) {
		var base = basenamePosix(value);
		if (base === "." || base === "..") return "";
		var index = base.lastIndexOf(".");
		if (index <= 0) return "";
		return base.slice(index);
	}

	function parsePosix(value) {
		var text = String(value);
		var root = text.charAt(0) === "/" ? "/" : "";
		if (root) text = text.slice(1);
		var index = text.lastIndexOf("/");
		var dir = "";
		var base = text;
		if (index !== -1) {
			dir = text.slice(0, index);
			base = text.slice(index + 1);
		}
		if (root) {
			dir = dir ? "/" + dir : "/";
		}
		var ext = extnamePosix(base);
		var name = ext ? base.slice(0, -ext.length) : base;
		return { root: root, dir: dir, base: base, ext: ext, name: name };
	}

	function formatPosix(input) {
		var dir = input.dir || input.root || "";
		var base = input.base;
		if (base == null) {
			base = String(input.name == null ? "" : input.name) + String(input.ext == null ? "" : input.ext);
		}
		if (!dir) return base;
		if (!base) return dir;
		return dir.charAt(dir.length - 1) === "/" ? dir + base : dir + "/" + base;
	}

	function relativePosix(from, to) {
		var start = resolvePosix(from);
		var end = resolvePosix(to);
		if (start === end) return "";
		var startParts = start.split("/").filter(Boolean);
		var endParts = end.split("/").filter(Boolean);
		var common = 0;
		while (common < startParts.length && common < endParts.length && startParts[common] === endParts[common]) {
			common++;
		}
		var out = [];
		for (var i = common; i < startParts.length; i++) out.push("..");
		for (var j = common; j < endParts.length; j++) out.push(endParts[j]);
		return out.join("/");
	}

	function isAbsolutePosix(value) {
		return String(value).charAt(0) === "/";
	}

	function toNamespacedPathPosix(value) {
		return value;
	}

	var posix = {
		sep: "/",
		delimiter: ":",
		normalize: normalizePosix,
		join: joinPosix,
		resolve: resolvePosix,
		dirname: dirnamePosix,
		basename: basenamePosix,
		extname: extnamePosix,
		parse: parsePosix,
		format: formatPosix,
		relative: relativePosix,
		isAbsolute: isAbsolutePosix,
		toNamespacedPath: toNamespacedPathPosix
	};

	// ---------------------------------------------------------------------
	// Win32
	// ---------------------------------------------------------------------

	function winNormalize(value) {
		var text = toSlash(String(value));
		if (!text) return ".";

		var prefix = "";
		var rest = text;

		if (rest.slice(0, 2) === "//") {
			var unc = /^\/\/([^\/]+)\/([^\/]+)/.exec(rest);
			if (unc) {
				prefix = "//" + unc[1] + "/" + unc[2];
				rest = rest.slice(unc[0].length);
			}
		} else if (/^[A-Za-z]:/.test(rest)) {
			prefix = rest.slice(0, 2);
			rest = rest.slice(2);
		}

		var absolute = !!prefix || rest.charAt(0) === "/";
		var normalized = normalizePosix(rest);
		if (normalized === "." && !prefix) normalized = "";
		if (normalized === "/") normalized = "";

		var result = prefix;
		if (absolute) result += "/";
		result += normalized.replace(/^\/+/, "");
		if (!result) result = ".";
		return result.replace(/\//g, "\\");
	}

	function winJoin() {
		var args = Array.prototype.slice.call(arguments);
		var parts = [];
		for (var i = 0; i < args.length; i++) {
			var value = String(args[i]);
			if (value) parts.push(value);
		}
		return winNormalize(parts.join("/"));
	}

	function winIsAbsolute(value) {
		var text = toSlash(String(value));
		return /^[A-Za-z]:\//.test(text) || text.slice(0, 2) === "//" || text.charAt(0) === "/";
	}

	function winResolve() {
		var args = Array.prototype.slice.call(arguments);
		var resolved = "";
		var cwd = currentNodeCwd();
		if (!/^[A-Za-z]:[\\/]/.test(cwd) && cwd.slice(0, 2) !== "\\\\") cwd = "C:\\";

		for (var i = args.length - 1; i >= -1; i--) {
			var value = i >= 0 ? String(args[i]) : cwd;
			if (!value) continue;
			resolved = value + "/" + resolved;
			if (winIsAbsolute(value)) break;
		}

		var result = winNormalize(resolved || cwd);
		if (result.length > 3) result = result.replace(/\\+$/, "");
		return result || "C:\\";
	}

	function winDirname(value) {
		var text = toSlash(String(value));
		if (/^[A-Za-z]:\/?$/.test(text)) return text.replace(/\//g, "\\");

		var unc = /^\/\/([^\/]+)\/([^\/]+)/.exec(text);
		var uncRoot = unc ? "//" + unc[1] + "/" + unc[2] : "";
		var hadTrailing = text.length > 1 && text.charAt(text.length - 1) === "/";

		var end = text.length;
		while (end > 1 && text.charAt(end - 1) === "/") end--;
		text = text.slice(0, end);

		if (uncRoot && text === uncRoot) {
			return (uncRoot + (hadTrailing ? "/" : "")).replace(/\//g, "\\");
		}

		var index = text.lastIndexOf("/");
		if (index === -1) return ".";
		if (index === 0) return "\\";
		if (uncRoot && text.slice(0, index) === uncRoot) {
			return uncRoot.replace(/\//g, "\\") + "\\";
		}
		if (/^[A-Za-z]:$/.test(text.slice(0, index))) {
			return text.slice(0, index + 1).replace(/\//g, "\\");
		}
		return text.slice(0, index).replace(/\//g, "\\");
	}

	function winBasename(value, ext) {
		var text = toSlash(String(value));
		if (/^[A-Za-z]:\/?$/.test(text)) return "";
		return basenamePosix(text, ext);
	}

	function winExtname(value) {
		return extnamePosix(toSlash(String(value)));
	}

	function winParse(value) {
		var text = toSlash(String(value));
		var root = "";
		if (/^[A-Za-z]:\//.test(text)) {
			root = text.slice(0, 3).replace(/\//g, "\\");
		} else if (text.slice(0, 2) === "//") {
			var unc = /^\/\/([^\/]+)\/([^\/]+)\/?/.exec(text);
			if (unc) root = ("\\\\" + unc[1] + "\\" + unc[2] + "\\");
		}
		var dir = winDirname(value);
		var base = winBasename(value);
		var ext = extnamePosix(base);
		var name = ext ? base.slice(0, -ext.length) : base;
		return { root: root, dir: dir, base: base, ext: ext, name: name };
	}

	function formatWin32(input) {
		var dir = input.dir || input.root || "";
		var base = input.base;
		if (base == null) {
			base = String(input.name == null ? "" : input.name) + String(input.ext == null ? "" : input.ext);
		}
		if (!dir) return base;
		if (!base) return dir;
		var separator = dir.charAt(dir.length - 1) === "\\" || dir.charAt(dir.length - 1) === "/" ? "" : "\\";
		return dir + separator + base;
	}

	function relativeWin32(from, to) {
		var start = winResolve(from);
		var end = winResolve(to);
		if (start.toLowerCase() === end.toLowerCase()) return "";

		var startDrive = /^([A-Za-z]:)/.exec(start);
		var endDrive = /^([A-Za-z]:)/.exec(end);
		if (startDrive && endDrive && startDrive[1].toLowerCase() !== endDrive[1].toLowerCase()) {
			// Different volumes: Node returns the absolute target.
			return end;
		}

		var startParts = toSlash(start).split("/").filter(Boolean);
		var endParts = toSlash(end).split("/").filter(Boolean);
		var common = 0;
		while (
			common < startParts.length &&
			common < endParts.length &&
			startParts[common].toLowerCase() === endParts[common].toLowerCase()
		) {
			common++;
		}
		var out = [];
		for (var i = common; i < startParts.length; i++) out.push("..");
		for (var j = common; j < endParts.length; j++) out.push(endParts[j]);
		return out.join("\\");
	}

	function toNamespacedPathWin32(value) {
		return value;
	}

	var win32 = {
		sep: "\\",
		delimiter: ";",
		normalize: winNormalize,
		join: winJoin,
		resolve: winResolve,
		dirname: winDirname,
		basename: winBasename,
		extname: winExtname,
		parse: winParse,
		format: formatWin32,
		relative: relativeWin32,
		isAbsolute: winIsAbsolute,
		toNamespacedPath: toNamespacedPathWin32
	};

	// Node exposes both flavours from each object as well as from the default.
	posix.posix = posix;
	posix.win32 = win32;
	win32.posix = posix;
	win32.win32 = win32;

	var exported = WINDOWS ? win32 : posix;
	modules["path"] = exported;
})();
