/*
 * fs-shim.js — classic script.
 *
 * Implements the fs surface Obsidian 1.14.4's FileSystemAdapter uses, backed
 * by POST /api/fs (CONTRACTS.md §2). The module is deliberately self-contained:
 * fs-shim is loaded before path-shim, so it carries its own small POSIX/Win32
 * path helpers instead of depending on module load order.
 *
 * Path rules (CONTRACTS.md §5):
 *   - paths below __MYOBS.vaultPath      -> /api/fs
 *   - paths below __MYOBS.resourcesPath  -> static /obsidian/*
 *   - .obsidian/workspace.json           -> .obsidian/workspace-server.json
 *   - everything else                    -> ENOENT
 *
 * The only synchronous APIs are existsSync / writeFileSync / unlinkSync
 * (plus cache-backed statSync/lstatSync and a resource-only readFileSync).
 * They are approximations and are documented in ../GAPS.md.
 */
(function () {
	"use strict";

	var boot = window.__MYOBS || {};
	var modules = window.__MYOBS_MODULES || (window.__MYOBS_MODULES = {});
	var PLATFORM = boot.platform || "darwin";
	var CASE_INSENSITIVE = PLATFORM === "darwin" || PLATFORM === "win32";
	var WINDOWS = PLATFORM === "win32";

	var constants = {
		F_OK: 0,
		R_OK: 4,
		W_OK: 2,
		X_OK: 1,
		COPYFILE_EXCL: 1,
		COPYFILE_FICLONE: 2,
		COPYFILE_FICLONE_FORCE: 4,
		O_RDONLY: 0,
		O_WRONLY: 1,
		O_RDWR: 2,
		O_CREAT: 64,
		O_EXCL: 128,
		O_TRUNC: 512,
		O_APPEND: 1024,
		S_IFMT: 61440,
		S_IFREG: 32768,
		S_IFDIR: 16384
	};

	// ---------------------------------------------------------------------
	// Small path helpers (no dependency on path-shim)
	// ---------------------------------------------------------------------

	function toSlash(value) {
		return String(value).replace(/\\/g, "/");
	}

	function isAbsolute(value) {
		return value.charAt(0) === "/" || /^[A-Za-z]:\//.test(value);
	}

	function normalizeAbs(value) {
		var text = toSlash(value == null ? "" : value);
		if (!text) return "";

		var drive = "";
		var absolute = false;

		if (/^[A-Za-z]:\//.test(text)) {
			drive = text.slice(0, 2);
			text = text.slice(2);
			absolute = true;
		} else if (text.charAt(0) === "/") {
			absolute = true;
		}

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

		var result = drive + (absolute ? "/" : "") + out.join("/");
		if (!result) {
			result = absolute ? "/" : ".";
		}
		if (trailing && result !== "/" && !/^[A-Za-z]:\/$/.test(result)) {
			result += "/";
		}
		return result;
	}

	function stripTrailing(value) {
		if (value === "/" || /^[A-Za-z]:\/$/.test(value)) return value;
		return value.replace(/\/+$/, "");
	}

	function fold(value) {
		return CASE_INSENSITIVE ? value.toLowerCase() : value;
	}

	function sameOrInside(candidate, base) {
		var c = fold(candidate);
		var b = fold(stripTrailing(base));
		if (b === "" || b === "/" || /^[a-z]:\/$/.test(b)) {
			return true;
		}
		return c === b || c.indexOf(b + "/") === 0;
	}

	function relativeTo(candidate, base) {
		var root = stripTrailing(base);
		if (root === "/" || /^[A-Za-z]:\/$/.test(root)) {
			return candidate.replace(/^\/+/, "");
		}
		return candidate.slice(root.length).replace(/^\/+/, "");
	}

	function joinAbs(base, relative) {
		var root = stripTrailing(base);
		if (root === "/" || /^[A-Za-z]:\/$/.test(root)) {
			return normalizeAbs(root + relative);
		}
		return normalizeAbs(root + "/" + relative);
	}

	function joinRel(base, name) {
		return base ? base + "/" + name : name;
	}

	function dirnameRel(relative) {
		var index = relative.lastIndexOf("/");
		return index === -1 ? "" : relative.slice(0, index);
	}

	function baseName(value) {
		var text = stripTrailing(toSlash(value));
		var index = text.lastIndexOf("/");
		return index === -1 ? text : text.slice(index + 1);
	}

	function normalizeRel(value) {
		var text = toSlash(value == null ? "" : value).replace(/^\/+/, "");
		var parts = text.split("/");
		var out = [];
		for (var i = 0; i < parts.length; i++) {
			var part = parts[i];
			if (!part || part === ".") continue;
			if (part === "..") {
				if (out.length === 0) {
					throw fsError("EPERM", "path escapes the vault: " + value, value);
				}
				out.pop();
				continue;
			}
			out.push(part);
		}
		return out.join("/");
	}

	function toPlatformPath(value) {
		return WINDOWS ? String(value).replace(/\//g, "\\") : value;
	}

	var vaultRoot = stripTrailing(normalizeAbs(boot.vaultPath || ""));
	var resourcesRoot = stripTrailing(normalizeAbs(boot.resourcesPath || "/obsidian"));

	// ---------------------------------------------------------------------
	// Error helpers
	// ---------------------------------------------------------------------

	var ERRNO = {
		ENOENT: -2,
		EACCES: -13,
		EEXIST: -17,
		ENOTDIR: -20,
		EISDIR: -21,
		EINVAL: -22,
		ENOSPC: -28,
		EROFS: -30,
		EPERM: -1,
		EIO: -5,
		ENOTSUP: -45,
		ECONFLICT: -409,
		/*
		 * Transport-level codes, not Node errno values. Both exist so callers
		 * can distinguish "the server said no" (EIO / ENOENT / ... on an HTTP
		 * response) from "there was no server to answer".
		 */
		ECONNREFUSED: -111,
		EOFFLINE: -100
	};

	function fsError(code, message, path) {
		var err = new Error(message || (code + ": " + String(path == null ? "" : path)));
		err.code = code;
		err.errno = Object.prototype.hasOwnProperty.call(ERRNO, code) ? ERRNO[code] : -1;
		err.syscall = "";
		err.path = path;
		return err;
	}

	// ---------------------------------------------------------------------
	// Path mapping
	// ---------------------------------------------------------------------

	function decodeFileUrl(value) {
		var text = value.replace(/^file:\/\//i, "");
		try {
			text = decodeURIComponent(text);
		} catch (err) {
			/* keep the raw text */
		}
		if (WINDOWS && text.charAt(0) === "/" && /^[A-Za-z]:/.test(text.slice(1))) {
			text = text.slice(1);
		}
		return text;
	}

	/**
	 * Returns one of:
	 *   { kind: "vault",    rel: "notes/a.md" }
	 *   { kind: "resource", url: "/obsidian/app.js" }
	 * Throws ENOENT for paths outside both roots.
	 */
	function resolvePath(input) {
		if (typeof input !== "string") {
			throw new TypeError("The \"path\" argument must be of type string");
		}
		if (input.indexOf("\0") !== -1) {
			throw fsError("EINVAL", "path contains a null byte", input);
		}

		var raw = input;
		var text = /^file:\/\//i.test(raw) ? decodeFileUrl(raw) : raw;
		var absolute = isAbsolute(toSlash(text))
			? normalizeAbs(text)
			: normalizeAbs(joinAbs(vaultRoot, text));

		// Vault first: a vault may legitimately live at /obsidian.
		if (sameOrInside(absolute, vaultRoot)) {
			var relative = normalizeRel(relativeTo(absolute, vaultRoot));
			if (fold(relative) === ".obsidian/workspace.json") {
				relative = ".obsidian/workspace-server.json";
			}
			return { kind: "vault", rel: relative };
		}

		if (sameOrInside(absolute, resourcesRoot)) {
			return { kind: "resource", url: absolute };
		}

		throw fsError("ENOENT", "ENOENT: no such file or directory, '" + raw + "'", raw);
	}

	function requireVault(input) {
		var descriptor = resolvePath(input);
		if (descriptor.kind !== "vault") {
			throw fsError("EPERM", "EPERM: operation not permitted on a static resource, '" + input + "'", input);
		}
		return descriptor;
	}

	// ---------------------------------------------------------------------
	// /api/fs transport
	// ---------------------------------------------------------------------

	function getFetch() {
		if (typeof window.fetch === "function") {
			return window.fetch.bind(window);
		}
		if (typeof fetch === "function") {
			return fetch;
		}
		return null;
	}

	// ---------------------------------------------------------------------
	// Transport concurrency limit
	//
	// Obsidian's vault walk calls fs.promises.readdir directly, bypassing the
	// adapter's serializing queue, and listRecursive fans out with Promise.all
	// across the whole directory tree. Against the Electron local FS that is
	// free; against a network backend it becomes ~7000 in-flight requests in
	// two seconds, after which Chrome starts rejecting them with
	// "Failed to fetch" *before they leave the browser*. One rejection makes
	// Promise.all reject, which aborts the entire vault load -- the scan stops
	// dead and the metadata cache never initializes.
	//
	// The bound belongs here rather than in the caller: no matter how eagerly
	// Obsidian fans out, only MAX_INFLIGHT round trips exist at any moment.
	var MAX_INFLIGHT = 48;
	var inflight = 0;
	var waiters = [];

	function acquireSlot() {
		if (inflight < MAX_INFLIGHT) {
			inflight += 1;
			return Promise.resolve();
		}
		return new Promise(function (resolve) {
			waiters.push(resolve);
		});
	}

	function releaseSlot() {
		var next = waiters.shift();
		if (next) next();
		else inflight -= 1;
	}

	function passThrough(value) {
		releaseSlot();
		return value;
	}

	function releaseAndThrow(err) {
		releaseSlot();
		throw err;
	}

	function withSlot(start) {
		return acquireSlot().then(function () {
			return start().then(passThrough, releaseAndThrow);
		});
	}

	// Mutating ops that can produce an /api/watch event. Reads stay untagged:
	// they cannot cause a filesystem event, and tagging them would only make
	// the wire payload larger and hide which calls are actual writes.
	var TOKEN_OPS = {
		write: true,
		writeBinary: true,
		append: true,
		appendBinary: true,
		mkdir: true,
		rmdir: true,
		remove: true,
		rename: true,
		copy: true,
		utimes: true
	};

	/*
	 * A read may be retried once, but only when the request never reached a
	 * server. Anything that produced an HTTP response is an answer, not a
	 * transport failure, and repeating it would just repeat the same 4xx/5xx.
	 *
	 * Writes are never retried. Every write carries ifMtimeMs; a blind retry
	 * after a response was lost can either create a bogus conflict copy (the
	 * first write actually landed) or overwrite a newer external edit.
	 */
	var RETRYABLE_READS = {
		read: true,
		readBinary: true,
		stat: true,
		list: true,
		exists: true,
		access: true,
		realpath: true
	};

	function offlineNow() {
		var resilience = window.__MYOBS_RESILIENCE;
		return !!(resilience && resilience.online === false);
	}

	function resilienceCall(name, args) {
		try {
			var resilience = window.__MYOBS_RESILIENCE;
			var fn = resilience && resilience[name];
			if (typeof fn === "function") fn.apply(resilience, args);
		} catch (err) {
			/* diagnostics must never break the fs path */
		}
	}

	function transportError(op, path, blocked, cause) {
		var where = path == null || path === "" ? "/" : String(path);
		var write = TOKEN_OPS[op] === true;
		var message;
		if (write) {
			/*
			 * This wording is a contract with the operator: after a failed
			 * save the first question is always "did my text reach the disk?".
			 */
			message =
				"後端中斷，這次修改沒有存到磁碟（" +
				op +
				" " +
				where +
				"）。請確認 my-obsidian server 正在執行；恢復連線後請重新儲存。";
		} else {
			message =
				"後端中斷，讀取失敗（" +
				op +
				" " +
				where +
				"）。請確認 my-obsidian server 正在執行。";
		}
		var err = fsError(blocked ? "EOFFLINE" : "ECONNREFUSED", message, path);
		err.myobs = {
			op: op,
			path: where,
			write: write,
			network: true,
			blocked: blocked === true
		};
		if (cause) err.cause = cause;
		return err;
	}

	function httpError(op, path, status, info) {
		var err = fsError(
			(info && info.code) || "EIO",
			(info && info.message) || ("fs op '" + op + "' failed with HTTP " + status),
			path
		);
		err.status = status;
		err.myobs = {
			op: op,
			path: path == null ? "" : String(path),
			write: TOKEN_OPS[op] === true,
			network: false,
			httpStatus: status
		};
		return err;
	}

	function finalizeNetworkError(err, op, path) {
		resilienceCall("noteNetworkFailure", [op, path]);
		if (TOKEN_OPS[op] === true) {
			resilienceCall("noteWriteBlocked", [op, path, err && err.cause ? String(err.cause) : "network"]);
		}
		return err;
	}

	function postOnce(fetchFn, op, path, payload) {
		return fetchFn("/api/fs", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			credentials: "same-origin",
			body: JSON.stringify(payload)
		}).then(
			function (response) {
				return response.text().then(
					function (text) {
						var json = null;
						try {
							json = text ? JSON.parse(text) : null;
						} catch (err) {
							/*
							 * A proxy that is up but not forwarding to the
							 * backend returns HTML; that is an HTTP-level
							 * failure, not a transport failure.
							 */
							throw httpError(op, path, response.status, {
								code: "EIO",
								message:
									"invalid JSON from /api/fs (" +
									op +
									"): " +
									String(text).slice(0, 200)
							});
						}

						if (!json || json.ok !== true) {
							throw httpError(op, path, response.status, (json && json.error) || {});
						}
						return json.result;
					},
					function (err) {
						// Body read failed: the connection died mid-response.
						throw transportError(op, path, false, err);
					}
				);
			},
			function (err) {
				throw transportError(op, path, false, err);
			}
		);
	}

	function api(op, path, args) {
		/*
		 * Echo tagging for /api/watch. This is the single transport-level
		 * point where a mutation leaves the renderer, so every caller --
		 * Obsidian's adapter, our own queued sync writes, plugins using
		 * fs.promises -- gets the token without changing each op signature.
		 *
		 * The server attaches originToken to the resulting WS event and
		 * watch-shim drops events carrying this tab's token (CONTRACTS.md §4).
		 * Without this, saving a plugin file from this tab would trigger a hot
		 * reload, whose unload writes data.json, which would trigger another
		 * reload.
		 */
		if (TOKEN_OPS[op] === true) {
			var sessionToken = window.__MYOBS && window.__MYOBS.sessionToken;
			if (typeof sessionToken === "string" && sessionToken !== "") {
				var nextArgs = {};
				if (args && typeof args === "object") {
					for (var key in args) {
						if (Object.prototype.hasOwnProperty.call(args, key)) nextArgs[key] = args[key];
					}
				}
				if (typeof nextArgs.token !== "string" || nextArgs.token === "") {
					nextArgs.token = sessionToken;
				}
				args = nextArgs;
			}
		}

		/*
		 * The offline gate belongs here for the same reason the concurrency
		 * limit does: every caller funnels through this function. It is
		 * deliberately a hard failure, not a queue. A queued write would fire
		 * at an arbitrary later moment with an ifMtimeMs measured before the
		 * outage, which is exactly the "looks saved, disk disagrees" failure
		 * this workstream exists to remove.
		 */
		if (TOKEN_OPS[op] === true && offlineNow()) {
			resilienceCall("noteWriteBlocked", [op, path, "offline"]);
			return Promise.reject(transportError(op, path, true, null));
		}

		var payload = { op: op, path: path };
		if (args !== undefined) payload.args = args;

		var fetchFn = getFetch();
		if (!fetchFn) {
			return Promise.reject(fsError("EIO", "fetch is not available in this browser", path));
		}

		return withSlot(function () {
			return postOnce(fetchFn, op, path, payload).catch(function (err) {
				var network = !!(err && err.myobs && err.myobs.network === true);
				if (!network) throw err;
				if (RETRYABLE_READS[op] !== true) {
					throw finalizeNetworkError(err, op, path);
				}
				return postOnce(fetchFn, op, path, payload).catch(function (second) {
					if (!second || !second.myobs || second.myobs.network !== true) throw second;
					throw finalizeNetworkError(second, op, path);
				});
			});
		});
	}

	// ---------------------------------------------------------------------
	// Base64 / encoding helpers
	// ---------------------------------------------------------------------

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

	function bytesToHex(bytes) {
		var out = "";
		for (var i = 0; i < bytes.length; i++) {
			out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
		}
		return out;
	}

	function hexToBytes(value) {
		var text = String(value || "");
		var length = Math.floor(text.length / 2);
		var bytes = new Uint8Array(length);
		for (var i = 0; i < length; i++) {
			bytes[i] = parseInt(text.substr(i * 2, 2), 16);
		}
		return bytes;
	}

	function toBytes(data) {
		if (data instanceof Uint8Array) return data;
		if (data instanceof ArrayBuffer) return new Uint8Array(data);
		if (ArrayBuffer.isView(data)) {
			return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		}
		if (Array.isArray(data)) return new Uint8Array(data);
		throw new TypeError("data must be a string, ArrayBuffer, or ArrayBufferView");
	}

	function getEncoding(options) {
		if (options == null) return null;
		if (typeof options === "string") return options;
		if (typeof options === "object" && options.encoding != null) {
			return String(options.encoding);
		}
		return null;
	}

	function isUtf8(encoding) {
		return !encoding || encoding === "utf8" || encoding === "utf-8";
	}

	function encodeString(value, encoding) {
		var text = String(value);
		var normalized = String(encoding || "utf8").toLowerCase();
		if (normalized === "utf8" || normalized === "utf-8") {
			return new TextEncoder().encode(text);
		}
		if (normalized === "base64") return base64ToBytes(text);
		if (normalized === "hex") return hexToBytes(text);
		if (normalized === "latin1" || normalized === "binary" || normalized === "ascii") {
			var bytes = new Uint8Array(text.length);
			for (var i = 0; i < text.length; i++) {
				bytes[i] = text.charCodeAt(i) & 0xff;
			}
			return bytes;
		}
		if (normalized === "utf16le" || normalized === "ucs2" || normalized === "ucs-2") {
			var out = new Uint8Array(text.length * 2);
			for (var j = 0; j < text.length; j++) {
				var code = text.charCodeAt(j);
				out[j * 2] = code & 0xff;
				out[j * 2 + 1] = (code >> 8) & 0xff;
			}
			return out;
		}
		return new TextEncoder().encode(text);
	}

	function decodeBytes(bytes, encoding) {
		var normalized = String(encoding || "utf8").toLowerCase();
		if (normalized === "base64") return bytesToBase64(bytes);
		if (normalized === "hex") return bytesToHex(bytes);
		if (normalized === "latin1" || normalized === "binary" || normalized === "ascii") {
			var out = "";
			for (var i = 0; i < bytes.length; i++) {
				out += String.fromCharCode(bytes[i]);
			}
			return out;
		}
		if (normalized === "utf16le" || normalized === "ucs2" || normalized === "ucs-2") {
			return new TextDecoder("utf-16le").decode(bytes);
		}
		return new TextDecoder().decode(bytes);
	}

	// ---------------------------------------------------------------------
	// Sync existence cache (feeds existsSync / statSync)
	// ---------------------------------------------------------------------

	var knownPaths = new Map(); // folded relative path -> "file" | "folder" | "unknown"

	function cacheKey(relative) {
		return fold(relative);
	}

	function cacheSet(relative, type) {
		if (!relative) return;
		knownPaths.set(cacheKey(relative), type || "unknown");
		var parent = dirnameRel(relative);
		while (parent) {
			knownPaths.set(cacheKey(parent), "folder");
			parent = dirnameRel(parent);
		}
	}

	function cacheDrop(relative) {
		if (!relative) return;
		var prefix = cacheKey(relative);
		var keys = Array.from(knownPaths.keys());
		for (var i = 0; i < keys.length; i++) {
			if (keys[i] === prefix || keys[i].indexOf(prefix + "/") === 0) {
				knownPaths.delete(keys[i]);
			}
		}
	}

	function cacheMove(from, to) {
		cacheDrop(from);
		cacheSet(to, "unknown");
	}

	function cacheHas(relative) {
		return relative === "" || knownPaths.has(cacheKey(relative));
	}

	function cacheType(relative) {
		return knownPaths.get(cacheKey(relative));
	}

	// ---------------------------------------------------------------------
	// Stats
	// ---------------------------------------------------------------------

	function makeStats(type, mtimeMs, ctimeMs, size, realpath) {
		var isFile = type === "file";
		var isFolder = type === "folder";
		var mtime = Number(mtimeMs) || 0;
		var ctime = Number(ctimeMs) || mtime;
		var length = Number(size) || 0;
		return {
			dev: 0,
			ino: 0,
			mode: isFolder ? 0o40755 : 0o100644,
			nlink: 1,
			uid: 0,
			gid: 0,
			rdev: 0,
			size: length,
			blksize: 4096,
			blocks: Math.ceil(length / 512),
			atimeMs: mtime,
			mtimeMs: mtime,
			ctimeMs: ctime,
			birthtimeMs: ctime,
			atime: new Date(mtime),
			mtime: new Date(mtime),
			ctime: new Date(ctime),
			birthtime: new Date(ctime),
			realpath: realpath || "",
			type: type,
			isFile: function () {
				return isFile;
			},
			isDirectory: function () {
				return isFolder;
			},
			isBlockDevice: function () {
				return false;
			},
			isCharacterDevice: function () {
				return false;
			},
			isSymbolicLink: function () {
				return false;
			},
			isFIFO: function () {
				return false;
			},
			isSocket: function () {
				return false;
			}
		};
	}

	function statsFromApi(result, relative) {
		return makeStats(
			result.type,
			result.mtimeMs,
			result.ctimeMs,
			result.size,
			result.realpath || relative
		);
	}

	// ---------------------------------------------------------------------
	// Static resources
	// ---------------------------------------------------------------------

	function encodeUrlPath(value) {
		return String(value)
			.split("/")
			.map(function (segment, index) {
				return index === 0 ? segment : encodeURIComponent(segment);
			})
			.join("/");
	}

	function fetchStatic(url, options) {
		var fetchFn = getFetch();
		if (!fetchFn) {
			return Promise.reject(fsError("EIO", "fetch is not available in this browser", url));
		}
		var init = {
			method: (options && options.method) || "GET",
			credentials: "same-origin"
		};
		return fetchFn(encodeUrlPath(url), init);
	}

	function checkResourceResponse(response, url) {
		if (response.status === 404) {
			throw fsError("ENOENT", "ENOENT: no such file or directory, '" + url + "'", url);
		}
		if (!response.ok) {
			throw fsError("EIO", "HTTP " + response.status + " for static resource " + url, url);
		}
		return response;
	}

	function readResource(descriptor, encoding) {
		return fetchStatic(descriptor.url).then(function (response) {
			checkResourceResponse(response, descriptor.url);
			if (encoding && isUtf8(encoding)) {
				return response.text();
			}
			return response.arrayBuffer().then(function (buffer) {
				var bytes = new Uint8Array(buffer);
				return encoding ? decodeBytes(bytes, encoding) : bytes;
			});
		});
	}

	function headResource(descriptor) {
		return fetchStatic(descriptor.url, { method: "HEAD" })
			.then(function (response) {
				if (response.status === 405 || response.status === 501) {
					return fetchStatic(descriptor.url, { method: "GET" });
				}
				return response;
			})
			.then(function (response) {
				return checkResourceResponse(response, descriptor.url);
			});
	}

	function statResource(descriptor) {
		return headResource(descriptor).then(function (response) {
			var length = Number(response.headers.get("content-length")) || 0;
			var modified = Date.parse(response.headers.get("last-modified") || "");
			var mtime = isFinite(modified) ? modified : Date.now();
			return makeStats("file", mtime, mtime, length, descriptor.url);
		});
	}

	// ---------------------------------------------------------------------
	// fs.promises implementation
	// ---------------------------------------------------------------------

	function readFile(path, options) {
		return Promise.resolve().then(function () {
			var descriptor = resolvePath(path);
			var encoding = getEncoding(options);

			if (descriptor.kind === "resource") {
				return readResource(descriptor, encoding);
			}

			var operation = encoding && isUtf8(encoding) ? "read" : "readBinary";
			return api(operation, descriptor.rel).then(
				function (result) {
					cacheSet(descriptor.rel, "file");
					if (operation === "read") return result;
					var bytes = base64ToBytes(result && result.base64);
					return encoding ? decodeBytes(bytes, encoding) : bytes;
				},
				function (err) {
					if (err && err.code === "ENOENT") cacheDrop(descriptor.rel);
					throw err;
				}
			);
		});
	}

	function writeRequest(descriptor, data, options, append) {
		var encoding = getEncoding(options);
		var extra = {};
		if (options && typeof options === "object") {
			if (typeof options.ifMtimeMs === "number") extra.ifMtimeMs = options.ifMtimeMs;
			if (typeof options.token === "string") extra.token = options.token;
		}

		if (typeof Blob !== "undefined" && data instanceof Blob) {
			return data.arrayBuffer().then(function (buffer) {
				return writeRequest(descriptor, buffer, options, append);
			});
		}

		if (typeof data === "string" && isUtf8(encoding)) {
			var textOperation = append ? "append" : "write";
			var textArgs = Object.assign({ data: data }, extra);
			return api(textOperation, descriptor.rel, textArgs).then(function (result) {
				cacheSet(descriptor.rel, "file");
				return result;
			});
		}

		var bytes = typeof data === "string" ? encodeString(data, encoding) : toBytes(data);
		var binaryOperation = append ? "appendBinary" : "writeBinary";
		var binaryArgs = Object.assign({ base64: bytesToBase64(bytes) }, extra);
		return api(binaryOperation, descriptor.rel, binaryArgs).then(function (result) {
			cacheSet(descriptor.rel, "file");
			return result;
		});
	}

	function finishWrite(relative, result) {
		if (result && result.conflictSavedAs) {
			window.__MYOBS_LAST_CONFLICT = {
				path: relative,
				conflictSavedAs: result.conflictSavedAs,
				at: Date.now()
			};
			console.warn(
				"[my-obsidian] concurrent write detected; previous version saved as " +
				result.conflictSavedAs
			);
			/*
			 * DESIGN.md §5 requires the user to be told. The console entry and
			 * __MYOBS_LAST_CONFLICT only help whoever opens devtools; a silent
			 * conflict copy means the user keeps editing a file believing the
			 * other version is gone.
			 *
			 * The dedupeKey is shared on purpose with notices.js' conflict
			 * bridge (it consumes __MYOBS_LAST_CONFLICT with
			 * "fs:conflict:<path>"). Setting the field above already pushed
			 * one card; pushing the same key here replaces its message with
			 * this module's wording instead of stacking a second card.
			 */
			try {
				var conflictActions = [];
				try {
					if (window.app && window.app.workspace) {
						conflictActions.push({
							label: "顯示保留的舊版本",
							onClick: function () {
								// Never use workspace.openLinkText here. When the link
								// target is not in the vault index yet (the conflict
								// copy is only ~1s old), openLinkText falls through to
								// fileManager.createNewFile and plants a 0-byte note --
								// so clicking "show the saved copy" would create
								// garbage instead of opening it. Resolve the file and
								// open it, or say honestly that it is not indexed yet.
								var file =
									(window.app.vault &&
										window.app.vault.getAbstractFileByPath &&
										window.app.vault.getAbstractFileByPath(result.conflictSavedAs)) ||
									(window.app.metadataCache &&
										window.app.metadataCache.getFirstLinkpathDest &&
										window.app.metadataCache.getFirstLinkpathDest(
											result.conflictSavedAs,
											""
										));
								if (!file) {
									window.__MYOBS_NOTICES?.push?.({
										level: "warn",
										source: "fs",
										message:
											"找不到保留的舊版本：" +
											result.conflictSavedAs +
											"（可能尚未進入索引，或已被移動／刪除）",
										dedupeKey: "fs:conflict-missing:" + path
									});
									return;
								}
								window.app.workspace.getLeaf(false).openFile(file, { active: true });
							}
						});
					}
				} catch (actionErr) {
					conflictActions = [];
				}
				window.__MYOBS_NOTICES?.push?.({
					level: "warn",
					source: "fs",
					message:
						"偵測到同時寫入：" +
						relative +
						" 的舊版本已保留為 " +
						result.conflictSavedAs +
						"。目前畫面顯示的是你這次寫入的版本。",
					detail:
						"another writer changed the file between the read and this write; " +
						"the previous bytes are in " +
						result.conflictSavedAs,
					dedupeKey: "fs:conflict:" + relative,
					actions: conflictActions
				});
			} catch (err) {
				console.warn("[my-obsidian] could not surface the conflict copy", err);
			}
		}
		return undefined;
	}

	function writeFile(path, data, options) {
		return Promise.resolve().then(function () {
			var descriptor = requireVault(path);
			return writeRequest(descriptor, data, options, false).then(function (result) {
				return finishWrite(descriptor.rel, result);
			});
		});
	}

	function appendFile(path, data, options) {
		return Promise.resolve().then(function () {
			var descriptor = requireVault(path);
			return writeRequest(descriptor, data, options, true).then(function (result) {
				return finishWrite(descriptor.rel, result);
			});
		});
	}

	function stat(path) {
		return Promise.resolve().then(function () {
			var descriptor = resolvePath(path);
			if (descriptor.kind === "resource") {
				return statResource(descriptor);
			}
			return api("stat", descriptor.rel).then(function (result) {
				if (!result) {
					throw fsError("ENOENT", "ENOENT: no such file or directory, '" + path + "'", path);
				}
				cacheSet(descriptor.rel, result.type);
				return statsFromApi(result, descriptor.rel);
			});
		});
	}

	function lstat(path) {
		// The server's stat op follows symlinks; see GAPS.md.
		return stat(path);
	}

	function makeDirent(name, type, parentPath) {
		return {
			name: name,
			parentPath: parentPath,
			path: parentPath,
			isFile: function () {
				return type === "file";
			},
			isDirectory: function () {
				return type === "folder";
			},
			isBlockDevice: function () {
				return false;
			},
			isCharacterDevice: function () {
				return false;
			},
			isSymbolicLink: function () {
				return false;
			},
			isFIFO: function () {
				return false;
			},
			isSocket: function () {
				return false;
			}
		};
	}

	function readdir(path, options) {
		return Promise.resolve().then(function () {
			var descriptor = resolvePath(path);
			if (descriptor.kind === "resource") {
				throw fsError("EPERM", "EPERM: directory listing of static resources is not supported", path);
			}
			return api("list", descriptor.rel).then(function (result) {
				var files = (result && result.files) || [];
				var folders = (result && result.folders) || [];
				cacheSet(descriptor.rel, "folder");
				for (var i = 0; i < files.length; i++) {
					cacheSet(joinRel(descriptor.rel, files[i]), "file");
				}
				for (var j = 0; j < folders.length; j++) {
					cacheSet(joinRel(descriptor.rel, folders[j]), "folder");
				}

				if (options && typeof options === "object" && options.withFileTypes) {
					var absoluteParent = toPlatformPath(
						descriptor.rel ? joinAbs(vaultRoot, descriptor.rel) : vaultRoot
					);
					return files
						.map(function (name) {
							return makeDirent(name, "file", absoluteParent);
						})
						.concat(
							folders.map(function (name) {
								return makeDirent(name, "folder", absoluteParent);
							})
						);
				}
				return files.concat(folders);
			});
		});
	}

	function mkdir(path, options) {
		return Promise.resolve().then(function () {
			var descriptor = requireVault(path);
			return api("mkdir", descriptor.rel).then(function () {
				cacheSet(descriptor.rel, "folder");
			});
		});
	}

	function dropPath(path, operation, options, apiArgs) {
		return Promise.resolve().then(function () {
			var descriptor = requireVault(path);
			if (descriptor.rel === "") {
				throw fsError("EPERM", "EPERM: cannot remove the vault root", path);
			}
			return api(operation, descriptor.rel, apiArgs).then(
				function () {
					cacheDrop(descriptor.rel);
				},
				function (err) {
					if (options && options.force && err && err.code === "ENOENT") {
						cacheDrop(descriptor.rel);
						return;
					}
					throw err;
				}
			);
		});
	}

	function unlink(path) {
		return dropPath(path, "remove", null, undefined);
	}

	function rm(path, options) {
		var settings = options || {};
		if (settings.recursive === true) {
			// The server contract splits file removal (`remove`) from recursive
			// directory removal (`rmdir { recursive: true }`).
			return dropPath(path, "rmdir", settings, {
				recursive: true,
				token: typeof settings.token === "string" ? settings.token : undefined
			});
		}
		return dropPath(path, "remove", settings, {
			token: typeof settings.token === "string" ? settings.token : undefined
		});
	}

	function rmdir(path, options) {
		var settings = options || {};
		return dropPath(path, "rmdir", settings, {
			recursive: settings.recursive === true,
			token: typeof settings.token === "string" ? settings.token : undefined
		});
	}

	function rename(oldPath, newPath) {
		return Promise.resolve().then(function () {
			var from = requireVault(oldPath);
			var to = requireVault(newPath);
			return api("rename", from.rel, { to: to.rel }).then(function () {
				cacheMove(from.rel, to.rel);
			});
		});
	}

	function pathExists(relative) {
		return api("access", relative).then(
			function () {
				return true;
			},
			function (err) {
				if (err && err.code === "ENOENT") return false;
				throw err;
			}
		);
	}

	function copyFile(source, destination, flags) {
		return Promise.resolve().then(function () {
			var from = requireVault(source);
			var to = requireVault(destination);
			var exclusive = (Number(flags) || 0) & constants.COPYFILE_EXCL;
			var check = exclusive
				? pathExists(to.rel).then(function (exists) {
					if (exists) {
						throw fsError(
							"EEXIST",
							"EEXIST: file already exists, copyfile '" + source + "' -> '" + destination + "'",
							destination
						);
					}
				})
				: Promise.resolve();

			return check
				.then(function () {
					return api("copy", from.rel, { to: to.rel });
				})
				.then(function () {
					cacheSet(to.rel, "file");
				});
		});
	}

	function access(path, _mode) {
		return Promise.resolve().then(function () {
			var descriptor = resolvePath(path);
			if (descriptor.kind === "resource") {
				return headResource(descriptor).then(function () {
					return undefined;
				});
			}
			return api("access", descriptor.rel).then(function () {
				if (!cacheHas(descriptor.rel)) {
					cacheSet(descriptor.rel, "unknown");
				}
				return undefined;
			});
		});
	}

	function realpath(path) {
		return Promise.resolve().then(function () {
			var descriptor = resolvePath(path);
			if (descriptor.kind === "resource") {
				return toPlatformPath(descriptor.url);
			}
			return api("realpath", descriptor.rel).then(function (result) {
				var value = String(result == null ? "" : result);
				if (isAbsolute(toSlash(value))) {
					return toPlatformPath(value);
				}
				return toPlatformPath(joinAbs(vaultRoot, value));
			});
		});
	}

	function toMilliseconds(value) {
		if (value instanceof Date) return value.getTime();
		var numeric = Number(value);
		if (!isFinite(numeric)) {
			throw new TypeError("time value must be a number or Date");
		}
		// Node's fs.utimes() takes seconds; Obsidian passes mtime / 1000.
		return numeric < 1e12 ? numeric * 1000 : numeric;
	}

	function utimes(path, atime, mtime) {
		return Promise.resolve().then(function () {
			var descriptor = requireVault(path);
			var mtimeMs = toMilliseconds(mtime === undefined ? atime : mtime);
			return api("utimes", descriptor.rel, { mtimeMs: mtimeMs }).then(function () {
				return undefined;
			});
		});
	}

	var promises = {
		readFile: readFile,
		writeFile: writeFile,
		appendFile: appendFile,
		stat: stat,
		lstat: lstat,
		readdir: readdir,
		mkdir: mkdir,
		rmdir: rmdir,
		rm: rm,
		unlink: unlink,
		rename: rename,
		copyFile: copyFile,
		access: access,
		realpath: realpath,
		utimes: utimes,
		constants: constants
	};

	// ---------------------------------------------------------------------
	// Synchronous approximations
	// ---------------------------------------------------------------------

	function isProbePath(path) {
		return typeof path === "string" && baseName(path).toLowerCase() === ".obsidiantest";
	}

	function probeExists() {
		// FileSystemAdapter.testInsensitive() writes .OBSIDIANTEST and checks
		// the lowercase spelling. The probe is absorbed entirely by the shim.
		return PLATFORM === "darwin" || PLATFORM === "win32";
	}

	function existsSync(path) {
		if (isProbePath(path)) return probeExists();
		var descriptor;
		try {
			descriptor = resolvePath(path);
		} catch (err) {
			return false;
		}
		if (descriptor.kind === "resource") {
			// There is no synchronous way to HEAD a static URL. Cache entries
			// are only populated by async operations; see GAPS.md.
			return false;
		}
		return cacheHas(descriptor.rel);
	}

	function statsFromCache(descriptor) {
		var type = cacheType(descriptor.rel);
		if (descriptor.rel === "") type = "folder";
		if (!type) {
			throw fsError(
				"ENOENT",
				"ENOENT: no such file or directory (sync stat only sees cached paths), '" +
				descriptor.rel + "'",
				descriptor.rel
			);
		}
		var mtime = Date.now();
		return makeStats(type === "folder" ? "folder" : "file", mtime, mtime, 0, descriptor.rel);
	}

	function statSync(path) {
		if (isProbePath(path)) {
			return makeStats("file", Date.now(), Date.now(), 0, path);
		}
		return statsFromCache(requireVault(path));
	}

	function lstatSync(path) {
		return statSync(path);
	}

	function writeFileSync(path, data, options) {
		// Approximate synchronous write: the probe is swallowed, the cache is
		// updated immediately, and the real request is queued fire-and-forget.
		// Errors cannot be thrown to the caller (see GAPS.md).
		if (isProbePath(path)) return;

		var descriptor = requireVault(path);
		if (typeof Blob !== "undefined" && data instanceof Blob) {
			throw new TypeError("writeFileSync does not accept Blob in the browser shim");
		}
		// Optimistically populate the sync cache, then queue the actual write.
		cacheSet(descriptor.rel, "file");
		writeRequest(descriptor, data, options, false).catch(function (err) {
			console.error("[my-obsidian] queued writeFileSync failed for " + path, err);
		});
	}

	function unlinkSync(path) {
		// Approximate synchronous unlink: the probe is swallowed, the cache is
		// dropped immediately, and the real request is queued (see GAPS.md).
		if (isProbePath(path)) return;

		var descriptor = requireVault(path);
		cacheDrop(descriptor.rel);
		dropPath(path, "remove", null).catch(function (err) {
			console.error("[my-obsidian] queued unlinkSync failed for " + path, err);
		});
	}

	function readFileSync(path, options) {
		var descriptor = resolvePath(path);
		if (descriptor.kind !== "resource") {
			throw fsError(
				"ENOTSUP",
				"readFileSync is only available for static resources in the browser shim; " +
				"use fs.promises.readFile for vault files",
				path
			);
		}
		if (typeof XMLHttpRequest === "undefined") {
			throw fsError("ENOTSUP", "XMLHttpRequest is not available for a synchronous resource read", path);
		}
		var encoding = getEncoding(options);
		var xhr = new XMLHttpRequest();
		xhr.open("GET", encodeUrlPath(descriptor.url), false);
		if (!encoding || !isUtf8(encoding)) {
			xhr.responseType = "arraybuffer";
		}
		xhr.send(null);
		if (xhr.status === 404) {
			throw fsError("ENOENT", "ENOENT: no such file or directory, '" + path + "'", path);
		}
		if (xhr.status < 200 || xhr.status >= 300) {
			throw fsError("EIO", "HTTP " + xhr.status + " for static resource " + descriptor.url, path);
		}
		if (encoding && isUtf8(encoding)) {
			return xhr.responseText;
		}
		var bytes = new Uint8Array(xhr.response || new ArrayBuffer(0));
		return encoding ? decodeBytes(bytes, encoding) : bytes;
	}

	function exists(path, callback) {
		if (typeof callback === "function") {
			queueMicrotask(function () {
				callback(existsSync(path));
			});
		}
	}

	function makeWatcher() {
		// Fallback used when watch-shim.js is not loaded: preserve the emitter
		// shape Obsidian expects so the adapter can still register listeners.
		var watcher = {
			on: function () {
				return watcher;
			},
			once: function () {
				return watcher;
			},
			addListener: function () {
				return watcher;
			},
			removeListener: function () {
				return watcher;
			},
			removeAllListeners: function () {
				return watcher;
			},
			close: function () {},
			ref: function () {
				return watcher;
			},
			unref: function () {
				return watcher;
			}
		};
		return watcher;
	}

	function watch(path, options, listener) {
		// fs-shim is loaded before watch-shim (index.html order), so the check
		// has to happen per call, not at load time. When watch-shim is absent
		// (isolated harness, WATCH_DISABLED deployments) the no-op watcher keeps
		// boot working.
		var delegate = window.__MYOBS_WATCH;
		if (delegate && typeof delegate.watch === "function") {
			return delegate.watch(path, options, listener);
		}
		return makeWatcher();
	}

	var fs = {
		promises: promises,
		constants: constants,
		existsSync: existsSync,
		exists: exists,
		writeFileSync: writeFileSync,
		unlinkSync: unlinkSync,
		statSync: statSync,
		lstatSync: lstatSync,
		readFileSync: readFileSync,
		watch: watch
	};

	modules["fs"] = fs;
	modules["original-fs"] = fs;
})();
