/*
 * crypto-shim.js — classic script.
 *
 * Maps the Node crypto surface Obsidian and allow-listed plugins use onto
 * window.crypto. Synchronous primitives that a browser cannot provide
 * (scrypt, createHash, createHmac, pbkdf2, ...) throw a named error instead
 * of silently returning broken data; see ../GAPS.md.
 */
(function () {
	"use strict";

	var modules = window.__MYOBS_MODULES || (window.__MYOBS_MODULES = {});

	var webcrypto = window.crypto || null;

	function requireWebCrypto() {
		if (!webcrypto) {
			throw new Error("crypto is not available in this browser context");
		}
		return webcrypto;
	}

	function getRandomValues(typedArray) {
		return requireWebCrypto().getRandomValues(typedArray);
	}

	function randomBytes(size, callback) {
		var length = Number(size);
		if (!isFinite(length) || length < 0) {
			throw new TypeError("size must be a non-negative number");
		}
		var bytes = new Uint8Array(length);
		var crypto = requireWebCrypto();
		var max = 65536;
		for (var offset = 0; offset < length; offset += max) {
			crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + max, length)));
		}
		if (typeof callback === "function") {
			queueMicrotask(function () {
				callback(null, bytes);
			});
			return undefined;
		}
		return bytes;
	}

	function randomFillSync(buffer, offset, size) {
		var view;
		if (buffer instanceof ArrayBuffer) {
			view = new Uint8Array(buffer);
		} else if (ArrayBuffer.isView(buffer)) {
			view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
		} else {
			throw new TypeError("buffer must be an ArrayBuffer or TypedArray");
		}
		var start = offset === undefined ? 0 : Number(offset) || 0;
		var end = size === undefined ? view.length : start + (Number(size) || 0);
		requireWebCrypto().getRandomValues(view.subarray(start, end));
		return buffer;
	}

	function randomInt(min, max) {
		if (max === undefined) {
			max = min;
			min = 0;
		}
		var range = max - min;
		if (range <= 0) throw new RangeError("max must be greater than min");
		var bytes = new Uint32Array(1);
		var limit = Math.floor(0x100000000 / range) * range;
		var value;
		do {
			requireWebCrypto().getRandomValues(bytes);
			value = bytes[0];
		} while (value >= limit);
		return min + (value % range);
	}

	function randomUUID() {
		var crypto = requireWebCrypto();
		if (typeof crypto.randomUUID === "function") {
			return crypto.randomUUID();
		}
		var bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		bytes[6] = (bytes[6] & 0x0f) | 0x40;
		bytes[8] = (bytes[8] & 0x3f) | 0x80;
		var hex = [];
		for (var i = 0; i < bytes.length; i++) {
			hex.push((bytes[i] < 16 ? "0" : "") + bytes[i].toString(16));
		}
		return (
			hex.slice(0, 4).join("") + "-" +
			hex.slice(4, 6).join("") + "-" +
			hex.slice(6, 8).join("") + "-" +
			hex.slice(8, 10).join("") + "-" +
			hex.slice(10, 16).join("")
		);
	}

	function unsupported(name) {
		var error = new Error("crypto." + name + " is not available in the browser shim");
		error.code = "MODULE_NOT_SUPPORTED";
		return error;
	}

	var cryptoShim = {
		getRandomValues: getRandomValues,
		randomBytes: randomBytes,
		randomFillSync: randomFillSync,
		randomInt: randomInt,
		randomUUID: randomUUID,
		subtle: webcrypto ? webcrypto.subtle : undefined,
		webcrypto: webcrypto,
		constants: {},
		scrypt: function () {
			throw new Error("crypto.scrypt is not available in the browser shim");
		},
		scryptSync: function () {
			throw new Error("crypto.scryptSync is not available in the browser shim");
		},
		createHash: function () {
			throw unsupported("createHash");
		},
		createHmac: function () {
			throw unsupported("createHmac");
		},
		pbkdf2: function () {
			throw unsupported("pbkdf2");
		},
		pbkdf2Sync: function () {
			throw unsupported("pbkdf2Sync");
		},
		createCipheriv: function () {
			throw unsupported("createCipheriv");
		},
		createDecipheriv: function () {
			throw unsupported("createDecipheriv");
		},
		timingSafeEqual: function (a, b) {
			var left = a instanceof Uint8Array ? a : new Uint8Array(a);
			var right = b instanceof Uint8Array ? b : new Uint8Array(b);
			if (left.length !== right.length) return false;
			var diff = 0;
			for (var i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
			return diff === 0;
		}
	};

	modules["crypto"] = cryptoShim;
})();
