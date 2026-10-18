#!/usr/bin/env node
/**
 * Real-user community-plugin install check.
 *
 * Drives a disposable vault copy through Obsidian's own Settings → Community
 * plugins → Browse → Install flow, exactly as a user would, and reports both
 * the UI outcome and every network request the renderer made.
 *
 * The point of this harness is to answer a question unit tests cannot: does the
 * shipped renderer's Browse/Install path actually work against our server? The
 * renderer uses `requestUrl` for GitHub and `app.vault.adapter.write` for the
 * files, so the expected path is:
 *
 *   community-plugins.json  -> requestUrl -> /api/proxy -> raw.githubusercontent.com
 *   release assets          -> requestUrl -> /api/proxy -> github.com (302 to
 *                              release-assets.githubusercontent.com)
 *   manifest/main.js/styles -> adapter.write -> /api/fs
 *
 * It does NOT call POST /api/plugins/install; that endpoint is a separate,
 * programmatic install path (CONTRACTS.md §9). The harness records this as a
 * fact rather than assuming it.
 *
 * Usage:
 *   node tools/plugin-install-check.mjs --vault <copy> [--port 3905]
 *        [--chrome-port 4905] [--json out.json] [--log server.log]
 *
 * The vault argument must be a copy, never ~/kywk/obsidian. The terms
 * acknowledgement is read from vendor/obsidian/app.js at runtime and never
 * written to disk or printed (AGENTS.md hard rule 3).
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  Cdp,
  clickAt,
  evalInPage,
  launchChrome,
  listPageTargets,
  readTermsFromVendor,
  sleep,
  startServer,
  waitForPage,
} from './lib/cdp.mjs';

const LIVE_VAULT = '/Users/kywk/kywk/obsidian';

/** Partial report printed when the harness throws before finishing. */
let activeReport = null;

const PLUGIN_PRESETS = {
  'advanced-tables': {
    id: 'table-editor-obsidian',
    name: 'Advanced Tables',
    repo: 'tgrosinger/advanced-tables-obsidian',
  },
  // Obsidian Git's display name is "Git", not "obsidian-git"; the fuzzy
  // search result list is capped at 200 entries, so searching "git" does not
  // reliably put it on screen. Kept as an explicit preset for manual runs.
  'obsidian-git': {
    id: 'obsidian-git',
    name: 'Git',
    repo: 'vinzent03/obsidian-git',
  },
};

function parseArgs(argv) {
  const out = {
    vault: null,
    port: 3905,
    chromePort: 4905,
    timeout: 90,
    installTimeout: 30,
    plugin: 'advanced-tables',
    json: null,
    log: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--vault') out.vault = argv[++i];
    else if (arg === '--port') out.port = Number(argv[++i]);
    else if (arg === '--chrome-port') out.chromePort = Number(argv[++i]);
    else if (arg === '--timeout') out.timeout = Number(argv[++i]);
    else if (arg === '--install-timeout') out.installTimeout = Number(argv[++i]);
    else if (arg === '--plugin') out.plugin = argv[++i];
    else if (arg === '--json') out.json = argv[++i];
    else if (arg === '--log') out.log = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: node tools/plugin-install-check.mjs --vault <copy> ' +
          '[--port 3905] [--chrome-port 4905] [--plugin advanced-tables|obsidian-git]',
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function assertDisposableVault(vault) {
  if (!vault) throw new Error('--vault is required (pass a copy, never the live vault)');
  const absolute = fs.realpathSync(vault);
  if (!fs.statSync(absolute).isDirectory()) throw new Error(`not a directory: ${absolute}`);
  const live = fs.existsSync(LIVE_VAULT) ? fs.realpathSync(LIVE_VAULT) : LIVE_VAULT;
  if (absolute === live) {
    throw new Error(
      `refusing to run against the live vault ${absolute}; create a copy with rsync first`,
    );
  }
  return absolute;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function proxyTarget(url) {
  try {
    return new URL(url, 'http://127.0.0.1').searchParams.get('url');
  } catch {
    return null;
  }
}

function header(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

function parseCount(text) {
  const match = /([\d,]+)/.exec(text ?? '');
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function shortUrl(url, max = 180) {
  if (typeof url !== 'string') return String(url);
  if (url.startsWith('data:')) return `data:${url.length} bytes`;
  if (url.startsWith('blob:')) return url.slice(0, 80);
  return url.length > max ? `${url.slice(0, max)}…` : url;
}

function formatDuration(ms) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Find a visible button by exact text inside the community-plugin modal.
 *
 * @param {Cdp} cdp
 * @param {string} sessionId
 * @param {string} text
 * @returns {Promise<{x:number,y:number,text:string,cls:string} | null>}
 */
async function findModalButton(cdp, sessionId, text) {
  return evalInPage(
    cdp,
    sessionId,
    `(() => {
      const modal = document.querySelector('.modal.mod-community-modal');
      if (!modal) return null;
      const re = new RegExp('^' + ${JSON.stringify(text)} + '$', 'i');
      const button = [...modal.querySelectorAll('button')].find(
        (candidate) => re.test(candidate.textContent.trim()) && candidate.offsetParent !== null,
      );
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        text: button.textContent.trim(),
        cls: button.className,
      };
    })()`,
  );
}

async function waitForModalButton(cdp, sessionId, text, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const button = await findModalButton(cdp, sessionId, text).catch(() => null);
    if (button) return button;
    await sleep(150);
  }
  return null;
}

/**
 * Obsidian's Community plugins browser opens in a popout window when Browse is
 * clicked with a trusted (real) user gesture: it calls window.open(), and the
 * runtime's popout shim supplies the window. In that case the modal lives in a
 * separate page target, not in the main document.
 *
 * @param {Cdp} cdp
 * @param {string} mainTargetId
 * @param {Map<string, string>} attached targetId -> sessionId
 * @returns {Promise<{targetId:string, sessionId:string, title:string, cards:number} | null>}
 */
async function findCommunityPopout(cdp, mainTargetId, attached) {
  const targets = await listPageTargets(cdp);
  for (const target of targets) {
    if (target.targetId === mainTargetId) continue;
    let session = attached.get(target.targetId);
    if (!session) {
      try {
        const result = await cdp.send('Target.attachToTarget', {
          targetId: target.targetId,
          flatten: true,
        });
        session = result.sessionId;
      } catch {
        continue;
      }
      attached.set(target.targetId, session);
      await cdp.send('Runtime.enable', {}, session).catch(() => {});
      await cdp.send('Network.enable', {}, session).catch(() => {});
    }
    const cards = await evalInPage(
      cdp,
      session,
      `document.querySelectorAll('.community-item').length`,
    ).catch(() => 0);
    if (cards > 0) {
      return {
        targetId: target.targetId,
        sessionId: session,
        title: target.title,
        cards,
      };
    }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const vault = assertDisposableVault(args.vault);
  const preset = PLUGIN_PRESETS[args.plugin];
  if (!preset) {
    throw new Error(
      `unknown --plugin "${args.plugin}"; choose one of ${Object.keys(PLUGIN_PRESETS).join(', ')}`,
    );
  }

  const pluginDir = path.join(vault, '.obsidian', 'plugins', preset.id);
  if (fs.existsSync(pluginDir)) {
    throw new Error(
      `target plugin is already installed at ${pluginDir}; use a fresh vault copy so the check starts from a known state`,
    );
  }

  const terms = readTermsFromVendor();
  const server = await startServer(vault, args.port, terms);
  const chrome = await launchChrome(args.chromePort);
  const cdp = new Cdp(chrome.wsUrl);

  /** @type {{
   *   criteria: Record<string, boolean>,
   *   facts: Record<string, any>,
   *   results: {name: string, ok: boolean, detail: string}[],
   *   network: {
   *     requests: any[], proxyResponses: any[], pluginFs: any[], other: any[],
   *     failures: any[], fs: {requests: number, non200: number, failures: number},
   *     serverPluginCalls: string[]
   *   },
   *   console: {errors: string[], warnings: string[], exceptions: string[]},
   * }} report
   */
  const report = {
    vault,
    port: args.port,
    chromePort: args.chromePort,
    plugin: preset,
    startedAt: new Date().toISOString(),
    criteria: {},
    facts: {},
    results: [],
    network: {
      requests: [],
      proxyResponses: [],
      pluginFs: [],
      other: [],
      failures: [],
      fs: { requests: 0, non200: 0, failures: 0 },
      serverPluginCalls: [],
    },
    console: { errors: [], warnings: [], exceptions: [] },
  };
  activeReport = report;

  /** @param {string} name @param {boolean} ok @param {string} detail */
  function check(name, ok, detail) {
    report.criteria[name] = ok;
    report.results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(10)} ${detail}`);
  }

  const requestById = new Map();
  const proxyById = new Map();
  let fsPluginRequestIds = new Set();

  try {
    await cdp.connect();
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const mainTargetId = targetId;
    const mainSessionId = sessionId;
    let uiSessionId = mainSessionId;
    let uiTargetId = mainTargetId;
    let uiKind = 'main';
    /** @type {Map<string, string>} */
    const attachedTargets = new Map([[mainTargetId, mainSessionId]]);

    cdp.on((msg) => {
      if (msg.method === 'Network.requestWillBeSent') {
        const request = msg.params.request;
        const url = request.url ?? '';
        const postData = request.postData ?? '';
        let fsOp = null;
        let fsPath = null;
        if (url.includes('/api/fs') && postData.length > 0) {
          try {
            const parsed = JSON.parse(postData);
            fsOp = typeof parsed.op === 'string' ? parsed.op : null;
            fsPath = typeof parsed.path === 'string' ? parsed.path : null;
          } catch {
            // The display copy is truncated; the op/path are optional.
          }
        }
        const entry = {
          kind: msg.params.redirectResponse ? 'redirect' : 'request',
          id: msg.params.requestId,
          sessionId: msg.sessionId,
          url,
          method: request.method,
          fsOp,
          fsPath,
          postData:
            url.includes('/api/fs') && postData.length > 0
              ? postData.slice(0, 500)
              : undefined,
          redirectStatus: msg.params.redirectResponse?.status,
        };
        requestById.set(msg.params.requestId, entry);

        if (url.includes('/api/fs')) {
          report.network.fs.requests += 1;
          if (postData.includes('.obsidian')) {
            fsPluginRequestIds.add(msg.params.requestId);
            report.network.pluginFs.push(entry);
          }
        } else if (url.includes('/api/proxy')) {
          const proxy = {
            id: msg.params.requestId,
            sessionId: msg.sessionId,
            url,
            target: proxyTarget(url),
            method: request.method,
            status: null,
            mime: null,
            proxyError: null,
            upstreamError: null,
          };
          proxyById.set(msg.params.requestId, proxy);
          report.network.proxyResponses.push(proxy);
          report.network.requests.push(entry);
        } else if (/^https?:/i.test(url) || url.startsWith('ws')) {
          report.network.other.push(entry);
          report.network.requests.push(entry);
        }

        if (url.includes('/api/plugins')) {
          report.network.serverPluginCalls.push(url);
        }
      } else if (msg.method === 'Network.responseReceived') {
        const response = msg.params.response;
        const url = response.url ?? '';
        if (url.includes('/api/fs')) {
          if (fsPluginRequestIds.has(msg.params.requestId)) {
            report.network.pluginFs.push({
              kind: 'response',
              id: msg.params.requestId,
              url,
              status: response.status,
            });
          }
          if (response.status !== 200) {
            report.network.fs.non200 += 1;
          }
          return;
        }

        if (url.includes('/api/proxy')) {
          const proxy = proxyById.get(msg.params.requestId);
          if (proxy) {
            proxy.status = response.status;
            proxy.mime = response.mimeType;
            proxy.proxyError = header(response.headers, 'x-myobs-proxy-error');
            proxy.upstreamError =
              response.status >= 400 && proxy.proxyError === null
                ? header(response.headers, 'x-myobs-proxy') === '1'
                  ? 'upstream'
                  : 'unmarked'
                : null;
          }
          return;
        }

        report.network.other.push({
          kind: 'response',
          id: msg.params.requestId,
          url,
          status: response.status,
          mime: response.mimeType,
        });
      } else if (msg.method === 'Network.loadingFailed') {
        const request = requestById.get(msg.params.requestId);
        const failure = {
          kind: 'failed',
          id: msg.params.requestId,
          url: request?.url ?? null,
          errorText: msg.params.errorText,
          blockedReason: msg.params.blockedReason ?? null,
          corsErrorStatus: msg.params.corsErrorStatus ?? null,
          type: msg.params.type,
        };
        report.network.failures.push(failure);
        if (request?.url?.includes('/api/fs')) report.network.fs.failures += 1;
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args ?? [])
          .map((arg) => arg.value ?? arg.description ?? arg.type)
          .join(' ')
          .slice(0, 1200);
        if (msg.params.type === 'error') report.console.errors.push(text);
        else if (msg.params.type === 'warning') report.console.warnings.push(text);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const details = msg.params.exceptionDetails;
        report.console.exceptions.push(
          (details.exception?.description || details.text || 'unknown exception').slice(0, 1200),
        );
      }
    });

    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Log.enable', {}, sessionId).catch(() => {});

    const url = `http://127.0.0.1:${args.port}/`;
    const bootStarted = Date.now();
    await cdp.send('Page.navigate', { url }, sessionId);

    const booted = await waitForPage(
      cdp,
      sessionId,
      '!!window.app && !!app.metadataCache && app.metadataCache.initialized === true',
      args.timeout * 1000,
    );
    const fatal = await evalInPage(
      cdp,
      sessionId,
      '(function(){var e=document.getElementById("myobs-fatal");return !!(e && !e.hidden && e.style.display !== "none");})()',
    ).catch(() => false);
    if (fatal) {
      const detail = await evalInPage(
        cdp,
        sessionId,
        '(document.getElementById("myobs-fatal-detail")||{}).textContent || ""',
      ).catch(() => '');
      throw new Error(`runtime showed the fatal screen:\n${detail}`);
    }
    if (!booted) throw new Error('window.app / metadataCache never became ready');
    report.facts.bootMs = Date.now() - bootStarted;

    const evaluate = (expression, options = {}) =>
      evalInPage(cdp, sessionId, expression, options);
    const evaluateUi = (expression, options = {}) =>
      evalInPage(cdp, uiSessionId, expression, options);

    // ---- Settings → Community plugins -------------------------------------
    await evaluate(`app.setting.open(); app.setting.openTabById('community-plugins'); true;`);
    await sleep(800);

    // A fresh browser profile starts in Restricted Mode even when the vault
    // already has community plugins. The first-run dialog offers "Trust author
    // and enable plugins"; clicking it is exactly what a user does before the
    // Browse button exists. This is a disposable copy, so trusting it is safe.
    let trusted = null;
    if (!(await evaluate('app.plugins.isEnabled()'))) {
      const patterns = [
        'trust author.*enable',
        'enable plugins',
        'exit restricted',
        'turn on community plugins',
        '信任.*啟用',
        '啟用社群外掛',
        '退出受限模式',
      ];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        trusted = await evaluate(`(() => {
          const patterns = ${JSON.stringify(patterns)};
          const buttons = [...document.querySelectorAll('button')];
          for (const source of patterns) {
            const re = new RegExp(source, 'i');
            const button = buttons.find(
              (candidate) => re.test(candidate.textContent) && candidate.offsetParent !== null,
            );
            if (button) {
              button.click();
              return { text: button.textContent.trim(), cls: button.className };
            }
          }
          return null;
        })()`);
        if (trusted) break;
        await sleep(500);
      }
      if (trusted) {
        await waitForPage(cdp, sessionId, 'app.plugins.isEnabled() === true', 15000);
      }
    }
    report.facts.restrictedMode = {
      trustedWith: trusted,
      enabled: await evaluate('app.plugins.isEnabled()').catch(() => null),
    };

    // The first-run security dialog can take a moment to close. Clicking
    // Browse while its overlay is still present sends the click to the overlay.
    await waitForPage(
      cdp,
      sessionId,
      `![...document.querySelectorAll('button')].some(
        (button) => /browse vault in restricted mode/i.test(button.textContent) &&
                    button.offsetParent !== null,
      )`,
      10000,
    ).catch(() => false);

    // A trust click on some builds reloads the renderer; reopen the tab so the
    // Browse button is definitely present (the call is idempotent).
    await evaluate(`app.setting.open(); app.setting.openTabById('community-plugins'); true;`).catch(
      () => {},
    );
    // Enabling a vault's plugins is asynchronous (19 onloads here). Clicking
    // Browse while the settings tab is still re-rendering loses the click: the
    // button rect captured a moment earlier is already stale.
    await sleep(2500);
    await waitForPage(
      cdp,
      sessionId,
      `[...document.querySelectorAll('.vertical-tab-content button')].some(
        (button) => /browse/i.test(button.textContent) && button.offsetParent !== null,
      )`,
      10000,
    ).catch(() => false);
    // The "Indexing vault…" notice sits over the settings pane and swallows
    // coordinate clicks. It disappears on its own; wait for it when possible,
    // but do not let a stuck notice abort the check (the Browse fallback below
    // still works).
    await waitForPage(
      cdp,
      sessionId,
      `![...document.querySelectorAll('.notice')].some(
        (notice) => /indexing/i.test(notice.innerText) && notice.offsetParent !== null,
      )`,
      20000,
    ).catch(() => false);
    await sleep(300);

    const browseButton = await evaluate(`(() => {
      const button = [...document.querySelectorAll('.vertical-tab-content button')].find(
        (candidate) => /browse/i.test(candidate.textContent) && candidate.offsetParent !== null,
      );
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        text: button.textContent.trim(),
        cls: button.className,
      };
    })()`);
    if (!browseButton) {
      const texts = await evaluate(
        `[...document.querySelectorAll('.vertical-tab-content button')].map(b => b.textContent.trim()).filter(Boolean)`,
      ).catch(() => []);
      throw new Error(`Browse button not found; settings buttons: ${JSON.stringify(texts)}`);
    }
    const hitTest = await evaluate(`(() => {
      const element = document.elementFromPoint(${browseButton.x}, ${browseButton.y});
      return element
        ? { tag: element.tagName, cls: element.className, text: (element.textContent || '').slice(0, 80) }
        : null;
    })()`).catch(() => null);
    report.facts.browseButton = { ...browseButton, hitTest };

    const browseStarted = Date.now();
    await clickAt(cdp, sessionId, { x: browseButton.x, y: browseButton.y });
    let browseClickMethod = 'real-mouse-click';
    let fallbackClicked = false;
    let popout = null;
    let mainCards = 0;
    let catalogRequested = false;
    const browseDeadline = Date.now() + 25000;
    while (Date.now() < browseDeadline) {
      popout = await findCommunityPopout(cdp, mainTargetId, attachedTargets).catch(() => null);
      if (popout) break;
      mainCards = await evaluate(
        `document.querySelectorAll('.modal.mod-community-modal .community-item').length`,
      ).catch(() => 0);
      if (mainCards > 0) break;
      catalogRequested = report.network.proxyResponses.some((entry) =>
        entry.target?.includes('community-plugins.json'),
      );
      if (!fallbackClicked && !catalogRequested && Date.now() - browseStarted > 12000) {
        // The settings tab re-renders while plugins load; a coordinate click
        // can land on a stale position. Fall back to the element's own click
        // handler (the task's real-click requirement is for Install).
        fallbackClicked = true;
        browseClickMethod = 'dom-click-fallback';
        await evaluate(`(() => {
          const button = [...document.querySelectorAll('.vertical-tab-content button')].find(
            (candidate) => /browse/i.test(candidate.textContent) && candidate.offsetParent !== null,
          );
          if (!button) return false;
          button.click();
          return true;
        })()`);
      }
      await sleep(300);
    }

    if (popout) {
      uiSessionId = popout.sessionId;
      uiTargetId = popout.targetId;
      uiKind = 'popout';
      await cdp.send('Target.activateTarget', { targetId: popout.targetId }).catch(() => {});
      report.facts.ui = {
        kind: 'popout',
        targetId: popout.targetId,
        title: popout.title,
        cards: popout.cards,
      };
    } else {
      report.facts.ui = {
        kind: mainCards > 0 ? 'main' : 'none',
        targetId: mainTargetId,
        cards: mainCards,
      };
    }
    report.facts.browseClickMethod = browseClickMethod;

    const cardsReady = await waitForPage(
      cdp,
      uiSessionId,
      `document.querySelectorAll('.modal.mod-community-modal .community-item').length > 0`,
      15000,
    );
    if (!cardsReady) {
      const diagnostics = await evaluateUi(`(() => ({
        settingsText: (document.querySelector('.vertical-tab-content')?.innerText || '').slice(0, 1500),
        modals: [...document.querySelectorAll('.modal-container')].map(
          (modal) => (modal.innerText || '').slice(0, 600),
        ),
        cards: document.querySelectorAll('.community-item').length,
        summary: document.querySelector('.community-modal-search-summary')?.innerText || null,
        browseClickMethod: ${JSON.stringify(browseClickMethod)},
        popoutFrames: (window.__MYOBS_POPOUT?.frames || []).length,
        buttons: [...document.querySelectorAll('button')]
          .filter((button) => button.offsetParent !== null)
          .map((button) => button.textContent.trim())
          .filter(Boolean),
      }))()`).catch((err) => ({ error: String(err.message || err) }));
      console.error('\n[diagnostics] no cards after clicking Browse');
      console.error(JSON.stringify({ ...diagnostics, ui: report.facts.ui }, null, 2));
      console.error('[diagnostics] proxy responses');
      console.error(JSON.stringify(report.network.proxyResponses, null, 2));
      console.error('[diagnostics] loading failures');
      console.error(JSON.stringify(report.network.failures, null, 2));
      console.error('[diagnostics] console');
      console.error(JSON.stringify(report.console, null, 2));
      throw new Error('community plugin browser did not render any cards');
    }

    // The renderer virtualizes the list: 9,097 plugins initially, then ~200
    // cards in the DOM. Sample for a moment and keep the maximum.
    let maxCards = 0;
    let summary = '';
    let catalogCount = null;
    const catalogDeadline = Date.now() + 20000;
    while (Date.now() < catalogDeadline) {
      const state = await evaluateUi(`(() => ({
        cards: document.querySelectorAll('.modal.mod-community-modal .community-item').length,
        summary: (document.querySelector('.community-modal-search-summary')?.innerText || '').trim(),
      }))()`).catch(() => ({ cards: 0, summary: '' }));
      maxCards = Math.max(maxCards, state.cards || 0);
      summary = state.summary || summary;
      const shown = parseCount(summary);
      if ((shown !== null && shown > 1000) || maxCards > 100) break;
      await sleep(300);
    }

    // Parse the catalog response body for the strongest possible evidence.
    const catalogRequest = report.network.proxyResponses.find(
      (entry) => entry.target?.includes('community-plugins.json') && entry.method === 'GET',
    );
    if (catalogRequest) {
      try {
        const body = await cdp.send(
          'Network.getResponseBody',
          { requestId: catalogRequest.id },
          catalogRequest.sessionId ?? sessionId,
        );
        const text = body.base64Encoded
          ? Buffer.from(body.body, 'base64').toString('utf8')
          : body.body;
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) catalogCount = parsed.length;
      } catch (err) {
        report.facts.catalogBodyError = String(err.message || err);
      }
    }

    const catalogOk =
      (catalogCount !== null && catalogCount > 1000) || maxCards > 100;
    check(
      'catalog',
      catalogOk,
      `catalog=${catalogCount ?? 'unparsed'} entries, DOM cards=${maxCards}, summary="${summary}", ` +
        `proxy=${catalogRequest?.status ?? 'missing'}`,
    );
    report.facts.catalogCount = catalogCount;
    report.facts.catalogCards = maxCards;
    report.facts.catalogSummary = summary;
    report.facts.catalogProxy = catalogRequest ?? null;

    // ---- Search for a plugin that is not installed -------------------------
    const searchInput = await evaluateUi(`(() => {
      const input = document.querySelector('.community-modal-search input[type=search]');
      if (!input) return null;
      input.focus();
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const rect = input.getBoundingClientRect();
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        placeholder: input.placeholder,
      };
    })()`);
    if (!searchInput) throw new Error('community plugin search input not found');

    // Focus the field directly. A coordinate click is not reliable here: the
    // indexing notice can still be over the pane, and losing focus would make
    // Input.insertText a no-op (which previously left the full 9,097-item list
    // on screen and produced a false "search passed" result).
    const focused = await evaluateUi(`(() => {
      const input = document.querySelector('.community-modal-search input[type=search]');
      if (!input) return false;
      input.focus();
      return document.activeElement === input;
    })()`);
    report.facts.searchFocused = focused;
    await cdp.send('Input.insertText', { text: preset.name }, uiSessionId);

    const searchDeadline = Date.now() + 15000;
    let searchState = null;
    while (Date.now() < searchDeadline) {
      searchState = await evaluateUi(`(() => {
        const cards = [...document.querySelectorAll('.modal.mod-community-modal .community-item')];
        const names = cards.map((card) => (card.innerText || '').split('\\n')[0].trim());
        return {
          total: cards.length,
          summary: (document.querySelector('.community-modal-search-summary')?.innerText || '').trim(),
          names: names.slice(0, 20),
          exact: names.some((name) =>
            name.toLowerCase().startsWith(${JSON.stringify(preset.name.toLowerCase())}),
          ),
        };
      })()`).catch(() => null);
      const shown = parseCount(searchState?.summary);
      searchState.shown = shown;
      // A real search must narrow the list, not merely leave the full catalog
      // on screen where the target happens to be findable.
      searchState.narrowed = shown !== null && shown < 1000;
      if (searchState.exact && searchState.narrowed) break;
      await sleep(300);
    }
    check(
      'search',
      searchState?.exact === true && searchState?.narrowed === true,
      `query="${preset.name}" → "${searchState?.summary ?? 'no summary'}", ` +
        `cards=${searchState?.total ?? 0}, narrowed=${searchState?.narrowed}, ` +
        `names=${JSON.stringify(searchState?.names?.slice(0, 8) ?? [])}`,
    );
    report.facts.search = searchState;

    if (!searchState?.exact || !searchState?.narrowed) {
      throw new Error(
        `search did not narrow to ${preset.name}; summary=${searchState?.summary}, ` +
          `results=${JSON.stringify(searchState?.names)}`,
      );
    }

    // ---- Select the card and click Install --------------------------------
    const card = await evaluateUi(`(() => {
      const cards = [...document.querySelectorAll('.modal.mod-community-modal .community-item')];
      const target = cards.find((candidate) =>
        (candidate.innerText || '').trim().toLowerCase().startsWith(
          ${JSON.stringify(preset.name.toLowerCase())},
        ),
      );
      if (!target) return null;
      target.scrollIntoView({ block: 'center' });
      const rect = target.getBoundingClientRect();
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        text: (target.innerText || '').slice(0, 300),
      };
    })()`);
    if (!card) throw new Error('matching card disappeared before it could be clicked');
    await clickAt(cdp, uiSessionId, { x: card.x, y: card.y });
    report.facts.selectedCard = card.text;

    const installButton = await waitForModalButton(cdp, uiSessionId, 'Install', 15000);
    if (!installButton) {
      const buttons = await evaluateUi(
        `[...document.querySelectorAll('.modal.mod-community-modal button')].map(b => b.textContent.trim()).filter(Boolean)`,
      ).catch(() => []);
      throw new Error(`Install button not found; detail buttons: ${JSON.stringify(buttons)}`);
    }

    const installStarted = Date.now();
    await clickAt(cdp, uiSessionId, { x: installButton.x, y: installButton.y });

    const manifestPath = path.join(pluginDir, 'manifest.json');
    const mainPath = path.join(pluginDir, 'main.js');
    let manifestId = null;
    let mainBytes = 0;
    let installedAt = null;
    const installDeadline = Date.now() + args.installTimeout * 1000;
    while (Date.now() < installDeadline) {
      if (fs.existsSync(manifestPath) && fs.existsSync(mainPath)) {
        try {
          const manifest = readJson(manifestPath);
          manifestId = typeof manifest.id === 'string' ? manifest.id : null;
        } catch {
          manifestId = null;
        }
        mainBytes = fileSize(mainPath);
        if (manifestId !== null && mainBytes > 0) {
          installedAt = Date.now();
          break;
        }
      }
      await sleep(200);
    }
    const installElapsed = installedAt === null ? null : installedAt - installStarted;

    // Wait for the renderer's own post-install bookkeeping (loadManifest) so
    // the optional styles.css fetch has completed before the network report.
    await waitForPage(
      cdp,
      sessionId,
      `!!app.plugins.manifests[${JSON.stringify(preset.id)}]`,
      15000,
    ).catch(() => false);
    await sleep(1200);

    const releaseResponses = report.network.proxyResponses.filter((entry) =>
      /\/releases\/download\//.test(entry.target ?? ''),
    );
    // styles.css is optional (Obsidian catches its 404); only the two files the
    // install contract names are mandatory.
    const requiredRelease = releaseResponses.filter((entry) =>
      /(?:manifest\.json|main\.js)(?:\?|$)/.test(entry.target ?? ''),
    );
    const releaseOk =
      requiredRelease.length >= 2 && requiredRelease.every((entry) => entry.status === 200);
    const installOk =
      installElapsed !== null &&
      installElapsed <= args.installTimeout * 1000 &&
      manifestId === preset.id &&
      mainBytes > 0 &&
      releaseOk;
    check(
      'install',
      installOk,
      installElapsed === null
        ? `no manifest.json + non-empty main.js within ${args.installTimeout}s`
        : `${formatDuration(installElapsed)}, manifest.id=${manifestId}, main.js=${mainBytes} bytes, ` +
            `release assets=${releaseResponses.map((entry) => `${entry.status}`).join(',') || 'none'}`,
    );
    report.facts.install = {
      elapsedMs: installElapsed,
      manifestId,
      mainBytes,
      stylesBytes: fileSize(path.join(pluginDir, 'styles.css')),
      files: fs.existsSync(pluginDir) ? fs.readdirSync(pluginDir) : [],
      releaseResponses,
    };

    // ---- Enable ------------------------------------------------------------
    let enabledBy = null;
    let enabledState = null;
    const enableButton = await waitForModalButton(cdp, uiSessionId, 'Enable', 12000);
    if (enableButton) {
      await clickAt(cdp, uiSessionId, { x: enableButton.x, y: enableButton.y });
      enabledBy = 'ui-click';
    } else {
      enabledState = await evaluate(`({
        enabled: app.plugins.enabledPlugins.has(${JSON.stringify(preset.id)}),
        loaded: !!app.plugins.plugins[${JSON.stringify(preset.id)}],
      })`).catch(() => null);
      if (enabledState?.enabled === true) {
        enabledBy = 'already-enabled-after-install';
      } else {
        await evaluate(
          `app.plugins.enablePluginAndSave(${JSON.stringify(preset.id)})`,
        );
        enabledBy = 'api-fallback';
      }
    }

    const enableDeadline = Date.now() + 12000;
    while (Date.now() < enableDeadline) {
      enabledState = await evaluate(`({
        enabled: app.plugins.enabledPlugins.has(${JSON.stringify(preset.id)}),
        loaded: !!app.plugins.plugins[${JSON.stringify(preset.id)}],
        version: app.plugins.manifests[${JSON.stringify(preset.id)}]?.version ?? null,
      })`).catch(() => null);
      if (enabledState?.enabled === true && enabledState?.loaded === true) break;
      await sleep(200);
    }
    check(
      'enable',
      enabledState?.enabled === true && enabledState?.loaded === true,
      `via=${enabledBy}, enabledPlugins=${enabledState?.enabled}, plugins[id]=${enabledState?.loaded}, ` +
        `version=${enabledState?.version ?? 'unknown'}`,
    );
    report.facts.enable = { by: enabledBy, ...enabledState };

    // ---- Disable -----------------------------------------------------------
    let disabledBy = null;
    const disableButton = await waitForModalButton(cdp, uiSessionId, 'Disable', 12000);
    if (disableButton) {
      await clickAt(cdp, uiSessionId, { x: disableButton.x, y: disableButton.y });
      disabledBy = 'ui-click';
    } else {
      await evaluate(`app.plugins.disablePluginAndSave(${JSON.stringify(preset.id)})`);
      disabledBy = 'api-fallback';
    }

    const disableDeadline = Date.now() + 12000;
    let disabledState = null;
    while (Date.now() < disableDeadline) {
      disabledState = await evaluate(`({
        enabled: app.plugins.enabledPlugins.has(${JSON.stringify(preset.id)}),
        loaded: !!app.plugins.plugins[${JSON.stringify(preset.id)}],
      })`).catch(() => null);
      if (disabledState?.enabled === false && disabledState?.loaded === false) break;
      await sleep(200);
    }
    let enabledList = null;
    let listClean = false;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      try {
        enabledList = readJson(path.join(vault, '.obsidian', 'community-plugins.json'));
      } catch {
        enabledList = null;
      }
      listClean = Array.isArray(enabledList) && !enabledList.includes(preset.id);
      if (listClean) break;
      await sleep(200);
    }
    const filesRemain = fs.existsSync(mainPath);
    check(
      'disable',
      disabledState?.enabled === false && disabledState?.loaded === false && listClean,
      `via=${disabledBy}, enabledPlugins=${disabledState?.enabled}, plugins[id]=${disabledState?.loaded}, ` +
        `community-plugins.json=${listClean ? 'clean' : 'unchanged/missing'}, files remain=${filesRemain}`,
    );
    report.facts.disable = {
      by: disabledBy,
      ...disabledState,
      enabledList,
      filesRemain,
    };

    // ---- Uninstall (the UI path, not POST /api/plugins/uninstall) ----------
    // This is an extra observation: Obsidian's own Uninstall button calls
    // adapter.rmdir(), so it must be distinguished from the server endpoint.
    const uninstallButton = await waitForModalButton(cdp, uiSessionId, 'Uninstall', 12000);
    let uninstalled = false;
    let uninstallBy = null;
    if (uninstallButton) {
      await clickAt(cdp, uiSessionId, { x: uninstallButton.x, y: uninstallButton.y });
      uninstallBy = 'ui-click';
      const uninstallDeadline = Date.now() + 12000;
      while (Date.now() < uninstallDeadline) {
        if (!fs.existsSync(pluginDir)) {
          uninstalled = true;
          break;
        }
        await sleep(200);
      }
    }
    if (uninstallBy !== null) {
      report.facts.uninstall = { by: uninstallBy, removed: uninstalled };
      console.log(
        `${uninstalled ? 'INFO' : 'WARN'}  uninstall   via=${uninstallBy}, directory removed=${uninstalled}`,
      );
    }

    // ---- Network -----------------------------------------------------------
    const proxyErrors = report.network.proxyResponses.filter(
      (entry) => entry.proxyError !== null,
    );
    const upstreamErrors = report.network.proxyResponses.filter(
      (entry) => entry.upstreamError === 'upstream',
    );
    const proxyLoadingFailures = report.network.failures.filter((entry) =>
      (entry.url ?? '').includes('/api/proxy'),
    );
    const networkOk =
      proxyErrors.length === 0 &&
      proxyLoadingFailures.length === 0 &&
      report.network.fs.failures === 0;
    check(
      'network',
      networkOk,
      `${report.network.proxyResponses.length} proxy responses, ` +
        `${proxyErrors.length} proxy-generated errors, ` +
        `${upstreamErrors.length} upstream 4xx/5xx, ` +
        `${proxyLoadingFailures.length} proxy loading failures, ` +
        `${report.network.fs.non200} non-200 /api/fs responses`,
    );
    report.facts.proxy = {
      requests: report.network.proxyResponses.length,
      proxyErrors,
      upstreamErrors,
      loadingFailures: proxyLoadingFailures,
      serverPluginCalls: report.network.serverPluginCalls,
    };

    report.facts.finishedAt = new Date().toISOString();
    report.facts.durationMs = Date.now() - bootStarted;
  } finally {
    cdp.close();
    chrome.child.kill();
    server.child.kill();
    await sleep(300);
  }

  const required = ['catalog', 'search', 'install', 'enable', 'disable', 'network'];
  const passed = required.every((name) => report.criteria[name] === true);
  report.passed = passed;

  if (args.log) {
    fs.writeFileSync(args.log, server.logs.join(''));
    console.log(`[trace] server log written to ${args.log}`);
  }

  // The request list is the primary artefact: print every proxy call with its
  // decoded upstream target, then the plugin-related /api/fs writes.
  console.log('\n--- proxy requests ---');
  if (report.network.proxyResponses.length === 0) {
    console.log('(none)');
  } else {
    for (const entry of report.network.proxyResponses) {
      console.log(
        `[proxy] ${String(entry.status ?? '---').padStart(3)} ${entry.method} ` +
          `${shortUrl(entry.target ?? entry.url)}` +
          (entry.proxyError ? `  proxy-error=${entry.proxyError}` : '') +
          (entry.upstreamError ? `  upstream-${entry.upstreamError}` : ''),
      );
    }
  }

  const pluginResponses = new Map(
    report.network.pluginFs
      .filter((entry) => entry.kind === 'response')
      .map((entry) => [entry.id, entry.status]),
  );
  console.log('\n--- install-related /api/fs requests ---');
  const pluginFsRequests = report.network.pluginFs.filter(
    (entry) => entry.kind === 'request' || entry.kind === 'redirect',
  );
  const installFsRequests = pluginFsRequests.filter((entry) => {
    const target = entry.fsPath ?? '';
    return (
      target === '.obsidian/plugins' ||
      target === '.obsidian/community-plugins.json' ||
      target.startsWith(`.obsidian/plugins/${preset.id}`)
    );
  });
  if (installFsRequests.length === 0) {
    console.log('(none)');
  } else {
    for (const entry of installFsRequests) {
      console.log(
        `[fs]    ${String(pluginResponses.get(entry.id) ?? '---').padStart(3)} ` +
          `${(entry.fsOp ?? '?').padEnd(7)} ${entry.fsPath ?? ''}`,
      );
    }
  }
  const startupFs = pluginFsRequests.length - installFsRequests.length;
  if (startupFs > 0) {
    console.log(
      `[fs]    (${startupFs} other .obsidian startup requests are in the JSON report)`,
    );
  }

  console.log('\n--- other HTTP requests ---');
  const otherRequests = report.network.other.filter(
    (entry) => entry.kind === 'request' || entry.kind === 'redirect',
  );
  if (otherRequests.length === 0) {
    console.log('(none)');
  } else {
    for (const entry of otherRequests) {
      console.log(`[http]  ${entry.method.padEnd(4)} ${shortUrl(entry.url)}`);
    }
  }

  console.log('\n--- failures ---');
  if (report.network.failures.length === 0) {
    console.log('(none)');
  } else {
    for (const failure of report.network.failures) {
      console.log(
        `[fail]  ${shortUrl(failure.url ?? '(unknown)')}  ${failure.errorText}` +
          (failure.corsErrorStatus
            ? `  cors=${JSON.stringify(failure.corsErrorStatus)}`
            : ''),
      );
    }
  }

  console.log('\n--- console (last 10 errors/warnings) ---');
  const consoleTail = [
    ...report.console.errors.map((text) => `[error] ${text}`),
    ...report.console.warnings.map((text) => `[warn]  ${text}`),
    ...report.console.exceptions.map((text) => `[exception] ${text}`),
  ].slice(-10);
  if (consoleTail.length === 0) {
    console.log('(none)');
  } else {
    for (const line of consoleTail) console.log(line);
  }

  console.log('\n--- summary ---');
  console.log(
    JSON.stringify(
      {
        passed,
        criteria: report.criteria,
        facts: report.facts,
        fs: report.network.fs,
        uninstall: report.facts.uninstall ?? null,
      },
      null,
      2,
    ),
  );

  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
    console.log(`[trace] JSON report written to ${args.json}`);
  }

  process.exitCode = passed ? 0 : 1;
}

main().catch((err) => {
  console.error('plugin-install-check failed:', err.message);
  if (activeReport) {
    console.error('\n--- partial report (harness stopped early) ---');
    console.error(
      JSON.stringify(
        {
          criteria: activeReport.criteria,
          facts: activeReport.facts,
          proxy: activeReport.network.proxyResponses,
          failures: activeReport.network.failures,
          fs: activeReport.network.fs,
          console: activeReport.console,
        },
        null,
        2,
      ),
    );
  }
  process.exitCode = 2;
});
