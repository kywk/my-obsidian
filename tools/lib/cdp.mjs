/**
 * Shared CDP harness helpers for the acceptance scripts in tools/.
 *
 * Zero dependencies: Node 22 ships a global WebSocket, so the local Chrome is
 * driven over the DevTools protocol directly instead of pulling in
 * puppeteer/playwright.
 *
 * The terms acknowledgement is read from vendor/obsidian/app.js at runtime,
 * passed to the server through the environment, and never written to disk or
 * printed (AGENTS.md hard rule 3).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findChrome } from '../../scripts/lib/browser.mjs';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
// Resolved lazily-failing: a machine without Chrome can still import this
// module (the unit tests do); launchChrome() reports what to install or set.
export const CHROME = findChrome();

/**
 * The operator's real vault. Harnesses write into the vault they are pointed
 * at, so this is a hard boundary (AGENTS.md rule 4). There is deliberately no
 * default: an unset MYOBS_LIVE_VAULT must fail closed instead of silently
 * disabling the guard on a machine with a different home layout.
 *
 * @returns {string} absolute, symlink-resolved live vault path
 */
export function liveVaultPath() {
  const raw = process.env.MYOBS_LIVE_VAULT;
  if (!raw || !raw.trim()) {
    throw new Error(
      'MYOBS_LIVE_VAULT is not set. Point it at your real vault (the path harnesses must refuse), ' +
        'for example: export MYOBS_LIVE_VAULT="$HOME/Obsidian/MyVault"',
    );
  }
  const expanded = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
  const absolute = path.resolve(expanded);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Refuse the live vault, and refuse a vault that contains the live vault.
 * The second check matters when the real vault is a parent directory (for
 * example ~/Sync contains ~/Sync/vault).
 *
 * @param {string} vault
 * @returns {string} absolute, symlink-resolved vault path
 */
export function assertNotLiveVault(vault) {
  const absolute = path.resolve(vault);
  let real = absolute;
  try {
    real = fs.realpathSync(absolute);
  } catch {
    // A missing path is handled by the caller's own existsSync check.
  }
  const live = liveVaultPath();
  const contains = (a, b) => a === b || a.startsWith(b + path.sep);
  if (contains(real, live) || contains(live, real)) {
    throw new Error(
      `refusing to run against the live vault or its parent: ${real} ` +
        `(MYOBS_LIVE_VAULT=${live}); pass a copy under a separate directory`,
    );
  }
  return real;
}

/**
 * Start each harness from a clean layout. .obsidian/workspace-server.json is
 * browser-side state; leaving it behind makes the next harness inherit tabs,
 * reading mode, and popout state. Only the first start for a vault resets it,
 * so resilience-check can restart the server without losing the client state
 * it is testing.
 */
const preparedVaults = new Set();
export function resetWorkspaceState(vault) {
  for (const name of ['workspace-server.json', 'workspace-mobile.json']) {
    try {
      fs.rmSync(path.join(vault, '.obsidian', name), { force: true });
    } catch {
      // A missing .obsidian directory is fine; the server will create it.
    }
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} url
 * @param {number} deadlineMs
 * @returns {Promise<true>}
 */
export async function waitForHttp(url, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(150);
  }
  throw new Error(`server did not become ready at ${url}: ${lastErr?.message}`);
}

/**
 * Pull the acknowledgement literal out of the shipped bundle. It is compared
 * against sendSync("terms") immediately before window.close(); the string sits
 * on the left of that comparison.
 *
 * @returns {string}
 */
export function readTermsFromVendor() {
  const p = path.join(REPO_ROOT, 'vendor/obsidian/app.js');
  const src = fs.readFileSync(p, 'utf8');
  const marker = '.ipcRenderer.sendSync("terms")';
  const at = src.indexOf(marker);
  if (at < 0) throw new Error('terms gate not found in vendor/obsidian/app.js');
  const open = src.lastIndexOf('"', at - 2);
  const close = src.lastIndexOf('"', open - 1);
  const value = src.slice(close + 1, open);
  if (!value || value.length < 40) {
    throw new Error('extracted terms literal looks wrong; refusing to continue');
  }
  return value;
}

/**
 * @param {string} vault absolute vault directory (never the live vault)
 * @param {number} port
 * @param {string} terms acknowledgement literal from the shipped bundle
 * @param {Record<string, string>} [extraEnv]
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, logs: string[] }>}
 */
export async function startServer(vault, port, terms, extraEnv = {}) {
  const safeVault = assertNotLiveVault(vault);
  if (!preparedVaults.has(safeVault)) {
    resetWorkspaceState(safeVault);
    preparedVaults.add(safeVault);
  }
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(REPO_ROOT, 'packages/server'),
    env: {
      ...process.env,
      ...extraEnv,
      VAULT_PATH: safeVault,
      PORT: String(port),
      HOST: '127.0.0.1',
      TERMS_ACK: terms,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  child.on('exit', (code) => logs.push(`[server exited ${code}]`));
  await waitForHttp(`http://127.0.0.1:${port}/`, 20000);
  return { child, logs };
}

/**
 * Minimal CDP client: request/response correlation plus an event fan-out.
 */
export class Cdp {
  /** @param {string} wsUrl */
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('ws error')), {
        once: true,
      });
    });
    this.ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      for (const fn of this.listeners) fn(msg);
    });
  }

  /** @param {(msg: any) => void} fn */
  on(fn) {
    this.listeners.add(fn);
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {string} [sessionId]
   * @returns {Promise<any>}
   */
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

/**
 * @param {number} port
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, userDataDir: string, wsUrl: string }>}
 */
export async function launchChrome(port) {
  if (!CHROME) {
    throw new Error(
      '找不到 Chromium 系瀏覽器（Chrome／Chromium／Edge／Brave）。' +
        '請安裝其中之一，或設 MYOBS_CHROME=<可執行檔絕對路徑>。',
    );
  }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myobs-chrome-'));
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      // Chrome 156 periodically opens chrome://settings/help in a blank
      // window. That can steal an about:blank popout target and make
      // parity-check fail with a page that has no Obsidian UI at all.
      '--disable-component-update',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-features=ChromeWhatsNewUI,MediaRouter,OptimizationHints',
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const info = await res.json();
        return { child, userDataDir, wsUrl: info.webSocketDebuggerUrl };
      }
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error('Chrome did not expose a debugging endpoint');
}

// ---------------------------------------------------------------- page helpers
//
// Additions for harnesses that need more than one page (popout windows) or real
// input events. Everything below is implemented on top of Cdp.send(), so the
// existing exports above are untouched.

/**
 * @param {Cdp} cdp
 * @param {string} targetId
 * @returns {Promise<string>} sessionId
 */
export async function attachToPage(cdp, targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return sessionId;
}

/**
 * Create a page target and attach to it.
 *
 * @param {Cdp} cdp
 * @param {string} [url]
 * @returns {Promise<{ targetId: string, sessionId: string }>}
 */
export async function newPage(cdp, url = 'about:blank') {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const sessionId = await attachToPage(cdp, targetId);
  return { targetId, sessionId };
}

/**
 * Every open page target, including popups opened with window.open().
 *
 * @param {Cdp} cdp
 * @returns {Promise<Array<{ targetId: string, url: string, title: string }>>}
 */
export async function listPageTargets(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return (targetInfos ?? [])
    .filter(
      (t) =>
        t.type === 'page' &&
        !/^(chrome|devtools|edge):\/\//.test(t.url),
    )
    .map((t) => ({ targetId: t.targetId, url: t.url, title: t.title, attached: t.attached }));
}

/**
 * @param {Cdp} cdp
 * @param {string} targetId
 */
export async function activateTarget(cdp, targetId) {
  await cdp.send('Target.activateTarget', { targetId }).catch(() => {});
}

/**
 * Evaluate an expression in a page session. Throws with the page's own error
 * message when the expression throws, so a failing assertion is never silently
 * undefined.
 *
 * @param {Cdp} cdp
 * @param {string} sessionId
 * @param {string} expression
 * @param {{ awaitPromise?: boolean, userGesture?: boolean }} [options]
 * @returns {Promise<any>}
 */
export async function evalInPage(cdp, sessionId, expression, options = {}) {
  const res = await cdp.send(
    'Runtime.evaluate',
    {
      expression,
      awaitPromise: options.awaitPromise !== false,
      returnByValue: true,
      userGesture: options.userGesture === true,
    },
    sessionId,
  );
  if (res.exceptionDetails) {
    const ex = res.exceptionDetails;
    throw new Error(
      ex.exception?.description || ex.exception?.value || ex.text || 'evaluate failed',
    );
  }
  return res.result?.value;
}

/**
 * Poll an expression in a page session until it is truthy.
 *
 * @param {Cdp} cdp
 * @param {string} sessionId
 * @param {string} expression
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export async function waitForPage(cdp, sessionId, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // A target that is still starting up has no execution context yet; that is
    // a "not yet", not a failure.
    const value = await evalInPage(cdp, sessionId, expression).catch(() => undefined);
    if (value) return true;
    await sleep(150);
  }
  return false;
}

/**
 * Dispatch a real (trusted) mouse click through the input domain. This is the
 * only way to exercise code paths that require a user gesture -- window.open()
 * for popouts, for example -- because Runtime.evaluate cannot produce one
 * without faking it.
 *
 * @param {Cdp} cdp
 * @param {string} sessionId
 * @param {{ x: number, y: number }} point viewport coordinates (CSS pixels)
 * @param {{ button?: 'left' | 'right' | 'middle', clickCount?: number }} [options]
 * @returns {Promise<void>}
 */
export async function clickAt(cdp, sessionId, point, options = {}) {
  const button = options.button ?? 'left';
  const clickCount = options.clickCount ?? 1;
  const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
  const base = { x: Math.round(point.x), y: Math.round(point.y), button, clickCount };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 }, sessionId);
}

