/*
 * net-rewrite.js — classic script.
 *
 * Obsidian's community-plugin browser talks to github.com and
 * raw.githubusercontent.com directly through `requestUrl`, which the shim
 * forwards to the browser's fetch. Those hosts do not send CORS headers, so
 * every such request fails and the Browse UI is dead.
 *
 * This module is the seam where a rewrite can be installed. electron-shim's
 * request-url handler consults `window.__MYOBS_REQUEST_REWRITE` at call time
 * and, when it returns a URL, fetches that instead. The server exposes
 * /api/proxy for exactly these hosts.
 *
 * The host list here is a UX hint only. The server re-validates every request
 * and is the enforcement point (packages/server/src/proxy.js).
 *
 * Controls:
 *   window.__MYOBS_NET.enabled = false   turn the rewrite off at runtime
 *   window.__MYOBS_NET.stats             counters and the last failure
 */
(function () {
	"use strict";

	// Guard against a double load: wrapping fetch twice would double-count and
	// print every warning twice.
	if (window.__MYOBS_NET && window.__MYOBS_NET.__installed === true) return;

	// Must mirror PROXY_ALLOWED_HOSTS in packages/server/src/proxy.js.
	var PROXY_HOSTS = {
		"github.com": true,
		"api.github.com": true,
		"raw.githubusercontent.com": true,
		"objects.githubusercontent.com": true,
		"github-releases.githubusercontent.com": true,
		// GitHub moved release-asset downloads here; the same host must be in
		// PROXY_ALLOWED_HOSTS in packages/server/src/proxy.js.
		"release-assets.githubusercontent.com": true,
		"codeload.github.com": true,
		"obsidian.md": true,
		"forum.obsidian.md": true,
		"help.obsidian.md": true
	};

	var state = {
		enabled: true,
		rewritten: 0,
		skipped: 0,
		denied: 0,
		missing: 0,
		lastUrl: null,
		lastError: null
	};

	// One console line per host+status, not per request: the plugin browser
	// retries the same URL on every keystroke and would otherwise flood the
	// console.
	var noted = {};

	/**
	 * The notice surface is optional: this shim can run before it (or without
	 * it in a popout realm), and a failure here must not affect the fetch.
	 */
	function notify(payload) {
		try {
			var api = window.__MYOBS_NOTICES;
			if (api && typeof api.push === "function") api.push(payload);
		} catch (err) {
			// Never let a notice break the request path.
		}
	}

	function hostOf(url) {
		try {
			return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
		} catch (err) {
			return null;
		}
	}

	function shouldProxy(url) {
		if (!state.enabled) return false;
		if (typeof url !== "string" || url.length === 0) return false;
		// Only absolute https URLs; relative requests are already same-origin.
		if (url.slice(0, 8) !== "https://") return false;
		var host = hostOf(url);
		if (!host) return false;
		return PROXY_HOSTS[host] === true;
	}

	function rewrite(url) {
		if (!shouldProxy(url)) {
			state.skipped += 1;
			return null;
		}
		state.rewritten += 1;
		state.lastUrl = url;
		return "/api/proxy?url=" + encodeURIComponent(url);
	}

	function noteFailure(host, status, code, detail) {
		var key = String(host) + "|" + String(status) + "|" + String(code || "");
		if (noted[key] === true) return;
		noted[key] = true;

		var name = host || "(unknown host)";
		var message;
		var notice;

		if (status === 404 && code === "MISSING_ROUTE") {
			message =
				"[my-obsidian] /api/proxy 不存在（HTTP 404）：這個 server 版本沒有代理路由。\n" +
				"請更新並重新啟動 server；若要暫時停用改寫，設定 window.__MYOBS_NET.enabled = false" +
				"（GitHub 主機在瀏覽器端會因 CORS 失敗，Browse 仍然不可用）。";
			notice = {
				level: "warn",
				source: "proxy",
				message: "/api/proxy 不存在（HTTP 404）：這個 server 版本沒有代理路由。",
				detail:
					"社群外掛 Browse 的下載會全部失敗。\n" +
					"請更新並重新啟動 server；若要暫時停用改寫，設定 " +
					"window.__MYOBS_NET.enabled = false（GitHub 主機在瀏覽器端會因 CORS 失敗）。",
				dedupeKey: "proxy-missing-route"
			};
		} else if (code === "UNMARKED_403" || code === "UNMARKED_401") {
			/*
			 * The auth hook (AUTH_TOKEN) and any reverse proxy answer before
			 * /api/proxy runs, so the response has no X-MyOBS-Proxy marker.
			 * Sending the operator to the allowlist here would be wrong.
			 */
			message =
				"[my-obsidian] /api/proxy 拒絕 " + name + "（HTTP " + status + "）：\n" +
				(detail || "回應缺少 X-MyOBS-Proxy 標記。") + "\n" +
				"請確認瀏覽器帶有正確的 myobs_token cookie（AUTH_TOKEN），或反向代理沒有攔截 /api/proxy。";
			notice = {
				level: "warn",
				source: "proxy",
				message:
					"代理請求被拒絕（HTTP " + status + "）：" + name +
					" 不是 allowlist 問題，而是身分驗證或反向代理阻擋。",
				detail:
					"這個回應沒有 X-MyOBS-Proxy 標記，代表請求還沒到 /api/proxy。\n" +
					(detail || "") + "\n\n" +
					"請檢查：\n" +
					"1. 瀏覽器是否帶有正確的 myobs_token cookie（對應 server 的 AUTH_TOKEN）。\n" +
					"2. 反向代理是否攔截 /api/proxy，或改寫成需要額外登入的端點。",
				dedupeKey: "proxy-auth:" + status
			};
		} else {
			message =
				"[my-obsidian] /api/proxy 拒絕 " + name + "（HTTP " + status +
				(code ? ", " + code : "") + "）：\n" +
				(detail || "server 端 allowlist 不含這個 host。") + "\n" +
				"要支援它，請把 host 加入 packages/server/src/proxy.js 的 PROXY_ALLOWED_HOSTS，" +
				"並同步 packages/shim/src/net-rewrite.js 的 PROXY_HOSTS。";
			notice = {
				level: "warn",
				source: "proxy",
				message:
					"代理拒絕 " + name + "（HTTP 403）：這個 host 不在 server 的 allowlist。",
				detail:
					(detail || "server 的 SSRF/allowlist 規則拒絕了這個 URL。") + "\n" +
					(code ? "錯誤碼：" + code + "\n" : "") + "\n" +
					"要支援它，請編輯 packages/server/src/proxy.js 的 PROXY_ALLOWED_HOSTS，" +
					"同步 packages/shim/src/net-rewrite.js 的 PROXY_HOSTS，然後重新啟動 server。" +
					"同一個 host 只會提示一次。",
				dedupeKey: "proxy-host:" + name
			};
		}

		state.lastError = { host: name, status: status, code: code || null, message: message };
		try {
			console.error(message);
		} catch (err) {
			// console may be unavailable in exotic embeddings; the stats still hold.
		}
		notify(notice);
	}

	var nativeFetch =
		typeof window.fetch === "function" ? window.fetch.bind(window) : null;

	if (nativeFetch) {
		window.fetch = function (input, init) {
			var isProxyCall =
				typeof input === "string" && input.indexOf("/api/proxy?") === 0;
			var host = null;
			if (isProxyCall) {
				try {
					var absolute = new URL(input, window.location.href);
					var target = absolute.searchParams.get("url");
					host = target ? hostOf(target) : null;
				} catch (err) {
					host = null;
				}
			}

			var pending = nativeFetch(input, init);
			if (!isProxyCall) return pending;

			return pending.then(function (response) {
				var marked = response.headers.get("x-myobs-proxy") === "1";
				if (!marked) {
					if (response.status === 404) {
						// A 404 without our marker means the route itself is absent,
						// not that GitHub returned 404 for the upstream URL.
						state.missing += 1;
						noteFailure(host, 404, "MISSING_ROUTE", null);
					} else if (response.status === 403 || response.status === 401) {
						// The auth hook (AUTH_TOKEN) and reverse proxies answer
						// before the proxy route runs, so there is no marker to
						// inspect. This is not an allowlist problem.
						state.denied += 1;
						noteFailure(
							host,
							response.status,
							response.status === 401 ? "UNMARKED_401" : "UNMARKED_403",
							"這個 HTTP " + response.status +
								" 不是 proxy 的 allowlist 回應（缺少 X-MyOBS-Proxy 標記），" +
								"通常是 AUTH_TOKEN 未通過或反向代理擋下請求。"
						);
					}
					return response;
				}
				if (response.status === 403 || response.status === 404) {
					var errorCode = response.headers.get("x-myobs-proxy-error");
					if (errorCode) {
						state.denied += 1;
						noteFailure(
							host,
							response.status,
							errorCode,
							"server 的 SSRF/allowlist 規則拒絕了這個 URL。"
						);
					}
					// No error header: the status came from upstream (for example
					// a deleted release asset). That is a normal response.
				}
				return response;
			});
		};
	}

	window.__MYOBS_REQUEST_REWRITE = rewrite;
	window.__MYOBS_NET = {
		__installed: true,
		get enabled() {
			return state.enabled;
		},
		set enabled(value) {
			state.enabled = value === true;
		},
		get stats() {
			return {
				enabled: state.enabled,
				rewritten: state.rewritten,
				skipped: state.skipped,
				denied: state.denied,
				missing: state.missing,
				lastUrl: state.lastUrl,
				lastError: state.lastError
			};
		},
		hosts: Object.keys(PROXY_HOSTS),
		rewrite: rewrite
	};

	// Informational: the runtime page is served by our own server, so the proxy
	// route exists wherever this file does.
	window.__MYOBS_NET.proxyAvailable = true;
})();
