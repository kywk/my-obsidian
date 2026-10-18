/*
 * node-globals-shim.js — classic script.
 *
 * The renderer references bare Node globals, not only modules. The important
 * one is Buffer: app.js calls Buffer.from() in its own code (`toArrayBuffer`,
 * used by every binary read/write) and bundled libraries reference
 * Buffer.concat/alloc/isView. In Electron these exist; in a browser they do
 * not, and the failure is "Buffer is not defined" on the *binary* paths only --
 * text editing keeps working, so a text-only smoke test hides it entirely.
 *
 * Also registers the util / buffer / querystring modules from DESIGN.md §7.
 */
(function () {
	"use strict";

	var modules = window.__MYOBS_MODULES || (window.__MYOBS_MODULES = {});

	// ---------------------------------------------------------------------
	// Encoding helpers
	// ---------------------------------------------------------------------

	var textDecoder = typeof TextDecoder === "function" ? new TextDecoder("utf-8") : null;
	var textEncoder = typeof TextEncoder === "function" ? new TextEncoder() : null;

	function utf8Encode(string) {
		if (textEncoder) return textEncoder.encode(string);
		// Fallback: encodeURIComponent handles surrogate pairs correctly.
		var binary = unescape(encodeURIComponent(string));
		var bytes = new Uint8Array(binary.length);
		for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	}

	function utf8Decode(bytes) {
		if (textDecoder) return textDecoder.decode(bytes);
		var binary = "";
		for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
		try {
			return decodeURIComponent(escape(binary));
		} catch (err) {
			return binary;
		}
	}

	function latin1Decode(bytes) {
		var out = "";
		for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
		return out;
	}

	function base64Encode(bytes) {
		var binary = latin1Decode(bytes);
		return btoa(binary);
	}

	function base64Decode(string) {
		var binary = atob(string);
		var bytes = new Uint8Array(binary.length);
		for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	}

	function hexEncode(bytes) {
		var out = "";
		for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
		return out;
	}

	function hexDecode(string) {
		var clean = String(string).replace(/[^0-9a-fA-F]/g, "");
		var length = clean.length >> 1;
		var bytes = new Uint8Array(length);
		for (var i = 0; i < length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
		return bytes;
	}

	function normalizeEncoding(encoding) {
		var value = (encoding === undefined || encoding === null ? "utf8" : String(encoding)).toLowerCase();
		if (value === "utf-8") return "utf8";
		if (value === "binary") return "latin1";
		if (value === "ucs2" || value === "ucs-2" || value === "utf-16le") return "utf16le";
		return value;
	}

	function bytesForString(string, encoding) {
		switch (normalizeEncoding(encoding)) {
			case "utf8":
				return utf8Encode(string);
			case "latin1":
			case "ascii": {
				var out = new Uint8Array(string.length);
				for (var i = 0; i < string.length; i++) out[i] = string.charCodeAt(i) & 0xff;
				return out;
			}
			case "utf16le": {
				var pairs = new Uint8Array(string.length * 2);
				for (var j = 0; j < string.length; j++) {
					var code = string.charCodeAt(j);
					pairs[j * 2] = code & 0xff;
					pairs[j * 2 + 1] = code >> 8;
				}
				return pairs;
			}
			case "base64":
				return base64Decode(string);
			case "hex":
				return hexDecode(string);
			default:
				throw new TypeError("Unknown encoding: " + encoding);
		}
	}

	function stringFromBytes(bytes, encoding) {
		switch (normalizeEncoding(encoding)) {
			case "utf8":
				return utf8Decode(bytes);
			case "latin1":
			case "ascii":
				return latin1Decode(bytes);
			case "utf16le": {
				var out = "";
				for (var i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
				return out;
			}
			case "base64":
				return base64Encode(bytes);
			case "hex":
				return hexEncode(bytes);
			default:
				throw new TypeError("Unknown encoding: " + encoding);
		}
	}

	// ---------------------------------------------------------------------
	// Buffer
	//
	// A Uint8Array subclass with the subset of Node's API that the renderer and
	// the common plugin stacks actually call. `toString`/`write`/`slice` are
	// overridden because Node's differ from Uint8Array's defaults.
	// ---------------------------------------------------------------------

	var BufferShim = (function () {
		function Buffer(arg, encodingOrOffset, length) {
			return Buffer.from(arg, encodingOrOffset, length);
		}

		function toUint8Array(value) {
			if (ArrayBuffer.isView(value)) {
				return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
			}
			if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
			if (Array.isArray(value)) {
				var fromArray = new Uint8Array(value.length);
				for (var i = 0; i < value.length; i++) fromArray[i] = value[i] & 0xff;
				return fromArray;
			}
			throw new TypeError("Unsupported value for Buffer: " + typeof value);
		}

		function make(bytes) {
			Object.setPrototypeOf(bytes, Buffer.prototype);
			return bytes;
		}

		Buffer.from = function (value, encodingOrOffset, length) {
			if (typeof value === "string") return make(bytesForString(value, encodingOrOffset));
			if (value instanceof ArrayBuffer) {
				var offset = encodingOrOffset || 0;
				var size = length === undefined ? value.byteLength - offset : length;
				// Node shares memory here; the renderer only ever reads through
				// it, and copying is the safer default for a shim.
				return make(new Uint8Array(value, offset, size).slice());
			}
			if (ArrayBuffer.isView(value) || Array.isArray(value)) return make(toUint8Array(value));
			if (value && value.type === "Buffer" && Array.isArray(value.data)) return make(toUint8Array(value.data));
			throw new TypeError("Unsupported value for Buffer.from: " + typeof value);
		};

		Buffer.of = function () {
			return make(toUint8Array(Array.prototype.slice.call(arguments)));
		};

		Buffer.alloc = function (size, fill, encoding) {
			var bytes = new Uint8Array(size);
			if (fill !== undefined) {
				if (typeof fill === "string") bytes.set(bytesForString(fill, encoding).subarray(0, size));
				else bytes.fill(fill);
			}
			return make(bytes);
		};

		// Real allocUnsafe is uninitialised memory; a shim must never hand out
		// whatever happened to be in the heap, so this is alloc.
		Buffer.allocUnsafe = Buffer.alloc;
		Buffer.allocUnsafeSlow = Buffer.alloc;

		Buffer.isBuffer = function (value) {
			return value instanceof Buffer.prototype.constructor || (value && value.__myobsBuffer === true);
		};

		Buffer.byteLength = function (string, encoding) {
			if (typeof string !== "string") return string.byteLength;
			return bytesForString(string, encoding).length;
		};

		Buffer.concat = function (list, totalLength) {
			var total = totalLength;
			if (total === undefined) {
				total = 0;
				for (var i = 0; i < list.length; i++) total += list[i].length;
			}
			var out = new Uint8Array(total);
			var offset = 0;
			for (var j = 0; j < list.length; j++) {
				var chunk = toUint8Array(list[j]);
				var room = total - offset;
				if (room <= 0) break;
				out.set(chunk.subarray(0, Math.min(chunk.length, room)), offset);
				offset += Math.min(chunk.length, room);
			}
			return make(out);
		};

		Buffer.compare = function (a, b) {
			return Buffer.from(a).compare(Buffer.from(b));
		};

		Buffer.isEncoding = function (encoding) {
			try {
				bytesForString("", encoding);
				return true;
			} catch (err) {
				return false;
			}
		};

		Object.setPrototypeOf(Buffer.prototype, Uint8Array.prototype);
		Object.defineProperty(Buffer.prototype, "constructor", { value: Buffer, writable: true, configurable: true });
		Buffer.prototype.__myobsBuffer = true;

		Buffer.prototype.toString = function (encoding, start, end) {
			var view = this.subarray(start || 0, end === undefined ? this.length : end);
			return stringFromBytes(view, encoding);
		};

		Buffer.prototype.write = function (string, offset, length, encoding) {
			if (typeof offset === "string") {
				encoding = offset;
				offset = 0;
				length = this.length;
			} else if (typeof length === "string") {
				encoding = length;
				length = this.length - (offset || 0);
			}
			offset = offset || 0;
			if (length === undefined) length = this.length - offset;
			var bytes = bytesForString(string, encoding);
			var count = Math.min(bytes.length, length, this.length - offset);
			this.set(bytes.subarray(0, count), offset);
			return count;
		};

		Buffer.prototype.copy = function (target, targetStart, sourceStart, sourceEnd) {
			var to = targetStart || 0;
			var from = sourceStart || 0;
			var end = sourceEnd === undefined ? this.length : sourceEnd;
			var chunk = this.subarray(from, end);
			var count = Math.min(chunk.length, target.length - to);
			target.set(chunk.subarray(0, count), to);
			return count;
		};

		Buffer.prototype.equals = function (other) {
			return this.compare(other) === 0;
		};

		Buffer.prototype.compare = function (other) {
			var a = this;
			var b = toUint8Array(other);
			var limit = Math.min(a.length, b.length);
			for (var i = 0; i < limit; i++) {
				if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
			}
			if (a.length === b.length) return 0;
			return a.length < b.length ? -1 : 1;
		};

		Buffer.prototype.slice = function (start, end) {
			// Node's Buffer#slice shares memory, unlike Uint8Array#slice.
			return make(new Uint8Array(this.buffer, this.byteOffset, this.length).subarray(start, end));
		};

		Buffer.prototype.toJSON = function () {
			return { type: "Buffer", data: Array.prototype.slice.call(this) };
		};

		Buffer.prototype.inspect = function () {
			return "<Buffer " + hexEncode(this) + ">";
		};

		["readUInt8", "readUInt16LE", "readUInt16BE", "readUInt32LE", "readUInt32BE"].forEach(function (name) {
			var width = Number(name.slice(-2, -2 + 1)) || 1;
			Buffer.prototype[name] = function (offset) {
				offset = offset || 0;
				var bytes = name.slice(-2);
				var isLittle = bytes === "LE";
				var size = name.indexOf("32") > 0 ? 4 : name.indexOf("16") > 0 ? 2 : 1;
				var out = 0;
				for (var i = 0; i < size; i++) {
					var index = offset + (isLittle ? i : size - 1 - i);
					out = out * 256 + (this[index] || 0);
				}
				return out;
			};
			void width;
		});

		["writeUInt8", "writeUInt16LE", "writeUInt16BE", "writeUInt32LE", "writeUInt32BE"].forEach(function (name) {
			Buffer.prototype[name] = function (value, offset) {
				offset = offset || 0;
				var isLittle = name.slice(-2) === "LE";
				var size = name.indexOf("32") > 0 ? 4 : name.indexOf("16") > 0 ? 2 : 1;
				for (var i = 0; i < size; i++) {
					var index = offset + (isLittle ? i : size - 1 - i);
					if (index < this.length) this[index] = (value >> (8 * i)) & 0xff;
				}
				return offset + size;
			};
		});

		Buffer.prototype.swap16 = function () {
			for (var i = 0; i + 1 < this.length; i += 2) {
				var tmp = this[i];
				this[i] = this[i + 1];
				this[i + 1] = tmp;
			}
			return this;
		};

		Buffer.prototype.swap32 = function () {
			for (var i = 0; i + 3 < this.length; i += 4) {
				var a = this[i];
				var b = this[i + 1];
				this[i] = this[i + 3];
				this[i + 1] = this[i + 2];
				this[i + 2] = b;
				this[i + 3] = a;
			}
			return this;
		};

		Buffer.poolSize = 8192;
		Buffer.INSPECT_MAX_BYTES = 50;
		Buffer.kMaxLength = 0x7fffffff;

		return Buffer;
	})();

	// ---------------------------------------------------------------------
	// util (DESIGN.md §7 whitelist)
	// ---------------------------------------------------------------------

	function inspectValue(value, depth, seen) {
		if (value === null) return "null";
		var type = typeof value;
		if (type === "string") return "'" + value + "'";
		if (type === "function") return "[Function" + (value.name ? ": " + value.name : "") + "]";
		if (type !== "object") return String(value);
		if (BufferShim.isBuffer(value)) return value.inspect();
		if (value instanceof Error) return value.stack || (value.name + ": " + value.message);
		if (depth > 2) return Array.isArray(value) ? "[Array]" : "[Object]";
		if (seen.indexOf(value) >= 0) return "[Circular]";
		seen.push(value);
		var prefix = "  ".repeat(depth);
		var inner = "  ".repeat(depth + 1);
		if (Array.isArray(value)) {
			if (value.length === 0) return "[]";
			var items = value.map(function (item) {
				return inner + inspectValue(item, depth + 1, seen);
			});
			return "[\n" + items.join(",\n") + "\n" + prefix + "]";
		}
		var keys = Object.keys(value);
		if (keys.length === 0) return "{}";
		var pairs = keys.map(function (key) {
			return inner + key + ": " + inspectValue(value[key], depth + 1, seen);
		});
		return "{\n" + pairs.join(",\n") + "\n" + prefix + "}";
	}

	var util = {
		format: function (format) {
			var args = Array.prototype.slice.call(arguments, 1);
			var index = 0;
			return String(format).replace(/%[sdifjoOc%]/g, function (token) {
				if (token === "%%") return "%";
				if (index >= args.length) return token;
				var value = args[index++];
				switch (token) {
					case "%s":
						return String(value);
					case "%d":
					case "%f":
						return Number(value);
					case "%i":
						return parseInt(value, 10);
					case "%j":
						try {
							return JSON.stringify(value);
						} catch (err) {
							return "[Circular]";
						}
					case "%o":
					case "%O":
						return inspectValue(value, 0, []);
					case "%c":
						return "";
					default:
						return token;
				}
			});
		},
		inspect: function (value) {
			return inspectValue(value, 0, []);
		},
		inherits: function (ctor, superCtor) {
			ctor.super_ = superCtor;
			Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
		},
		deprecate: function (fn, message) {
			var warned = false;
			return function () {
				if (!warned) {
					warned = true;
					console.warn(message);
				}
				return fn.apply(this, arguments);
			};
		},
		promisify: function (fn) {
			if (fn && fn[util.promisify.custom]) return fn[util.promisify.custom];
			return function () {
				var args = Array.prototype.slice.call(arguments);
				var self = this;
				return new Promise(function (resolve, reject) {
					args.push(function (err, value) {
						if (err) reject(err);
						else resolve(value);
					});
					fn.apply(self, args);
				});
			};
		},
		callbackify: function (fn) {
			return function () {
				var args = Array.prototype.slice.call(arguments);
				var callback = args.pop();
				fn.apply(this, args).then(
					function (value) {
						callback(null, value);
					},
					function (err) {
						callback(err);
					}
				);
			};
		},
		types: {
			isDate: function (v) {
				return v instanceof Date;
			},
			isRegExp: function (v) {
				return v instanceof RegExp;
			},
			isPromise: function (v) {
				return v instanceof Promise;
			},
			isMap: function (v) {
				return v instanceof Map;
			},
			isSet: function (v) {
				return v instanceof Set;
			},
			isNativeError: function (v) {
				return v instanceof Error;
			},
			isTypedArray: function (v) {
				return ArrayBuffer.isView(v) && !(v instanceof DataView);
			},
			isArrayBuffer: function (v) {
				return v instanceof ArrayBuffer;
			},
			isAnyArrayBuffer: function (v) {
				return v instanceof ArrayBuffer || (typeof SharedArrayBuffer === "function" && v instanceof SharedArrayBuffer);
			},
			isAsyncFunction: function (v) {
				return typeof v === "function" && v.constructor && v.constructor.name === "AsyncFunction";
			},
			isGeneratorFunction: function (v) {
				return typeof v === "function" && v.constructor && v.constructor.name.indexOf("GeneratorFunction") >= 0;
			}
		},
		isDeepStrictEqual: function (a, b) {
			if (a === b) return true;
			if (typeof a !== typeof b) return false;
			if (a === null || b === null) return false;
			if (typeof a !== "object") {
				// NaN === NaN is false with ===, but deepStrictEqual treats them as equal.
				return a !== a && b !== b;
			}
			if (BufferShim.isBuffer(a) || BufferShim.isBuffer(b)) {
				return BufferShim.isBuffer(a) && BufferShim.isBuffer(b) && a.equals(b);
			}
			var aIsArray = Array.isArray(a);
			if (aIsArray !== Array.isArray(b)) return false;
			if (a instanceof Date || b instanceof Date) {
				return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
			}
			var keysA = Object.keys(a);
			var keysB = Object.keys(b);
			if (keysA.length !== keysB.length) return false;
			for (var i = 0; i < keysA.length; i++) {
				if (!Object.prototype.hasOwnProperty.call(b, keysA[i])) return false;
				if (!util.isDeepStrictEqual(a[keysA[i]], b[keysA[i]])) return false;
			}
			return true;
		},
		debuglog: function () {
			return function () {};
		},
		TextEncoder: typeof TextEncoder === "function" ? TextEncoder : undefined,
		TextDecoder: typeof TextDecoder === "function" ? TextDecoder : undefined
	};
	util.promisify.custom = typeof Symbol === "function" ? Symbol("util.promisify.custom") : "__util_promisify_custom__";
	util.formatWithOptions = function (_options, format) {
		return util.format.apply(null, Array.prototype.slice.call(arguments, 1));
	};
	util.types.isUint8Array = function (v) {
		return v instanceof Uint8Array;
	};

	// ---------------------------------------------------------------------
	// querystring
	// ---------------------------------------------------------------------

	var querystring = {
		escape: encodeURIComponent,
		unescape: decodeURIComponent,
		parse: function (input) {
			var out = Object.create(null);
			var source = String(input === undefined ? "" : input).replace(/^[?#]/, "");
			if (source.length === 0) return out;
			source.split("&").forEach(function (pair) {
				if (pair.length === 0) return;
				var index = pair.indexOf("=");
				var key = index < 0 ? pair : pair.slice(0, index);
				var value = index < 0 ? "" : pair.slice(index + 1);
				var decodedKey = querystring.unescape(key.replace(/\+/g, " "));
				var decodedValue = querystring.unescape(value.replace(/\+/g, " "));
				if (out[decodedKey] === undefined) out[decodedKey] = decodedValue;
				else if (Array.isArray(out[decodedKey])) out[decodedKey].push(decodedValue);
				else out[decodedKey] = [out[decodedKey], decodedValue];
			});
			return out;
		},
		stringify: function (object, separator, equals) {
			var sep = separator === undefined ? "&" : separator;
			var eq = equals === undefined ? "=" : equals;
			var parts = [];
			Object.keys(object || {}).forEach(function (key) {
				var value = object[key];
				var values = Array.isArray(value) ? value : [value];
				values.forEach(function (item) {
					parts.push(
						querystring.escape(key) +
							eq +
							querystring.escape(item === undefined || item === null ? "" : String(item))
					);
				});
			});
			return parts.join(sep);
		}
	};

	// ---------------------------------------------------------------------
	// Registration
	// ---------------------------------------------------------------------

	// `global` and `setImmediate` are not used by app.js itself (checked), but
	// bundled third-party code and plugins routinely feature-detect them.
	if (typeof window.global === "undefined") window.global = window;
	if (typeof window.setImmediate !== "function") {
		window.setImmediate = function (fn) {
			var args = Array.prototype.slice.call(arguments, 1);
			return window.setTimeout(function () {
				fn.apply(null, args);
			}, 0);
		};
	}
	if (typeof window.clearImmediate !== "function") {
		window.clearImmediate = function (handle) {
			window.clearTimeout(handle);
		};
	}

	if (typeof window.Buffer === "undefined") window.Buffer = BufferShim;

	modules["buffer"] = { Buffer: BufferShim, kMaxLength: BufferShim.kMaxLength, constants: { MAX_LENGTH: BufferShim.kMaxLength } };
	modules["util"] = util;
	modules["querystring"] = querystring;
})();
