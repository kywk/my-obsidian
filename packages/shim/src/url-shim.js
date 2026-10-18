/*
 * url-shim.js — classic script.
 *
 * Obsidian uses url.pathToFileURL() for FileSystemAdapter.getResourcePath()
 * and getFilePath(), and url.fileURLToPath() in a few plugin-facing paths.
 *
 * pathToFileURL returns an object with href / toString() so callers that do
 * `pathToFileURL(p).href` and `.toString()` both work.
 */
(function () {
	"use strict";

	var modules = window.__MYOBS_MODULES || (window.__MYOBS_MODULES = {});

	function pathModule() {
		return modules.path;
	}

	function toSlash(value) {
		return String(value).replace(/\\/g, "/");
	}

	function isWindows() {
		var boot = window.__MYOBS || {};
		return boot.platform === "win32";
	}

	function resolvePath(value) {
		var path = pathModule();
		if (path && typeof path.resolve === "function") {
			return path.resolve(String(value));
		}
		var text = String(value);
		return text.charAt(0) === "/" ? text : "/" + text;
	}

	function encodeSegment(segment) {
		return encodeURIComponent(segment);
	}

	function pathToFileURL(filepath) {
		var resolved = toSlash(resolvePath(filepath));
		var host = "";
		var pathname = resolved;

		if (pathname.slice(0, 2) === "//") {
			// UNC path: \\server\share\... -> file://server/share/...
			var parts = pathname.slice(2).split("/");
			host = parts.shift() || "";
			pathname = "/" + parts.join("/");
		}

		if (pathname.charAt(0) !== "/") {
			pathname = "/" + pathname;
		}

		var segments = pathname.split("/");
		var encoded = segments
			.map(function (segment, index) {
				// Keep the drive colon ("C:") literal like Node does.
				if (index === 1 && /^[A-Za-z]:$/.test(segment)) return segment;
				return encodeSegment(segment);
			})
			.join("/");

		var href = "file://" + host + encoded;
		var result = {
			href: href,
			protocol: "file:",
			host: host,
			pathname: encoded,
			search: "",
			hash: "",
			toString: function () {
				return href;
			},
			toJSON: function () {
				return href;
			}
		};
		return result;
	}

	function fileURLToPath(input) {
		var href = typeof input === "string" ? input : input && input.href ? String(input.href) : String(input);
		if (href.slice(0, 7).toLowerCase() !== "file://") {
			throw new TypeError("The URL must be of scheme file");
		}

		var rest = href.slice(7);
		var host = "";
		if (rest.charAt(0) !== "/") {
			// file://server/share -> UNC on Windows, a rejected host elsewhere.
			var slash = rest.indexOf("/");
			host = slash === -1 ? rest : rest.slice(0, slash);
			rest = slash === -1 ? "" : rest.slice(slash);
			if (host === "localhost") host = "";
			if (host && !isWindows()) {
				throw new TypeError('File URL host must be "localhost" or empty on this platform');
			}
		}

		var decoded;
		try {
			decoded = decodeURIComponent(rest);
		} catch (err) {
			decoded = rest;
		}

		if (isWindows()) {
			if (host) {
				decoded = "\\\\" + host + decoded.replace(/\//g, "\\");
			} else {
				if (decoded.charAt(0) === "/" && /^[A-Za-z]:/.test(decoded.slice(1))) {
					decoded = decoded.slice(1);
				}
				decoded = decoded.replace(/\//g, "\\");
			}
		}
		return decoded;
	}

	function parseUrl(input) {
		var text = String(input);
		var match = /^([A-Za-z][A-Za-z0-9+.-]*):(\/\/[^/?#]*)?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(text);
		if (!match) return { href: text, protocol: null, slashes: false };
		var protocol = match[1].toLowerCase() + ":";
		var slashes = !!match[2];
		var auth = slashes ? match[2].slice(2) : null;
		var host = null;
		if (auth) {
			var at = auth.lastIndexOf("@");
			host = at === -1 ? auth : auth.slice(at + 1);
		}
		return {
			href: text,
			protocol: protocol,
			slashes: slashes,
			auth: auth && auth !== host ? auth.slice(0, auth.length - (host ? host.length + 1 : 0)) : null,
			host: host,
			hostname: host ? host.split(":")[0] : null,
			port: host && host.indexOf(":") !== -1 ? host.split(":").pop() : null,
			pathname: match[3] || null,
			search: match[4] || null,
			query: match[4] ? match[4].slice(1) : null,
			hash: match[5] || null,
			toString: function () {
				return text;
			}
		};
	}

	function formatUrl(input) {
		if (typeof input === "string") return input;
		var protocol = input.protocol || "";
		var host = input.host || input.hostname || "";
		var pathname = input.pathname || "";
		var search = input.search || (input.query ? "?" + input.query : "");
		var hash = input.hash || "";
		var slashes = input.slashes === false ? "" : "//";
		return protocol + (host ? slashes + host : "") + pathname + search + hash;
	}

	function resolveUrl(from, to) {
		try {
			return new URL(String(to), String(from)).href;
		} catch (err) {
			return String(to);
		}
	}

	var url = {
		pathToFileURL: pathToFileURL,
		fileURLToPath: fileURLToPath,
		parse: parseUrl,
		format: formatUrl,
		resolve: resolveUrl,
		URL: window.URL,
		URLSearchParams: window.URLSearchParams,
		domainToASCII: function (domain) {
			try {
				return new URL("http://" + domain).hostname;
			} catch (err) {
				return "";
			}
		},
		domainToUnicode: function (domain) {
			return String(domain);
		}
	};

	modules["url"] = url;
})();
