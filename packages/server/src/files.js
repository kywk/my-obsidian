/**
 * GET|PUT|HEAD /v/<absolute-path-without-leading-slash>
 *
 * Used by the renderer for attachments (<img>, <video>, PDF) and for large
 * uploads. Only paths inside the vault are served; everything else is 403.
 *
 * The URL shape comes from FileSystemAdapter.getResourcePath() (CONTRACTS.md §3):
 *
 *   resourcePathPrefix + pathToFileURL(abs).href.substring(8) + "?" + mtime
 *
 * The shim's url.pathToFileURL percent-encodes every path segment with
 * encodeURIComponent, so spaces, "#", "?", "%", emoji and CJK characters all
 * arrive escaped ("backpacker/1801%20Iceland/x.png", "a%2520b.png"). The
 * trailing "?<mtime>" is a cache-busting query the router strips for us.
 *
 * `PUT` accepts an optional `X-Write-Token` header and registers it in the
 * same per-path registry as the /api/fs write ops (see watch.js), so a large
 * upload's watcher event comes back tagged and the uploading tab can skip its
 * own echo. Without it every upload looks like an external change to the tab
 * that made it. `GET`/`HEAD` never touch the registry: a download is not a
 * mutation.
 */

import fs from 'node:fs';
import path from 'node:path';

import { resolveVaultAbsolute } from './paths.js';
import { contentTypeFor } from './static.js';
import { recordOriginToken } from './watch.js';

/**
 * Types that static.js's table does not cover but Obsidian's attachment views
 * need. Markdown is the important one: served as application/octet-stream the
 * browser downloads embed.md instead of rendering it, and a text/* type
 * without a charset lets the browser guess an encoding.
 *
 * @type {Map<string, string>}
 */
const ATTACHMENT_TYPES = new Map([
  ['.md', 'text/markdown; charset=utf-8'],
  ['.markdown', 'text/markdown; charset=utf-8'],
  ['.m4a', 'audio/mp4'],
  ['.flac', 'audio/flac'],
  ['.mov', 'video/quicktime'],
]);

/**
 * Text-ish types the browser must decode as UTF-8. static.js already labels
 * most of them; this is the net that keeps the guarantee true for anything
 * that table gains or loses later.
 *
 * @type {Set<string>}
 */
const UTF8_TYPES = new Set([
  'application/json',
  'application/manifest+json',
  'application/xml',
  'image/svg+xml',
]);

/**
 * @param {string} type
 * @returns {string}
 */
function ensureCharset(type) {
  if (type.includes('charset=')) return type;
  if (type.startsWith('text/') || UTF8_TYPES.has(type)) return `${type}; charset=utf-8`;
  return type;
}

/**
 * Content-Type for a vault file served through /v/*.
 *
 * @param {string} absolutePath
 * @returns {string}
 */
export function attachmentContentType(absolutePath) {
  const known = ATTACHMENT_TYPES.get(path.extname(absolutePath).toLowerCase());
  return ensureCharset(known ?? contentTypeFor(absolutePath));
}

/**
 * @typedef {{ start: number, end: number }} RangeSlice
 */

/**
 * Parse a `Range` header (RFC 9110 §14.1.1).
 *
 * Three outcomes, because "ignored" and "unsatisfiable" are different
 * responses: an unparseable or unsupported range (unknown unit, several
 * ranges, `bytes=5-2`) is ignored and the whole representation is sent with
 * 200, while a syntactically valid range that lies outside the file gets 416
 * plus `Content-Range: bytes *​/<size>`.
 *
 * @param {string | undefined} header
 * @param {number} size
 * @returns {RangeSlice | 'unsatisfiable' | null} null means "ignore the header"
 */
export function parseRange(header, size) {
  if (typeof header !== 'string') return null;

  const unit = /^([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*=\s*(.*)$/.exec(header.trim());
  if (unit === null) return null;
  // Unknown range units must be ignored, not rejected; only "bytes" is defined.
  if (unit[1].toLowerCase() !== 'bytes') return null;

  const spec = unit[2].trim();
  // multipart/byteranges is not implemented. Answering with the whole file is
  // allowed and keeps a multi-range request from turning into a 416.
  if (spec.includes(',')) return null;

  const match = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
  if (match === null) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  const length = Number.isFinite(size) && size > 0 ? Math.floor(size) : 0;

  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix)) return null;
    // A zero-length suffix, or any suffix on an empty file, selects nothing.
    if (suffix <= 0 || length === 0) return 'unsatisfiable';
    // "bytes=-N" with N larger than the file means "the whole thing", not 416.
    return { start: Math.max(length - suffix, 0), end: length - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start)) return null;
  if (start >= length) return 'unsatisfiable';
  if (rawEnd === '') return { start, end: length - 1 };

  const end = Number(rawEnd);
  if (!Number.isFinite(end)) return null;
  // last-byte-pos < first-byte-pos makes the byte-range-spec invalid, and an
  // invalid spec is ignored rather than answered with 416.
  if (end < start) return null;
  return { start, end: Math.min(end, length - 1) };
}

/**
 * Send `{ ok:false, error }` with the same headers a GET would produce.
 *
 * HEAD has to mirror GET's metadata, so the body is measured, declared and
 * then withheld rather than left to Node's http layer to strip.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @returns {import('fastify').FastifyReply}
 */
function sendJsonError(request, reply, status, code, message) {
  const body = JSON.stringify({ ok: false, error: { code, message } });
  reply
    .code(status)
    .type('application/json; charset=utf-8')
    .header('Content-Length', String(Buffer.byteLength(body)));
  return request.method === 'HEAD' ? reply.send() : reply.send(body);
}

/**
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 * @param {unknown} err
 * @returns {import('fastify').FastifyReply}
 */
function sendFileError(request, reply, err) {
  const code = /** @type {NodeJS.ErrnoException} */ (err)?.code ?? 'EUNKNOWN';
  const message = /** @type {Error} */ (err)?.message ?? String(err);
  let status = 500;
  if (code === 'EPERM' || code === 'EACCES') status = 403;
  else if (code === 'ENOENT' || code === 'ENOTDIR') status = 404;
  else if (code === 'EISDIR') status = 400;
  return sendJsonError(request, reply, status, code, message);
}

/**
 * The vault-absolute path carried by /v/*.
 *
 * The wildcard param is already percent-decoded by the router, exactly once:
 *
 *   GET /v/a%20b.png     -> params['*'] === 'a b.png'
 *   GET /v/a%2520b.png   -> params['*'] === 'a%20b.png'  (a file named "a%20b.png")
 *   GET /v/a%23b.png     -> params['*'] === 'a#b.png'
 *   GET /v/a%00b.png     -> params['*'] === 'a\u0000b.png' (then rejected as EPERM)
 *   GET /v/a%zz.png      -> 400 FST_ERR_BAD_URL, never reaches this handler
 *
 * Measured on Fastify 5.12.7 / find-my-way 9.10.0. Running decodeURIComponent
 * here would decode a second time: the file literally named "a%20b.png" (URL
 * "a%2520b.png") would be looked up as "a b.png" and the request would serve
 * the wrong attachment, or 404 where only one of the two exists.
 *
 * @param {import('fastify').FastifyRequest} request
 * @returns {string}
 */
function vaultPathFromParams(request) {
  const raw = /** @type {{ '*'?: unknown }} */ (request.params)['*'];
  return typeof raw === 'string' ? raw : '';
}

/**
 * @param {string} decoded
 * @returns {string} absolute path, as resolveVaultAbsolute expects
 */
function toAbsoluteInput(decoded) {
  return decoded.startsWith('/') ? decoded : `/${decoded}`;
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {object} options
 * @param {import('./paths.js').Vault} options.vault
 * @param {number} [options.bodyLimit]
 * @returns {void}
 */
export function registerFileRoutes(app, options) {
  const { vault } = options;
  const bodyLimit = Number.isFinite(options.bodyLimit)
    ? Number(options.bodyLimit)
    : 2 * 1024 * 1024 * 1024;

  /** @type {(request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<import('fastify').FastifyReply>} */
  const getOrHead = async (request, reply) => {
    const requested = vaultPathFromParams(request);
    if (requested === '') return sendJsonError(request, reply, 404, 'ENOENT', 'missing path');

    try {
      // The URL carries an absolute path; relative input is resolved against
      // the vault root by resolveVaultAbsolute.
      const resolved = await resolveVaultAbsolute(vault, toAbsoluteInput(requested));

      const st = await fs.promises.stat(resolved.abs);
      if (!st.isFile()) {
        return sendJsonError(request, reply, 404, 'ENOENT', 'not a file');
      }

      const headers = {
        'Content-Type': attachmentContentType(resolved.abs),
        'Accept-Ranges': 'bytes',
        'Last-Modified': new Date(st.mtimeMs).toUTCString(),
        'Cache-Control': 'no-cache',
      };

      const range = parseRange(request.headers.range, st.size);
      if (range === 'unsatisfiable') {
        return reply
          .code(416)
          .headers(headers)
          .header('Content-Range', `bytes */${st.size}`)
          .send();
      }

      if (range !== null) {
        const length = range.end - range.start + 1;
        reply
          .code(206)
          .headers(headers)
          .header('Content-Range', `bytes ${range.start}-${range.end}/${st.size}`)
          .header('Content-Length', String(length));
        if (request.method === 'HEAD') return reply.send();
        return reply.send(
          fs.createReadStream(resolved.abs, { start: range.start, end: range.end }),
        );
      }

      reply
        .code(200)
        .headers(headers)
        .header('Content-Length', String(st.size));
      if (request.method === 'HEAD') return reply.send();
      return reply.send(fs.createReadStream(resolved.abs));
    } catch (err) {
      return sendFileError(request, reply, err);
    }
  };

  app.get('/v/*', { exposeHeadRoute: false }, getOrHead);
  app.head('/v/*', getOrHead);

  app.put('/v/*', { bodyLimit }, async (request, reply) => {
    const requested = vaultPathFromParams(request);
    if (requested === '') {
      return sendJsonError(request, reply, 400, 'EINVAL', 'missing path');
    }

    try {
      const resolved = await resolveVaultAbsolute(vault, toAbsoluteInput(requested));
      const body = Buffer.isBuffer(request.body)
        ? request.body
        : request.body === undefined || request.body === null
          ? Buffer.alloc(0)
          : Buffer.from(String(request.body));

      await fs.promises.writeFile(resolved.abs, body);
      // Recorded after the write succeeded: a failed write must not leave a
      // token behind that would tag the next external edit to this path.
      // chokidar's awaitWriteFinish (300 ms) plus the 150 ms batch window
      // guarantee the event is generated well after this line runs.
      const writeToken = request.headers['x-write-token'];
      if (typeof writeToken === 'string' && writeToken !== '') {
        recordOriginToken(resolved.rel, writeToken);
      }
      return reply.code(204).send();
    } catch (err) {
      return sendFileError(request, reply, err);
    }
  });
}
