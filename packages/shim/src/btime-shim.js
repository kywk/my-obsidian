/*
 * btime-shim.js — classic script.
 *
 * Obsidian uses btime in FileSystemAdapter.applyWriteOptions() to restore a
 * file's creation time. Browsers have no API to set birth time on a server
 * file, so this is an explicit no-op that reports success.
 */
(function () {
	"use strict";

	var modules = window.__MYOBS_MODULES || (window.__MYOBS_MODULES = {});

	function btime(_path, _time, callback) {
		if (typeof callback === "function") {
			queueMicrotask(function () {
				callback(null);
			});
		}
		return true;
	}

	btime.btime = btime;

	modules["btime"] = btime;
})();
