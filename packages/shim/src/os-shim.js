/*
 * os-shim.js — classic script.
 *
 * Covers the os surface Obsidian touches at boot
 * (hostname / version / release / platform / arch) plus the calls the
 * allow-listed plugins (for example BRAT) commonly make.
 */
(function () {
	"use strict";

	var boot = window.__MYOBS || {};
	var modules = window.__MYOBS_MODULES || (window.__MYOBS_MODULES = {});

	var platform = boot.platform || "darwin";
	var arch = boot.arch || "arm64";

	function hostname() {
		if (typeof boot.deviceName === "string" && boot.deviceName) return boot.deviceName;
		if (typeof window.location !== "undefined" && window.location.hostname) {
			return window.location.hostname;
		}
		return "my-obsidian";
	}

	// navigator.userAgentData is the closest browser equivalent of the OS
	// release string. Fall back to an empty string instead of inventing data.
	function browserPlatformVersion() {
		if (navigator.userAgentData && typeof navigator.userAgentData.platform === "string") {
			return navigator.userAgentData.platform;
		}
		return "";
	}

	function homedir() {
		var base = boot.documentsDir || boot.desktopDir || boot.vaultPath || "";
		var text = String(base).replace(/[\\/]+$/, "");
		var index = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
		if (index <= 0) return platform === "win32" ? "C:\\" : "/";
		return text.slice(0, index);
	}

	var os = {
		EOL: platform === "win32" ? "\r\n" : "\n",
		hostname: hostname,
		type: function () {
			if (platform === "win32") return "Windows_NT";
			if (platform === "darwin") return "Darwin";
			return "Linux";
		},
		platform: function () {
			return platform;
		},
		arch: function () {
			return arch;
		},
		release: function () {
			return browserPlatformVersion();
		},
		version: function () {
			// Obsidian only shows this in the About panel. The browser cannot
			// read the kernel version, so identify the runtime instead.
			return browserPlatformVersion() || "my-obsidian browser runtime";
		},
		tmpdir: function () {
			return platform === "win32" ? "C:\\Windows\\Temp" : "/tmp";
		},
		homedir: homedir,
		endianness: function () {
			var buffer = new ArrayBuffer(2);
			new DataView(buffer).setInt16(0, 256, true);
			return new Int16Array(buffer)[0] === 256 ? "LE" : "BE";
		},
		loadavg: function () {
			return [0, 0, 0];
		},
		uptime: function () {
			return (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) / 1000;
		},
		totalmem: function () {
			return 0;
		},
		freemem: function () {
			return 0;
		},
		cpus: function () {
			return [];
		},
		networkInterfaces: function () {
			return {};
		},
		userInfo: function () {
			return {
				username: "my-obsidian",
				uid: -1,
				gid: -1,
				shell: null,
				homedir: homedir()
			};
		},
		constants: {
			signals: {},
			errno: {},
			priority: {}
		}
	};

	modules["os"] = os;
})();
