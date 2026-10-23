/**
 * The consent gate: config-file storage, the operator-facing page, the live
 * acceptance state, and the routes that drive them.
 *
 * DESIGN.md §8 decided this shape: the acknowledgement string is never part of
 * this repository. The operator reads it out of vendor/obsidian/app.js, the
 * consent page POSTs it here, it lands in the server's own config file, and the
 * boot object hands it to the renderer at startup.
 *
 * AGENTS.md hard rule 3 applies to every string in this module -- code, error
 * messages, the page, and the tests. The value is only ever data that came from
 * the operator at runtime.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Sanity bound for the acknowledged string.
 *
 * The renderer's own literal is ~284 characters; anything much shorter is a
 * truncated paste. The same bound is used as a sanity check by the extraction
 * helper in tools/lib/cdp.mjs, so a truncated value is refused here rather than
 * being injected and stalling the renderer on a verbatim mismatch.
 */
export const MIN_TERMS_LENGTH = 40;

/**
 * Statements the operator must affirm before the gate opens. The ids are the
 * wire contract between consent.html and POST /api/consent; the wording lives
 * in the page and in NOTICE.md. Each one maps to a real obligation:
 *
 *   unofficial        this project is not Obsidian and has no endorsement
 *   obsidian-terms    the operator has read and accepts Obsidian's own terms
 *   private-use       no serving the renderer to others without Obsidian's consent
 *   own-risk          provided as-is; the operator is responsible for their vault
 *
 * Bump CONSENT_NOTICE_VERSION whenever the wording changes materially so the
 * stored record says which text was actually shown.
 */
export const REQUIRED_ACKNOWLEDGEMENTS = Object.freeze([
  'unofficial',
  'obsidian-terms',
  'private-use',
  'own-risk',
]);
export const CONSENT_NOTICE_VERSION = '2026-10-24';

/**
 * Read the renderer's own acknowledgement literal at runtime.
 *
 * This is only used by local dev mode. The value never leaves memory and is
 * never written to the repo or the consent config (AGENTS.md rule 3). The
 * marker and the quote-walk are the same ones tools/lib/cdp.mjs uses; keeping
 * them identical means dev mode injects exactly what the harnesses inject.
 *
 * @param {string} vendorDir directory containing app.js (not the .asar)
 * @returns {string}
 */
export function readTermsFromVendor(vendorDir) {
  const appJs = path.join(vendorDir, 'app.js');
  const source = fs.readFileSync(appJs, 'utf8');
  const marker = '.ipcRenderer.sendSync("terms")';
  const at = source.indexOf(marker);
  if (at < 0) {
    throw new Error(`terms gate not found in ${appJs}; re-run "npm run vendor"`);
  }
  const open = source.lastIndexOf('"', at - 2);
  const close = source.lastIndexOf('"', open - 1);
  const value = source.slice(close + 1, open);
  if (!value || value.length < MIN_TERMS_LENGTH) {
    throw new Error(
      `terms literal in ${appJs} looks truncated (${value.length} chars); re-run "npm run vendor"`,
    );
  }
  return value;
}

/**
 * Dev mode bypasses the operator consent screen, so it must never listen on a
 * reachable interface. This is a guardrail, not a substitute for TLS.
 *
 * @param {string} host
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  if (typeof host !== 'string') return false;
  const value = host.trim().toLowerCase();
  return value === 'localhost' || value === '::1' || /^127\./.test(value);
}

/**
 * @param {string} host
 */
export function assertDevModeHost(host) {
  if (!isLoopbackHost(host)) {
    throw new Error(
      `DEV_MODE/--dev 只允許 loopback（127.0.0.1、::1、localhost）；` +
        `目前是 ${host}。要對外服務請關掉 dev mode 並完成同意畫面。`,
    );
  }
}

export const DEFAULT_CONSENT_HTML = fileURLToPath(
  new URL('../../runtime/consent.html', import.meta.url),
);

const CONFIG_MARKER = '<!-- MYOBS_CONSENT_DATA -->';

/**
 * Minimal stand-in used when packages/runtime/consent.html is missing (partial
 * deploy, hand-built fixture). It keeps the flow working instead of leaving the
 * operator with no way to record consent.
 */
export const FALLBACK_CONSENT_HTML = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<title>my-obsidian — 授權聲明確認</title>
</head><body>
<h1>授權聲明確認</h1>
<p>renderer 啟動時會向宿主索取一段聲明字串並逐字比對，不符即中止啟動。本 server 尚未設定該字串，
因此 <code>/obsidian/app.js</code> 不提供。</p>
<p>完整的同意畫面（<code>packages/runtime/consent.html</code>）不在這個部署裡，以下是簡化版。
在專案根目錄執行以下指令，取出 <code>vendor/obsidian/app.js</code> 內用來比對的字面值，貼到下面並送出：</p>
<pre>grep -o '"[^"]\\{40,\\}"[^"]*sendSync("terms")' vendor/obsidian/app.js | sed 's/^"//; s/".*$//'</pre>
<form id="f">
<p><label><input type="checkbox" id="ack"> 我了解這是與 Obsidian 無隸屬關係的非官方專案；我已閱讀並接受 Obsidian 自己的條款；
我只在自己的機器與 vault 使用、不對他人提供 renderer；本軟體不附保證，風險自負（詳見 NOTICE.md）。</label></p>
<textarea id="terms" rows="6" cols="80" spellcheck="false"></textarea>
<button type="submit">我確認，並寫入設定檔</button>
</form>
<p id="m"></p>
<p class="muted">也可以改用環境變數 <code>TERMS_ACK</code>（優先於設定檔），然後重新啟動 server。</p>
<script>
document.getElementById("f").addEventListener("submit", function (e) {
	e.preventDefault();
	var value = document.getElementById("terms").value.trim();
	var out = document.getElementById("m");
	if (!document.getElementById("ack").checked) {
		out.textContent = "請先勾選確認事項。";
		return;
	}
	if (value.length < ${MIN_TERMS_LENGTH}) {
		out.textContent = "字串太短（" + value.length + "），請確認貼上的是完整內容。";
		return;
	}
	fetch("/api/consent", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ termsText: value, acknowledgements: ${JSON.stringify(REQUIRED_ACKNOWLEDGEMENTS)} })
	}).then(function (r) { return r.json(); }).then(function (body) {
		out.textContent = body && body.ok
			? "已寫入，請重新載入："
			: "寫入失敗：" + ((body && body.error && body.error.message) || "未知錯誤");
		if (body && body.ok) {
			var a = document.createElement("a");
			a.href = "/";
			a.textContent = "/";
			out.appendChild(a);
		}
	}).catch(function (err) { out.textContent = "送出失敗：" + err.message; });
});
</script>
</body></html>
`;

/**
 * Config file location: MYOBS_CONFIG wins, otherwise the per-user XDG location.
 *
 * @returns {string} absolute path
 */
export function defaultConfigPath() {
  const fromEnv = process.env.MYOBS_CONFIG;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return path.resolve(fromEnv.trim());
  }
  return path.join(os.homedir(), '.config', 'my-obsidian', 'config.json');
}

/**
 * @param {string} configPath
 * @returns {{ [key: string]: unknown }} the parsed object, or {} when the file
 *   is missing, unreadable, or not a JSON object.
 */
function readConfigObject(configPath) {
  if (typeof configPath !== 'string' || configPath === '') return {};
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    // Missing or unreadable config is simply "nothing recorded yet".
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed;
}

/**
 * Read the stored consent, if any.
 *
 * Never throws: a missing, unreadable, malformed or truncated file all mean
 * "the operator has not recorded consent", which puts the renderer gate back on
 * the consent page instead of stalling the renderer with a bad string.
 *
 * @param {string} configPath
 * @returns {{ termsText: string } | null}
 */
export function readConsent(configPath) {
  const stored = readConfigObject(configPath);
  const termsText = stored.termsText;
  if (typeof termsText !== 'string') return null;
  const value = termsText.trim();
  if (value.length < MIN_TERMS_LENGTH) return null;
  return { termsText: value };
}

/**
 * Store the operator's acknowledgement.
 *
 * Atomic on purpose: the file is written to a sibling temp file and renamed over
 * the target, so a crash or a concurrent reader never sees a half-written file
 * (a truncated file would read as "not accepted" and silently re-lock the
 * renderer). Directory 0700 / file 0600: the value is a declaration by the
 * operator, not a secret, but it is theirs and should not be world-readable.
 *
 * @param {string} configPath
 * @param {string} termsText
 * @returns {Promise<string>} the absolute path that was written
 */
export async function writeConsent(configPath, termsText, record = {}) {
  if (typeof configPath !== 'string' || configPath === '') {
    throw new Error('writeConsent: configPath 必須是檔案路徑');
  }
  if (typeof termsText !== 'string') {
    throw new Error('writeConsent: termsText 必須是字串');
  }
  const value = termsText.trim();
  if (value.length < MIN_TERMS_LENGTH) {
    throw new Error(
      `writeConsent: termsText 只有 ${value.length} 個字元，短於 ${MIN_TERMS_LENGTH}，拒絕寫入`,
    );
  }

  const resolved = path.resolve(configPath);
  const dir = path.dirname(resolved);
  const created = await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  if (created !== undefined) {
    // mkdir's mode is masked by umask, and only newly created directories have
    // it at all. Never tighten a directory the operator pointed us at, so an
    // existing shared path is left exactly as it was.
    await fs.promises.chmod(dir, 0o700);
  }

  // Other keys in the config file belong to other workstreams; keep them.
  const payload = `${JSON.stringify({ ...readConfigObject(resolved), ...record, termsText: value }, null, 2)}\n`;
  const tmp = path.join(
    dir,
    `.${path.basename(resolved)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`,
  );

  let handle;
  try {
    handle = await fs.promises.open(tmp, 'wx', 0o600);
    await handle.writeFile(payload, 'utf8');
    // Flush before the rename: the rename is what makes the new content
    // visible, so the bytes must be on disk first.
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.promises.rename(tmp, resolved);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }

  // open(0600) is umask-masked too; make the final mode exact.
  await fs.promises.chmod(resolved, 0o600);
  return resolved;
}

/**
 * @param {object} data
 * @returns {string}
 */
function renderDataIsland(data) {
  const json = JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `<script type="application/json" id="myobs-consent-data">${json}</script>`;
}

/**
 * Build the consent page.
 *
 * The page itself never contains the acknowledgement string; the only dynamic
 * part is the data island describing the current state.
 *
 * @param {object} [options]
 * @param {string} [options.consentHtmlPath] Defaults to packages/runtime/consent.html.
 * @param {string} [options.configPath] Shown so the operator knows what will be written.
 * @param {boolean} [options.accepted] Current state, from the live holder.
 * @param {'option'|'env'|'config'|null} [options.source] Where the value came from.
 * @returns {string}
 */
export function consentPage(options = {}) {
  const htmlPath = options.consentHtmlPath ?? DEFAULT_CONSENT_HTML;
  let template;
  try {
    template = fs.readFileSync(htmlPath, 'utf8');
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      template = FALLBACK_CONSENT_HTML;
    } else {
      throw err;
    }
  }

  const island = renderDataIsland({
    accepted: Boolean(options.accepted),
    source: options.source ?? null,
    configPath: options.configPath ?? null,
    minLength: MIN_TERMS_LENGTH,
  });

  if (template.includes(CONFIG_MARKER)) {
    // First occurrence only: the page's own documentation may quote the marker
    // verbatim, and that copy must stay as-is.
    return template.replace(CONFIG_MARKER, () => island);
  }
  if (/<\/body>/i.test(template)) {
    return template.replace(/<\/body>/i, () => `${island}\n</body>`);
  }
  return `${template}\n${island}\n`;
}

/**
 * Wire the consent endpoints.
 *
 *   GET  /consent       the page
 *   POST /api/consent   { termsText } -> writes the config file
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} options
 * @param {string} options.configPath
 * @param {() => string} [options.getTermsText] Live value, so the page can show
 *   the current state and where it came from.
 * @param {() => void} [options.onAccepted] Called after a successful write, so
 *   the caller can refresh whatever it caches.
 * @param {string} [options.consentHtmlPath]
 * @returns {void}
 */
export function registerConsentRoutes(app, options) {
  const configPath = options.configPath;
  const getTermsText =
    typeof options.getTermsText === 'function' ? options.getTermsText : () => '';
  const onAccepted =
    typeof options.onAccepted === 'function' ? options.onAccepted : () => {};
  const consentHtmlPath = options.consentHtmlPath ?? DEFAULT_CONSENT_HTML;

  app.get('/consent', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.type('text/html; charset=utf-8').send(
      consentPage({
        consentHtmlPath,
        configPath,
        accepted: getTermsText().trim() !== '',
        source: options.getSource ? options.getSource() : null,
      }),
    );
  });

  app.post('/api/consent', async (request, reply) => {
    const fail = (code, message) =>
      reply.code(400).type('application/json; charset=utf-8').send({
        ok: false,
        error: { code, message },
      });

    let body = request.body;
    // The app-wide content-type parser hands anything non-JSON to the handler as
    // a Buffer; accept a JSON string body too so `curl -d '{...}'` works.
    if (Buffer.isBuffer(body) || typeof body === 'string') {
      try {
        body = JSON.parse(body.toString());
      } catch {
        return fail(
          'EINVAL',
          'body 不是 JSON。請送 { "termsText": "<從 vendor/obsidian/app.js 取出的字串>" }。',
        );
      }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail(
        'EINVAL',
        'body 必須是 JSON 物件 { "termsText": "<從 vendor/obsidian/app.js 取出的字串>" }。',
      );
    }

    const raw = /** @type {{ termsText?: unknown }} */ (body).termsText;
    if (typeof raw !== 'string') {
      return fail('EINVAL', 'termsText 必須是字串，且是 vendor/obsidian/app.js 內的那段字面值。');
    }
    const value = raw.trim();
    if (value === '') {
      return fail('EINVAL', 'termsText 是空的；請先從 vendor/obsidian/app.js 取出字串再送出。');
    }
    if (value.length < MIN_TERMS_LENGTH) {
      return fail(
        'EINVAL',
        `termsText 只有 ${value.length} 個字元，短於 ${MIN_TERMS_LENGTH}；` +
          '請確認貼上的是完整字串，renderer 的比對是逐字元的，截斷的內容不可能通過。',
      );
    }

    const acknowledged = /** @type {{ acknowledgements?: unknown }} */ (body).acknowledgements;
    const given = new Set(Array.isArray(acknowledged) ? acknowledged : []);
    const missingAcks = REQUIRED_ACKNOWLEDGEMENTS.filter((id) => !given.has(id));
    if (missingAcks.length > 0) {
      return fail(
        'EACK',
        `缺少必要確認：${missingAcks.join(', ')}。請在同意頁逐項勾選；` +
          '用 curl 時請送 { "termsText": "…", "acknowledgements": ' +
          `${JSON.stringify(REQUIRED_ACKNOWLEDGEMENTS)} }（先讀 NOTICE.md）。`,
      );
    }

    await writeConsent(configPath, value, {
      acknowledgements: [...REQUIRED_ACKNOWLEDGEMENTS],
      noticeVersion: CONSENT_NOTICE_VERSION,
      acknowledgedAt: new Date().toISOString(),
    });
    onAccepted();
    return reply.type('application/json; charset=utf-8').send({ ok: true });
  });
}

/**
 * Live acceptance state.
 *
 * `termsAccepted` is derived from the current text every time it is read --
 * never from a boolean flag, and never cached (CONTRACTS.md §1). Values are
 * whitespace-trimmed on the way in: the renderer's literal has no surrounding
 * whitespace, so a stray newline from a copy/paste or `$(cat file)` would
 * otherwise guarantee a mismatch.
 *
 * Precedence is explicit option -> TERMS_ACK env -> config file. `termsAccepted:
 * false` is the one flag that still means something, and only in the closing
 * direction: it suppresses every text source (used by embedders and tests that
 * want the gate shut), it can never mark a vault accepted without a string.
 *
 * @param {object} [options]
 * @param {string} [options.termsText] Explicit text (highest precedence).
 * @param {boolean} [options.termsAccepted] Only `false` is meaningful: close the gate.
 * @param {string} [options.envTermsText] Raw TERMS_ACK value.
 * @param {string} [options.configPath] Config file to read when nothing else is set.
 * @returns {{ termsText: string, termsAccepted: boolean, source: 'option'|'env'|'config'|null }}
 */
export function createConsentState(options = {}) {
  const gateClosed = options.termsAccepted === false;
  const optionText = normalizeText(options.termsText);
  const envText = normalizeText(options.envTermsText);
  const configPath = options.configPath;

  /** @returns {{ termsText: string, source: 'option'|'env'|'config'|null }} */
  function resolve() {
    if (!gateClosed) {
      if (optionText !== undefined) return { termsText: optionText, source: 'option' };
      if (envText !== undefined) return { termsText: envText, source: 'env' };
      // Re-read on every access: a POST /api/consent (or a hand-edited config)
      // must take effect without restarting the server.
      const stored = configPath ? readConsent(configPath) : null;
      if (stored) return { termsText: stored.termsText, source: 'config' };
    }
    return { termsText: '', source: null };
  }

  const state = {
    get termsText() {
      return resolve().termsText;
    },
    get termsAccepted() {
      return state.termsText !== '';
    },
    get source() {
      return resolve().source;
    },
  };
  return state;
}

/**
 * @param {unknown} value
 * @returns {string | undefined} trimmed value, or undefined when unusable
 */
function normalizeText(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Apply live consent to a boot object (CONTRACTS.md §1): `termsAccepted` always
 * present, `termsText` only when accepted. Called per request so the renderer
 * gate follows the consent state without a restart.
 *
 * @template {object} T
 * @param {T} boot
 * @param {{ termsAccepted: boolean, termsText: string }} consent
 * @returns {T}
 */
export function withConsentTerms(boot, consent) {
  const termsAccepted = Boolean(consent && consent.termsAccepted);
  const next = { ...boot, termsAccepted };
  if (termsAccepted) {
    next.termsText = consent.termsText;
  } else {
    delete next.termsText;
  }
  return next;
}
