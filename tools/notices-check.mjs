#!/usr/bin/env node
/**
 * Notices acceptance harness: zero dependencies.
 *
 * Drives the locally installed Chrome over CDP (via tools/lib/cdp.mjs) and
 * verifies the user-visible failure surface:
 *
 *   1. __MYOBS_NOTICES is installed and list() is callable.
 *   2. info / warn / error each render, with distinct level styling.
 *   3. A repeated dedupeKey collapses into one card and counts the repeats.
 *   4. error never auto-dismisses; info disappears after ~8 s.
 *   5. dismiss(id) removes exactly that card.
 *   6. A real conditional-write conflict produces exactly one source:"fs" warn
 *      naming the preserved copy, whose action opens that copy -- both when
 *      fs-shim pushes the card itself and when only __MYOBS_LAST_CONFLICT
 *      arrives (GAPS.md §8).
 *   7. A plugin that throws during onload produces a source:"plugin" error
 *      (boot-time state comparison, not a console patch) with a disable
 *      action, and a hot reload failure collapses into the same card.
 *   8. enabled = false suppresses DOM output but still records the event.
 *   9. With a notice on screen, opening a note, typing real input and saving
 *      still reaches the disk.
 *  10. No unhandled exceptions.
 *
 * The vault must be a *copy* of the real vault: this script installs a broken
 * fixture plugin and writes a conflict probe into it. The live vault is
 * refused explicitly.
 *
 * Usage:
 *   node tools/notices-check.mjs --vault <dir> [--port 3933] [--url ...]
 *                                [--timeout 120] [--json <out.json>] [--log <file>]
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  Cdp,
  REPO_ROOT,
  clickAt,
  evalInPage,
  launchChrome,
  readTermsFromVendor,
  sleep,
  startServer,
  waitForPage,
} from './lib/cdp.mjs';

const LIVE_VAULT = '/Users/kywk/kywk/obsidian';
const PROBE_ID = 'myobs-notices-broken';
const CONFLICT_NAME = 'notices-conflict-probe.md';

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = {
    url: null,
    vault: null,
    timeout: 120,
    json: null,
    port: 3933,
    log: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--vault') out.vault = argv[++i];
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--log') out.log = argv[++i];
  }
  return out;
}

/**
 * Refuse the live vault before anything writes. The copy lives elsewhere (for
 * example under the session temp dir); a mistyped --vault must not install a
 * test plugin into 5,000 real notes.
 *
 * @param {string} vault
 */
function assertNotLiveVault(vault) {
  const resolved = path.resolve(vault);
  const real = fs.realpathSync(resolved);
  for (const candidate of [resolved, real]) {
    if (candidate === LIVE_VAULT) {
      throw new Error(
        `refusing to run against the live vault (${LIVE_VAULT}); pass a copy of it instead`,
      );
    }
  }
}

/**
 * Install a plugin whose main.js throws during onload, and make sure the vault
 * lists it as enabled so the boot path (not just a hot reload) is exercised.
 *
 * @param {string} vault
 * @returns {string} absolute plugin directory
 */
function installBrokenPlugin(vault) {
  const dir = path.join(vault, '.obsidian', 'plugins', PROBE_ID);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    `${JSON.stringify(
      {
        id: PROBE_ID,
        name: 'Notices Probe (intentionally broken)',
        version: '1.0.0',
        minAppVersion: '1.0.0',
        description: 'Throws in onload so the notices harness has a real failure.',
        author: 'my-obsidian tests',
        isDesktopOnly: false,
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'main.js'),
    `/*
 * Intentionally broken plugin for tools/notices-check.mjs.
 * Obsidian catches this in PluginManager.enablePlugin() and returns false.
 */
throw new Error('myobs notices probe: intentional onload failure');
`,
  );

  const listPath = path.join(vault, '.obsidian', 'community-plugins.json');
  let list = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(listPath, 'utf8'));
    if (Array.isArray(parsed)) list = parsed;
  } catch {
    // Missing or malformed: start from an empty list.
  }
  if (!list.includes(PROBE_ID)) {
    // First, not last: the failure should be visible without waiting for the
    // other 15 plugins to finish loading.
    list.unshift(PROBE_ID);
    fs.mkdirSync(path.dirname(listPath), { recursive: true });
    fs.writeFileSync(listPath, `${JSON.stringify(list, null, 2)}\n`);
  }
  return dir;
}

/**
 * Every file in the vault whose basename is `name`, outside .git.
 *
 * Used to prove that clicking a notice action opened the conflict copy instead
 * of creating a note: workspace.openLinkText() creates a 0-byte file in the
 * active folder when the link does not resolve, so "one copy, at the path the
 * server reported" is the assertion that catches it.
 *
 * @param {string} root
 * @param {string} name
 * @returns {string[]}
 */
function findByBasename(root, name) {
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name === name) hits.push(absolute);
    }
  };
  walk(root);
  return hits;
}

// ------------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.vault) {
    throw new Error('--vault is required (never point this at the live vault)');
  }
  if (!fs.existsSync(args.vault)) {
    throw new Error(`vault does not exist: ${args.vault}`);
  }
  assertNotLiveVault(args.vault);

  const terms = readTermsFromVendor();
  const probeDir = installBrokenPlugin(args.vault);
  const probeMain = path.join(probeDir, 'main.js');
  const server = await startServer(args.vault, args.port, terms);
  const url = args.url ?? `http://127.0.0.1:${args.port}/`;

  const report = {
    url,
    vault: args.vault,
    criteria: {},
    facts: {},
    console: { errors: [], exceptions: [] },
  };

  const chrome = await launchChrome(args.port + 1000);
  const cdp = new Cdp(chrome.wsUrl);
  let sessionId = null;

  try {
    await cdp.connect();
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId } = await cdp.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    }));

    cdp.on((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args ?? [])
          .map((a) => a.value ?? a.description ?? a.type)
          .join(' ');
        if (msg.params.type === 'error') report.console.errors.push(text);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        const ex = d.exception ?? {};
        const where = d.url ? ` @ ${d.url}:${d.lineNumber ?? 0}` : '';
        report.console.exceptions.push(
          (ex.description || d.text || ex.className || 'unknown exception') + where,
        );
      }
    });

    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);

    const evaluate = (expression) => evalInPage(cdp, sessionId, expression);
    const evaluateJson = async (expression) => {
      const value = await evaluate(expression);
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    };

    const waitFor = async (expression, timeoutMs, label) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await evaluate(expression).catch(() => undefined);
        if (value) return value;
        await sleep(200);
      }
      report.facts[`timeout:${label}`] = true;
      return undefined;
    };

    const waitForApp = async () => {
      const deadline = Date.now() + args.timeout * 1000;
      while (Date.now() < deadline) {
        const ready = await evaluate(
          'typeof window.app !== "undefined" && !!window.app',
        ).catch(() => false);
        if (ready) return true;
        const fatal = await evaluate(
          '(function(){var e=document.getElementById("myobs-fatal");return !!(e && !e.hidden && e.style.display !== "none");})()',
        ).catch(() => false);
        if (fatal) {
          const detail = await evaluate(
            '(document.getElementById("myobs-fatal-detail")||{}).textContent || ""',
          ).catch(() => '');
          throw new Error(`runtime showed the fatal screen:\n${detail}`);
        }
        await sleep(300);
      }
      throw new Error('window.app never appeared');
    };

    const listNotices = async () => {
      const parsed = await evaluateJson(
        'JSON.stringify(window.__MYOBS_NOTICES ? window.__MYOBS_NOTICES.list() : [])',
      );
      return Array.isArray(parsed) ? parsed : [];
    };

    const waitForNotice = async (predicateSource, timeoutMs, label) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const items = await listNotices().catch(() => []);
        const hit = items.find((n) => {
          try {
            // eslint-disable-next-line no-new-func
            return new Function('n', `return (${predicateSource});`)(n) === true;
          } catch {
            return false;
          }
        });
        if (hit) return hit;
        await sleep(200);
      }
      report.facts[`timeout:${label}`] = true;
      return null;
    };

    const domCount = () =>
      evaluate('document.querySelectorAll("#myobs-notices .myobs-notice").length');

    const clearNotices = async () => {
      await evaluate('window.__MYOBS_NOTICES.clear(); "ok"');
      await sleep(100);
      return listNotices();
    };

    const push = (level, source, message, extra = '') =>
      evaluate(`(function () {
        return window.__MYOBS_NOTICES.push(Object.assign({
          level: ${JSON.stringify(level)},
          source: ${JSON.stringify(source)},
          message: ${JSON.stringify(message)}
        }, ${extra || '{}'}));
      })()`);

    // ---------------------------------------------------------------- boot
    await cdp.send('Page.navigate', { url }, sessionId);
    await waitForApp();

    /*
     * Community plugins only load when localStorage carries
     * "enable-plugin-<appId>": "true" (restricted mode). A fresh Chrome
     * profile has no such key, so persist it and reload: the second boot is
     * the real production path.
     */
    const appId = await evaluate('window.app.appId');
    report.facts.appId = appId;
    const tokenBefore = await evaluate('String(window.__MYOBS.sessionToken || "")');
    await evaluate(
      `localStorage.setItem(${JSON.stringify(`enable-plugin-${appId}`)}, "true"); "ok"`,
    );

    await cdp.send('Page.navigate', { url }, sessionId);
    const reloaded = await waitFor(
      `!!window.app && String(window.__MYOBS.sessionToken || "") !== ${JSON.stringify(tokenBefore)}`,
      args.timeout * 1000,
      'documentReload',
    );
    report.facts.documentReloaded = reloaded === true;

    await waitFor('app.vault.getFiles().length > 0', args.timeout * 1000, 'vaultScanned');
    await sleep(500);

    // 1. installed ---------------------------------------------------------
    // The container is created lazily on the first push, so create it before
    // inspecting its computed style.
    const installedProbeId = await push(
      'info',
      'check',
      'installed probe',
      '{ dedupeKey: "check:installed" }',
    );
    await sleep(100);
    const installed = await evaluateJson(`(function () {
      var api = window.__MYOBS_NOTICES;
      if (!api) return { present: false };
      var items = typeof api.list === "function" ? api.list() : null;
      var root = document.getElementById("myobs-notices");
      var style = root ? getComputedStyle(root) : null;
      return {
        present: true,
        installed: api.installed === true,
        listIsArray: Array.isArray(items),
        eventsIsArray: Array.isArray(api.events),
        enabled: api.enabled !== false,
        zIndex: style ? style.zIndex : null,
        pointerEvents: style ? style.pointerEvents : null,
        position: style ? style.position : null
      };
    })()`);
    report.facts.installed = installed;
    report.criteria.noticesInstalled =
      installed.present === true &&
      installed.installed === true &&
      installed.listIsArray === true &&
      installed.eventsIsArray === true &&
      installed.enabled === true &&
      Number(installed.zIndex) > 50 &&
      Number(installed.zIndex) < 2147483647 &&
      installed.pointerEvents === 'none' &&
      installed.position === 'fixed';
    // Dismiss this probe only. The boot-time plugin scan (step 7) is one-shot
    // and can land at any moment from here on, so the blanket clear() the
    // other steps use would race it and delete the card it is waiting for.
    await evaluate(
      `window.__MYOBS_NOTICES.dismiss(${JSON.stringify(installedProbeId)}); "ok"`,
    );
    await sleep(100);

    // 7. boot-time plugin failure (checked before the generic notice tests,
    //    because the boot scan is one-shot and the card is real vault state).
    const bootNotice = await waitForNotice(
      `n.source === "plugin" && n.level === "error" && n.dedupeKey === "plugin:${PROBE_ID}"`,
      45000,
      'bootPluginNotice',
    );
    const pluginWatchEvents = await evaluateJson(
      'JSON.stringify((window.__MYOBS_PLUGIN_WATCH && window.__MYOBS_PLUGIN_WATCH.events) || [])',
    );
    const bootScan = Array.isArray(pluginWatchEvents)
      ? [...pluginWatchEvents].reverse().find((e) => e.action === 'boot-scan')
      : null;
    report.facts.bootPluginFailure = {
      notice: bootNotice,
      bootScan,
      enabledButNotLoaded: await evaluateJson(`(function () {
        var p = app.plugins || {};
        var enabled = p.enabledPlugins ? Array.from(p.enabledPlugins) : [];
        var loaded = Object.keys(p.plugins || {});
        return enabled.filter(function (id) { return loaded.indexOf(id) === -1; });
      })()`),
    };

    // A real hot-reload failure must land on the same card, not a second one.
    // NOTE: waitFor() stops on the first truthy value, so this expression has
    // to be false (not "0" -- JSON.stringify(0) is a truthy string) while the
    // reload is still in flight.
    const mainLength = fs.statSync(probeMain).size;
    fs.appendFileSync(probeMain, `\n// external touch ${Date.now()}\n`);
    const reloadFailure = await waitFor(
      `((window.__MYOBS_PLUGIN_WATCH || {}).events || []).some(function (e) {
        return e.id === ${JSON.stringify(PROBE_ID)} && e.action === "reload" && e.ok === false;
      }) === true`,
      20000,
      'reloadFailureEvent',
    );
    const afterReloadNotices = await listNotices().catch(() => []);
    const probeCards = afterReloadNotices.filter(
      (n) => n.dedupeKey === `plugin:${PROBE_ID}`,
    );
    report.facts.bootPluginFailure.hotReload = {
      mainSizeBefore: mainLength,
      sawFailedReloadEvent: Number(reloadFailure) > 0,
      cards: probeCards.length,
      count: probeCards[0] ? probeCards[0].count : null,
    };
    report.criteria.bootPluginFailure =
      !!bootNotice &&
      String(bootNotice.message).includes(PROBE_ID) &&
      Array.isArray(bootNotice.actions) &&
      bootNotice.actions.includes('停用此外掛') &&
      reloadFailure === true &&
      probeCards.length === 1 &&
      (probeCards[0]?.count ?? 0) >= 2;

    // 2. three levels ------------------------------------------------------
    await clearNotices();
    // events[] is a session-wide audit trail and clear() only removes cards,
    // so the pushes of this step have to be read as a slice -- otherwise step
    // 1's probe (source "check" too) would be counted as a fourth level.
    const eventsBeforeLevels = Number(
      await evaluate('(window.__MYOBS_NOTICES.events || []).length'),
    );
    await push('info', 'check', 'notices-check info');
    await push('warn', 'check', 'notices-check warn');
    await push('error', 'check', 'notices-check error');
    await sleep(300);

    const threeLevels = await evaluateJson(`(function () {
      var cards = Array.from(document.querySelectorAll("#myobs-notices .myobs-notice"));
      return cards.map(function (card) {
        var icon = card.querySelector(".myobs-notice-icon");
        var style = getComputedStyle(card);
        return {
          level: card.getAttribute("data-level"),
          count: card.getAttribute("data-count"),
          border: style.borderLeftColor,
          background: style.backgroundColor,
          icon: icon ? getComputedStyle(icon).color : null,
          message: (card.querySelector(".myobs-notice-message") || {}).textContent || ""
        };
      });
    })()`);
    const noticeEvents = await evaluateJson(
      'JSON.stringify(window.__MYOBS_NOTICES.events.slice())',
    );
    const pushEvents = (Array.isArray(noticeEvents) ? noticeEvents : [])
      .slice(eventsBeforeLevels)
      .filter(
        (e) => e.action === 'push' && e.source === 'check' && e.suppressed !== true,
      );
    report.facts.threeLevels = {
      cards: threeLevels,
      domCount: await domCount(),
      pushEvents: pushEvents.length,
    };
    report.criteria.threeLevels =
      Array.isArray(threeLevels) &&
      threeLevels.length === 3 &&
      new Set(threeLevels.map((c) => c.level)).size === 3 &&
      new Set(threeLevels.map((c) => c.border)).size === 3 &&
      pushEvents.length === 3;

    // 3. dedupe ------------------------------------------------------------
    await clearNotices();
    await push('warn', 'check', 'same conflict #1', '{ dedupeKey: "check:dedupe" }');
    await push('warn', 'check', 'same conflict #2', '{ dedupeKey: "check:dedupe" }');
    await push('warn', 'check', 'same conflict #3', '{ dedupeKey: "check:dedupe" }');
    await sleep(200);
    const deduped = await evaluateJson(`(function () {
      var items = window.__MYOBS_NOTICES.list().filter(function (n) {
        return n.dedupeKey === "check:dedupe";
      });
      var card = document.querySelector('#myobs-notices .myobs-notice[data-count="3"]');
      var badge = card ? card.querySelector(".myobs-notice-count") : null;
      return {
        items: items,
        domForLevel: document.querySelectorAll('#myobs-notices .myobs-notice[data-level="warn"]').length,
        cardFound: !!card,
        cardCount: card ? card.getAttribute("data-count") : null,
        badge: badge ? badge.textContent : null
      };
    })()`);
    const dedupeEvents = (await evaluateJson(
      'JSON.stringify(window.__MYOBS_NOTICES.events.slice())',
    )).filter((e) => e.action === 'dedupe' && e.dedupeKey === 'check:dedupe');
    report.facts.dedupe = { ...deduped, dedupeEvents: dedupeEvents.length };
    report.criteria.dedupeCount =
      deduped.items.length === 1 &&
      deduped.items[0].count === 3 &&
      deduped.domForLevel === 1 &&
      deduped.cardFound === true &&
      deduped.cardCount === '3' &&
      String(deduped.badge).includes('3') &&
      dedupeEvents.length === 2;

    // 4. auto-dismiss ------------------------------------------------------
    await clearNotices();
    const stickyId = await push('error', 'check', 'sticky error', '{ dedupeKey: "check:sticky" }');
    const infoId = await push('info', 'check', 'temporary info', '{ dedupeKey: "check:temp-info" }');
    await sleep(3000);
    const atThreeSeconds = await listNotices();
    await sleep(6600);
    const atNineSeconds = await listNotices();
    const stillThere = (items, id) => items.some((n) => n.id === id);
    report.facts.autoDismiss = {
      atThreeSeconds: atThreeSeconds.map((n) => ({ id: n.id, level: n.level })),
      atNineSeconds: atNineSeconds.map((n) => ({ id: n.id, level: n.level })),
      domCount: await domCount(),
    };
    report.criteria.autoDismiss =
      stillThere(atThreeSeconds, stickyId) === true &&
      stillThere(atThreeSeconds, infoId) === true &&
      stillThere(atNineSeconds, stickyId) === true &&
      stillThere(atNineSeconds, infoId) === false;
    await clearNotices();

    // 5. dismiss(id) -------------------------------------------------------
    const dismissId = await push('warn', 'check', 'dismiss me', '{ dedupeKey: "check:dismiss" }');
    await evaluate(`window.__MYOBS_NOTICES.dismiss(${JSON.stringify(dismissId)}); "ok"`);
    await sleep(150);
    const afterDismiss = await listNotices();
    const dismissEvents = (await evaluateJson(
      'JSON.stringify(window.__MYOBS_NOTICES.events.slice())',
    )).filter((e) => e.action === 'dismiss' && e.id === dismissId);
    report.facts.dismiss = {
      remaining: afterDismiss.map((n) => n.id),
      dismissEvents: dismissEvents.length,
      domCount: await domCount(),
    };
    report.criteria.dismiss =
      afterDismiss.some((n) => n.id === dismissId) === false &&
      dismissEvents.length === 1 &&
      (await domCount()) === 0;

    // 6. real conditional-write conflict ----------------------------------
    // Go through fs-shim (not raw /api/fs) so the complete production path is
    // exercised: writeFile -> /api/fs with ifMtimeMs -> conflict copy ->
    // finishWrite -> __MYOBS_LAST_CONFLICT -> notice bridge.
    //
    // The explicit ifMtimeMs is what makes this reachable at all: Obsidian's
    // FileSystemAdapter never sends one, so no ordinary editor save can ever
    // produce a conflict copy (GAPS.md §8). A stale ifMtimeMs is the shape a
    // second client's in-flight write has when it lands here.
    await clearNotices();
    const conflictResult = await evaluateJson(`(async function () {
      var fs = window.__MYOBS_MODULES.fs;
      var abs = window.__MYOBS.vaultPath + "/" + ${JSON.stringify(CONFLICT_NAME)};
      await fs.promises.writeFile(abs, "original content\\n");
      await fs.promises.writeFile(abs, "winner content\\n", { ifMtimeMs: 1 });
      await new Promise(function (resolve) { setTimeout(resolve, 100); });
      return {
        lastConflict: window.__MYOBS_LAST_CONFLICT || null,
        winner: await fs.promises.readFile(abs, "utf8")
      };
    })()`);
    const savedAs =
      conflictResult.lastConflict && conflictResult.lastConflict.conflictSavedAs
        ? String(conflictResult.lastConflict.conflictSavedAs)
        : null;
    const conflictKey = `fs:conflict:${CONFLICT_NAME}`;
    const conflictNotice = await waitForNotice(
      'n.source === "fs" && n.level === "warn" && String(n.message).includes("conflict-")',
      10000,
      'conflictNotice',
    );
    // Two producers share this dedupeKey: fs-shim pushes the card from
    // finishWrite, and notices.js' __MYOBS_LAST_CONFLICT bridge covers the case
    // where it does not. One conflict must stay one card with one count, so the
    // count is asserted, not just the presence.
    const conflictCards = (await listNotices()).filter((n) => n.dedupeKey === conflictKey);
    const conflictDom = await evaluateJson(`(function () {
      return Array.from(
        document.querySelectorAll("#myobs-notices .myobs-notice")
      ).map(function (card) {
        return {
          id: card.getAttribute("data-id"),
          level: card.getAttribute("data-level"),
          count: card.getAttribute("data-count"),
          message: (card.querySelector(".myobs-notice-message") || {}).textContent || "",
          actions: Array.from(card.querySelectorAll(".myobs-notice-action")).map(
            function (button) { return button.textContent; }
          )
        };
      });
    })()`);
    const bridgeDelegated = (await evaluateJson(
      'JSON.stringify(window.__MYOBS_NOTICES.events.slice())',
    )).filter((e) => e.action === 'conflict-delegated' && e.dedupeKey === conflictKey).length;

    // The card has to name the copy *and* reach it. Neither a label nor a
    // non-empty actions array proves the second half, so click the action and
    // check which file Obsidian actually opened. The copy is created by the
    // server, so it only enters app.vault through the watch channel (chokidar
    // 300 ms + 150 ms batch + reconcile); the action resolves it through that
    // index, so clicking before it arrives would exercise the retry path
    // instead of the normal one. (An action built on openLinkText() -- the
    // obvious call, and the one that shipped first -- creates an empty note in
    // that window; `copiesOnDisk` below is the guard against it coming back.)
    let copyIndexed = false;
    let openedCopy = false;
    let openedState = null;
    if (conflictNotice && savedAs) {
      copyIndexed =
        (await waitFor(
          `!!app.vault.getAbstractFileByPath(${JSON.stringify(savedAs)})`,
          8000,
          'conflictCopyIndexed',
        )) === true;
      const buttonPoint = await evaluateJson(`(function () {
        var card = document.querySelector('#myobs-notices .myobs-notice[data-id=${JSON.stringify(
          conflictNotice.id,
        )}]');
        var button = card ? card.querySelector(".myobs-notice-action") : null;
        if (!button) return null;
        var rect = button.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      if (buttonPoint) {
        await clickAt(cdp, sessionId, buttonPoint, { button: 'left' });
        openedCopy =
          (await waitFor(
            `(function () {
              var file = app.workspace.getActiveFile();
              return !!file && file.path === ${JSON.stringify(savedAs)};
            })()`,
            5000,
            'conflictActionOpensCopy',
          )) === true;
      }
      openedState = await evaluateJson(`(function () {
        var active = app.workspace.getActiveFile();
        return {
          activeFile: active ? active.path : null,
          markdownLeaves: app.workspace.getLeavesOfType("markdown").map(function (leaf) {
            return leaf.view && leaf.view.file ? leaf.view.file.path : null;
          })
        };
      })()`);
    }

    // The click must not have created a note: either the copy opened, or
    // nothing happened. Exactly one file carries the copy's name.
    const copiesOnDisk = savedAs ? findByBasename(args.vault, path.basename(savedAs)) : [];

    let conflictFile = null;
    let conflictBody = null;
    if (savedAs) {
      const absolute = path.join(args.vault, ...savedAs.split('/'));
      if (fs.existsSync(absolute)) {
        conflictFile = absolute;
        conflictBody = fs.readFileSync(absolute, 'utf8');
      }
    }

    // 6b. the bridge on its own -------------------------------------------
    // fs-shim's push is the primary producer and the bridge stands down while
    // it is in flight (bridgeDelegated above). This pins the other half of the
    // contract in GAPS.md §8: a signal that arrives with nothing behind it
    // still has to surface, and that card is the one with the useful detail --
    // it names the file as well as the preserved copy.
    //
    // The field is set directly because that is exactly what the signal is;
    // the copy name is synthetic (nothing verifies the file here, and the
    // action is not clicked) so the check cannot pass by accident through
    // fs-shim's own push.
    const bridgeCopyName = 'notices-conflict-probe.conflict-bridge.md';
    await clearNotices();
    await evaluate(`(function () {
      window.__MYOBS_LAST_CONFLICT = {
        path: ${JSON.stringify(CONFLICT_NAME)},
        conflictSavedAs: ${JSON.stringify(bridgeCopyName)},
        at: Date.now()
      };
      return true;
    })()`);
    const bridgeNotice = await waitForNotice(
      `n.dedupeKey === ${JSON.stringify(conflictKey)}`,
      5000,
      'conflictBridgeNotice',
    );
    report.facts.conflictBridge = {
      notice: bridgeNotice,
      domCount: await domCount(),
    };
    await clearNotices();

    report.facts.conflict = {
      api: conflictResult,
      notice: conflictNotice,
      cardsForKey: conflictCards,
      dom: conflictDom,
      bridgeDelegated,
      copyIndexed,
      openedCopy,
      openedState,
      copiesOnDisk,
      conflictFile,
      conflictBody,
    };
    report.criteria.conflictNotice =
      // end to end, through fs-shim
      !!savedAs &&
      conflictResult.winner === 'winner content\n' &&
      !!conflictNotice &&
      String(conflictNotice.message).includes(path.basename(savedAs)) &&
      String(conflictNotice.message).includes(CONFLICT_NAME) &&
      conflictCards.length === 1 &&
      conflictCards[0].count === 1 &&
      conflictDom.length === 1 &&
      bridgeDelegated === 1 &&
      copyIndexed === true &&
      openedCopy === true &&
      copiesOnDisk.length === 1 &&
      copiesOnDisk[0] === conflictFile &&
      conflictBody === 'original content\n' &&
      // fallback, with nothing but __MYOBS_LAST_CONFLICT
      !!bridgeNotice &&
      bridgeNotice.level === 'warn' &&
      bridgeNotice.source === 'fs' &&
      bridgeNotice.count === 1 &&
      String(bridgeNotice.message).includes(bridgeCopyName) &&
      String(bridgeNotice.detail).includes(CONFLICT_NAME) &&
      Array.isArray(bridgeNotice.actions) &&
      bridgeNotice.actions.includes('顯示檔案');

    // Clean up the probe and its conflict copy (the vault is a copy, but a
    // later harness should see the same starting state).
    for (const name of fs.readdirSync(args.vault)) {
      if (name.startsWith('notices-conflict-probe.conflict-')) {
        fs.rmSync(path.join(args.vault, name), { force: true });
      }
    }
    fs.rmSync(path.join(args.vault, CONFLICT_NAME), { force: true });
    await sleep(300);

    // 8. enabled = false ---------------------------------------------------
    await clearNotices();
    const suppressed = await evaluateJson(`(function () {
      var api = window.__MYOBS_NOTICES;
      api.enabled = false;
      var id = api.push({
        level: "error",
        source: "check",
        message: "suppressed notice",
        dedupeKey: "check:suppressed"
      });
      var result = {
        returned: id,
        list: api.list().length,
        dom: document.querySelectorAll("#myobs-notices .myobs-notice").length,
        event: api.events.filter(function (e) {
          return e.action === "push" && e.suppressed === true &&
            e.message === "suppressed notice";
        }).length
      };
      api.enabled = true;
      return result;
    })()`);
    report.facts.disabledIsNoOp = suppressed;
    report.criteria.disabledIsNoOp =
      suppressed.returned === null &&
      suppressed.list === 0 &&
      suppressed.dom === 0 &&
      suppressed.event === 1;

    // 9. the editor still works under a visible notice --------------------
    await clearNotices();
    await push('warn', 'check', 'overlay present while typing', '{ dedupeKey: "check:typing" }');

    const notePath = await evaluate(`(function () {
      var files = app.vault.getMarkdownFiles();
      var target = files.find(function (f) { return f.path === "AGENTS.md"; }) || files[0];
      return target ? target.path : null;
    })()`);
    const noteFile = notePath
      ? path.join(args.vault, ...notePath.split('/'))
      : null;
    const noteOriginal = noteFile ? fs.readFileSync(noteFile, 'utf8') : null;

    await evaluate(`(async function () {
      await app.workspace.openLinkText(${JSON.stringify(notePath)}, "", false);
      await new Promise(function (resolve) { setTimeout(resolve, 500); });
      var view = app.workspace.activeLeaf && app.workspace.activeLeaf.view;
      if (view && view.getMode && view.getMode() === "preview") {
        await app.commands.executeCommandById("markdown:toggle-preview");
        await new Promise(function (resolve) { setTimeout(resolve, 500); });
      }
      return true;
    })()`);

    const editorReady = await waitFor(
      `(function () {
        var view = app.workspace.activeLeaf && app.workspace.activeLeaf.view;
        return !!(view && view.editor && document.querySelector(".cm-content"));
      })()`,
      15000,
      'editorReady',
    );
    const typingMarker = `<!-- myobs-notices-typing ${Date.now()} -->`;
    let typedInEditor = false;
    let typedToDisk = false;
    if (editorReady) {
      const rect = await evaluateJson(`(function () {
        var el = document.querySelector(".cm-content");
        if (!el) return null;
        var r = el.getBoundingClientRect();
        return { x: r.left + 40, y: r.top + 24 };
      })()`);
      if (rect) {
        await clickAt(cdp, sessionId, rect, { button: 'left' });
        await sleep(250);
        await cdp.send('Input.insertText', { text: `\n\n${typingMarker}\n` }, sessionId);
        await sleep(600);
        typedInEditor = await evaluate(
          `String((app.workspace.activeLeaf.view.editor.getValue() || "")).includes(${JSON.stringify(
            typingMarker,
          )})`,
        ).catch(() => false);

        await evaluate('app.commands.executeCommandById("editor:save-file"); "ok"');
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          if (fs.readFileSync(noteFile, 'utf8').includes(typingMarker)) {
            typedToDisk = true;
            break;
          }
          await sleep(250);
        }
      }
    }

    let restored = false;
    if (noteFile && noteOriginal !== null) {
      await evaluate(`(async function () {
        var file = app.vault.getAbstractFileByPath(${JSON.stringify(notePath)});
        await app.vault.modify(file, ${JSON.stringify(noteOriginal)});
        return "restored";
      })()`).catch(() => null);
      await sleep(1200);
      restored = fs.readFileSync(noteFile, 'utf8') === noteOriginal;
    }
    report.facts.editorUnaffected = {
      notePath,
      editorReady: editorReady === true,
      typedInEditor,
      typedToDisk,
      restored,
      noticeStillVisible: (await listNotices()).length,
    };
    report.criteria.editorUnaffected =
      editorReady === true && typedInEditor === true && typedToDisk === true && restored === true;

    // 10. no unhandled exceptions -----------------------------------------
    await clearNotices();
    report.criteria.noUnhandledExceptions = report.console.exceptions.length === 0;

    // Diagnostics ----------------------------------------------------------
    report.facts.watch = await evaluateJson(
      'JSON.stringify((window.__MYOBS_WATCH && window.__MYOBS_WATCH.state) || null)',
    );
    report.facts.noticeEventsAtEnd = await evaluateJson(
      'JSON.stringify((window.__MYOBS_NOTICES.events || []).slice(-20))',
    );
    report.facts.enabledPlugins = await evaluateJson(`(function () {
      var p = app.plugins || {};
      return {
        enabled: p.enabledPlugins ? Array.from(p.enabledPlugins) : [],
        loaded: Object.keys(p.plugins || {}),
        restricted: typeof p.isEnabled === "function" ? !p.isEnabled() : null
      };
    })()`);
    report.facts.platform = await evaluateJson(`(function () {
      return {
        isDesktopApp: window.Platform ? window.Platform.isDesktopApp : null,
        isMobile: window.Platform ? window.Platform.isMobile : null
      };
    })()`);
  } finally {
    cdp.close();
    chrome.child.kill();
    server.child.kill();
  }

  const passed = Object.values(report.criteria).every(Boolean);
  report.passed = passed;

  if (args.log) {
    fs.writeFileSync(args.log, server.logs.join(''));
    console.log(`[trace] server log written to ${args.log}`);
  }

  console.log(JSON.stringify(report, null, 2));
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(report, null, 2));

  if (report.console.exceptions.length) {
    console.log('\n--- exceptions ---');
    for (const e of report.console.exceptions.slice(0, 10)) console.log(e);
  }

  process.exitCode = passed ? 0 : 1;
}

main().catch((err) => {
  console.error('notices-check failed:', err.message);
  process.exitCode = 2;
});
