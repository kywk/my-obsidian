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

import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { finished } from 'node:stream/promises';

import { resolveVaultAbsolute, relativeFromVault } from './paths.js';
import { contentTypeFor } from './static.js';
import { recordOriginToken, captureOriginVersion, runOriginMutation } from './watch.js';

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
function statusForFileError(code) {
  if (code === 'EPERM' || code === 'EACCES') return 403;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 404;
  if (code === 'EISDIR') return 400;
  if (code === 'ETOOBIG' || code === 'E2BIG') return 413;
  if (code === 'ENOSPC') return 507;
  return 500;
}

function sendFileError(request, reply, err) {
  const code = /** @type {NodeJS.ErrnoException} */ (err)?.code ?? 'EUNKNOWN';
  const message = /** @type {Error} */ (err)?.message ?? String(err);
  return sendJsonError(request, reply, statusForFileError(code), code, message);
}

/**
 * Error response after reply.hijack(): Fastify no longer owns the socket, so
 * the body and headers are written directly.
 *
 * @param {import('fastify').FastifyReply} reply
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @returns {void}
 */
function sendRawJsonError(reply, status, code, message) {
  const raw = reply.raw;
  if (raw.writableEnded || raw.destroyed || raw.writable === false) return;
  const body = JSON.stringify({ ok: false, error: { code, message } });
  raw.statusCode = status;
  raw.setHeader('content-type', 'application/json; charset=utf-8');
  raw.setHeader('content-length', String(Buffer.byteLength(body)));
  // A disconnect can destroy the socket between the check above and end(); a
  // hijacked reply has no other owner to swallow that error, and an unhandled
  // 'error' event would take the whole process down.
  raw.once('error', () => {});
  raw.end(body);
}

/**
 * @param {import('fastify').FastifyReply} reply
 * @param {unknown} err
 * @returns {void}
 */
function sendRawFileError(reply, err) {
  const code = /** @type {NodeJS.ErrnoException} */ (err)?.code ?? 'EUNKNOWN';
  const message = /** @type {Error} */ (err)?.message ?? String(err);
  sendRawJsonError(reply, statusForFileError(code), code, message);
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
 * Stream the request body into `tempPath` without buffering it.
 *
 * The route takes over the reply before Fastify's content-type parser runs
 * (see handleStreamingPut), so this reads `request.raw` directly. A destination
 * error must leave the client able to receive an error response, which is why
 * this does not use stream.pipeline(): pipeline destroys the request stream on
 * any error, and destroying an IncomingMessage destroys its socket before the
 * 4xx/5xx can be written.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {string} tempPath
 * @param {number} limit
 * @returns {Promise<{ written: number, digest: string }>}
 * @throws {NodeJS.ErrnoException}
 */
async function streamRequestBodyToFile(request, tempPath, limit) {
  // `wx` never truncates an existing file; the name carries a random UUID, so a
  // collision is a bug rather than a retry case.
  const out = fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
  try {
    await once(out, 'open');
  } catch (err) {
    out.destroy();
    throw err;
  }

  let written = 0;
  const hash = createHash('sha256');
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (err) => {
        if (settled) return;
        settled = true;
        request.raw.off('data', onData);
        request.raw.off('end', onEnd);
        request.raw.off('error', onError);
        request.raw.off('close', onClose);
        out.off('drain', onDrain);
        out.off('error', onError);
        if (err) reject(err);
        else resolve();
      };
      const onData = (chunk) => {
        written += chunk.length;
        hash.update(chunk);
        if (written > limit) {
          const error = new Error(`request body exceeds ${limit} bytes`);
          // @ts-expect-error errno-style code for statusForFileError()
          error.code = 'ETOOBIG';
          // Pause rather than destroy: the socket has to stay alive long
          // enough to deliver the 413.
          request.raw.pause();
          settle(error);
          return;
        }
        if (!out.write(chunk)) request.raw.pause();
      };
      const onDrain = () => request.raw.resume();
      const onEnd = () => settle();
      const onError = (err) => settle(err);
      const onClose = () => {
        // 'close' also follows a normal 'end'; `complete` distinguishes them.
        if (request.raw.complete) return;
        const error = new Error('client aborted the upload');
        // @ts-expect-error errno-style code for statusForFileError()
        error.code = 'ECONNRESET';
        settle(error);
      };

      request.raw.on('data', onData);
      request.raw.on('end', onEnd);
      request.raw.on('error', onError);
      request.raw.on('close', onClose);
      out.on('drain', onDrain);
      out.on('error', onError);
    });

    const flushed = finished(out);
    out.end();
    await flushed;
    return { written, digest: hash.digest('hex') };
  } catch (err) {
    /*
     * Finish the file instead of destroying it: fs.WriteStream.destroy()
     * while an fs.write is in flight leaves the completion callback writing
     * into a destroyed stream, which surfaces as an uncaughtException from
     * node:internal/fs/streams (Node does not turn it into an 'error' event).
     * At most one highWaterMark of data is still queued here and the temp file
     * is discarded either way, so flushing it is bounded work.
     */
    try {
      out.end();
    } catch {
      /* already finished or errored */
    }
    await finished(out).catch(() => {});
    if (!out.closed) await once(out, 'close').catch(() => {});
    throw err;
  }
}

/**
 * PUT /v/* handler.
 *
 * Why route-level hijack instead of Fastify's body parser: index.js installs a
 * catch-all `parseAs: "buffer"` parser, so the handler receives the whole body
 * as one Buffer (bodyLimit is 2 GiB). A custom content-type parser would be
 * app-wide and would change /api/consent's non-JSON body shape; preParsing
 * could stream the body but the parser would still run on the (empty) stream
 * and reject application/json. reply.hijack() in onRequest is the only
 * route-scoped way to keep the raw stream.
 *
 * Atomicity: the body goes to a sibling temp file with a UUID name and is
 * promoted with rename() in the same directory. A failed or aborted upload
 * unlinks the temp; the previous destination is never touched.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 * @param {import('./paths.js').Vault} vault
 * @param {number} bodyLimit
 * @returns {Promise<void>}
 */
async function handleStreamingPut(request, reply, vault, bodyLimit) {
  // Take the reply before the body parser is reached. Every exit path below
  // writes through reply.raw; Fastify must not send anything itself.
  reply.hijack();

  const requested = vaultPathFromParams(request);
  if (requested === '') {
    sendRawJsonError(reply, 400, 'EINVAL', 'missing path');
    return;
  }

  let resolved;
  try {
    resolved = await resolveVaultAbsolute(vault, toAbsoluteInput(requested));
  } catch (err) {
    sendRawFileError(reply, err);
    return;
  }

  // Write through symlinks the way fs.writeFile did: rename onto the resolved
  // target, not onto the link itself (renaming over a link would replace it).
  const destination = resolved.real;
  const tempPath = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.myobs-upload`,
  );

  let renamed = false;
  try {
    const uploaded = await streamRequestBodyToFile(request, tempPath, bodyLimit);

    // A client that vanished after the last chunk but before rename must not
    // get a half-written upload promoted. (`complete` is not usable here:
    // light-my-request's simulated body leaves it undefined, while
    // readableAborted is defined by the stream itself.)
    if (request.raw.readableAborted === true) {
      return;
    }

    await runOriginMutation([resolved.abs, destination], async () => {
      if (request.raw.readableAborted === true || reply.raw.destroyed) return;
      await fs.promises.rename(tempPath, destination);
      renamed = true;
      const version = await captureOriginVersion(destination, uploaded.digest);
      const writeToken = request.headers['x-write-token'];
      const token = typeof writeToken === 'string' ? writeToken : undefined;
      recordOriginToken(resolved.rel, token, version);
      if (resolved.real !== resolved.abs) recordOriginToken(relativeFromVault(vault, resolved.real), token, version);
    });
  } catch (err) {
    // The response socket is gone when the uploader disconnected; there is
    // nobody to send the error to. The finally block still removes the temp.
    const aborted =
      /** @type {NodeJS.ErrnoException} */ (err)?.code === 'ECONNRESET' ||
      request.raw.readableAborted === true ||
      reply.raw.destroyed;
    if (!aborted) sendRawFileError(reply, err);
    return;
  } finally {
    if (!renamed) await fs.promises.rm(tempPath, { force: true }).catch(() => {});
  }

  if (!renamed) return;
  reply.raw.statusCode = 204;
  reply.raw.end();
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

  /*
   * reply.hijack() stops Fastify's lifecycle before the body parser, so the
   * dummy handler below is unreachable; keeping it registered is what makes
   * find-my-way route PUT /v/* here at all. The onRequest hook runs after the
   * global onRequest hooks (AUTH_TOKEN), so hijacking cannot bypass auth.
   */
  app.put(
    '/v/*',
    {
      bodyLimit,
      onRequest: (request, reply) => handleStreamingPut(request, reply, vault, bodyLimit),
    },
    async () => {
      // Unreachable: handleStreamingPut owns the reply from onRequest onward.
    },
  );
}
