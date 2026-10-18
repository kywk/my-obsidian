/**
 * Static assets and the boot injection into the runtime HTML.
 *
 * GET /obsidian/* serves vendor/obsidian verbatim (app.js must stay
 * byte-identical to the official release). GET / reads
 * packages/runtime/index.html and replaces <!-- MYOBS_BOOT --> with the
 * synchronous boot object from CONTRACTS.md §1.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isInside } from './paths.js';

export const BOOT_MARKER = '<!-- MYOBS_BOOT -->';

/** Minimal page used when packages/runtime/index.html does not exist yet. */
export const FALLBACK_RUNTIME_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>my-obsidian</title>
${BOOT_MARKER}
</head>
<body>
<p>runtime/index.html 尚未建立；server 已啟動，boot 物件已注入。</p>
</body></html>
`;

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.cjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.ico', 'image/x-icon'],
  ['.bmp', 'image/bmp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.eot', 'application/vnd.ms-fontobject'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
]);

/**
 * @param {string} filePath
 * @returns {string}
 */
export function contentTypeFor(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function safeDecode(raw) {
  if (typeof raw !== 'string') return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Build the synchronous boot script. JSON is escaped so a vault name
 * containing "</script>" cannot terminate the tag.
 *
 * @param {object} boot
 * @returns {string}
 */
export function renderBootScript(boot) {
  const json = JSON.stringify(boot)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `<script>window.__MYOBS = ${json};</script>`;
}

/**
 * @param {string} template
 * @param {object} boot
 * @returns {string}
 */
export function injectBoot(template, boot) {
  const script = renderBootScript(boot);
  if (template.includes(BOOT_MARKER)) {
    return template.replace(BOOT_MARKER, script);
  }
  // The contract template carries the marker. If it is missing (hand-written
  // test fixture), inject immediately after <head> so the object still exists
  // before any shim or app script.
  const headOpen = /<head\b[^>]*>/i.exec(template);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return `${template.slice(0, at)}${script}\n${template.slice(at)}`;
  }
  return `${script}\n${template}`;
}

/**
 * @returns {string}
 */
function termsPage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>my-obsidian — 尚未完成條款確認</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1.5rem;line-height:1.7;color:#222}code{background:#f2f2f2;padding:.15rem .35rem;border-radius:4px}</style>
</head><body>
<h1>尚未完成條款確認</h1>
<p>這個伺服器還沒有設定 <code>TERMS_ACK</code>，因此不會載入 Obsidian renderer，也不提供 <code>/obsidian/app.js</code>。</p>
<p>請由操作者本人完成 Obsidian 授權條款的確認，將確認結果設定為 <code>TERMS_ACK</code> 環境變數後重新啟動服務。專案程式碼不內建該條款字串。</p>
</body></html>
`;
}

/**
 * @param {string} vendorDir
 * @param {string} relativePath
 * @returns {string}
 */
function vendorMissingMessage(vendorDir, relativePath) {
  return [
    `找不到 Obsidian 靜態資產: ${relativePath || '(空路徑)'}`,
    `vendor 目錄: ${vendorDir}`,
    '請先執行 scripts/fetch-obsidian.mjs 取得 vendor/obsidian/*。',
  ].join('\n');
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {object} options
 * @param {string} options.vendorDir
 * @param {string} options.runtimeIndexPath
 * @param {object} options.boot
 * @param {boolean} options.termsAccepted
 * @returns {void}
 */
export function registerStaticRoutes(app, options) {
  const { vendorDir, shimDir, runtimeIndexPath, boot, termsAccepted } = options;

  /**
   * Serves one asset tree with containment checks and symlink verification.
   *
   * `gateAppJs` exists because the renderer itself may only be delivered after
   * the operator accepted the terms (docs/DESIGN.md §8); everything else under
   * vendor/ is inert.
   *
   * @param {string} rootDir absolute directory to serve from
   * @param {(relativePath: string) => string} missing
   * @param {{ gateAppJs?: boolean, cacheControl?: string }} [opts]
   */
  function assetTree(rootDir, missing, opts = {}) {
    const root = path.resolve(rootDir);

    return async function handle(request, reply) {
      const raw = /** @type {{ '*'?: string }} */ (request.params)['*'] ?? '';
      const requested = safeDecode(raw).replace(/^\/+/, '');

      let relative;
      try {
        relative = path.posix.normalize(requested);
      } catch {
        relative = '';
      }

      const reject = () =>
        reply.code(404).type('text/plain; charset=utf-8').send(missing(requested));

      if (opts.gateAppJs && relative === 'app.js' && !termsAccepted) {
        return reply
          .code(403)
          .type('text/plain; charset=utf-8')
          .send('尚未設定 TERMS_ACK，依照 CONTRACTS.md §1 不提供 /obsidian/app.js。');
      }

      if (
        relative === '' ||
        relative === '.' ||
        relative === '..' ||
        relative.startsWith('../') ||
        relative.includes('\0') ||
        path.isAbsolute(relative)
      ) {
        return reject();
      }

      const absolute = path.resolve(root, ...relative.split('/'));
      if (!isInside(root, absolute)) return reject();

      let st;
      try {
        st = await fs.promises.stat(absolute);
      } catch (err) {
        const code = /** @type {NodeJS.ErrnoException} */ (err).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return reject();
        throw err;
      }
      if (!st.isFile()) return reject();

      const realRoot = await fs.promises.realpath(root).catch(() => root);
      const real = await fs.promises.realpath(absolute).catch(() => absolute);
      if (!isInside(realRoot, real)) return reject();

      reply
        .code(200)
        .header('Content-Type', contentTypeFor(relative))
        .header('Content-Length', String(st.size))
        .header('Cache-Control', opts.cacheControl ?? 'no-cache')
        .send(fs.createReadStream(absolute));
      return reply;
    };
  }

  app.get(
    '/obsidian/*',
    assetTree(vendorDir, (rel) => vendorMissingMessage(vendorDir, rel), {
      gateAppJs: true,
    }),
  );

  // Obsidian lazy-loads its heavy libraries with root-absolute paths --
  // yE("/lib/mermaid.min.js"), yE("/lib/pdfjs/pdf.min.mjs"),
  // yE("/lib/prism.min.js"), yE("/lib/mathjax/obsidian-mathjax.js"),
  // yE("/lib/reveal/reveal.js"), yE("/lib/codemirror/modes.min.js").
  //
  // On desktop the document base is app://obsidian.md/, so "/lib" means the app
  // root. Here the app root is /obsidian/, so /lib must be registered as an
  // alias. Without it Mermaid, the PDF viewer, syntax highlighting, MathJax and
  // Slides all 404, and their lazy-load promises reject with a bare Event --
  // which shows up as an unhandled rejection rather than a missing asset.
  app.get(
    '/lib/*',
    assetTree(path.join(vendorDir, 'lib'), (rel) =>
      vendorMissingMessage(vendorDir, `lib/${rel}`),
    ),
  );

  // The runtime page loads the shim layer from /shim/*. Without this route the
  // classic scripts 404, window.require never exists, and app.js dies on its
  // first line -- the single most likely way to break boot.
  app.get(
    '/shim/*',
    assetTree(
      shimDir,
      (rel) =>
        [
          `shim script not found: /shim/${rel}`,
          `expected under: ${shimDir}`,
          'the shim layer lives in packages/shim/src and is not generated.',
        ].join('\n'),
      // Shim edits must reach the browser immediately; a stale cache here looks
      // exactly like a code bug.
      { cacheControl: 'no-store' },
    ),
  );

  // Browsers request /favicon.ico unconditionally; serve Obsidian's own icon
  // rather than logging a 404 on every load.
  app.get('/favicon.ico', async (request, reply) => {
    const icon = path.join(vendorDir, 'icon.png');
    try {
      const st = await fs.promises.stat(icon);
      return reply
        .code(200)
        .header('Content-Type', 'image/png')
        .header('Content-Length', String(st.size))
        .header('Cache-Control', 'no-cache')
        .send(fs.createReadStream(icon));
    } catch {
      return reply.code(404).send();
    }
  });

  app.get('/', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');

    if (!termsAccepted) {
      return reply.type('text/html; charset=utf-8').send(termsPage());
    }

    let template;
    try {
      template = await fs.promises.readFile(runtimeIndexPath, 'utf8');
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        template = FALLBACK_RUNTIME_HTML;
      } else {
        throw err;
      }
    }

    return reply
      .type('text/html; charset=utf-8')
      .send(injectBoot(template, boot));
  });
}
