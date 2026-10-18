/**
 * GET|PUT|HEAD /v/<absolute-path-without-leading-slash>
 *
 * Used by the renderer for attachments (<img>, <video>, PDF) and for large
 * uploads. Only paths inside the vault are served; everything else is 403.
 */

import fs from 'node:fs';
import { resolveVaultAbsolute } from './paths.js';
import { contentTypeFor } from './static.js';

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
 * @param {string | undefined} header
 * @param {number} size
 * @returns {{ start: number, end: number } | null | 'invalid'}
 */
export function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return 'invalid';
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return 'invalid';
  if (size <= 0) return 'invalid';

  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    return { start: Math.max(size - suffix, 0), end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd === '' ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
  if (start >= size || end < start) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

/**
 * @param {import('fastify').FastifyReply} reply
 * @param {unknown} err
 */
function sendFileError(reply, err) {
  const code = /** @type {NodeJS.ErrnoException} */ (err)?.code ?? 'EUNKNOWN';
  const message = /** @type {Error} */ (err)?.message ?? String(err);
  let status = 500;
  if (code === 'EPERM' || code === 'EACCES') status = 403;
  else if (code === 'ENOENT' || code === 'ENOTDIR') status = 404;
  else if (code === 'EISDIR') status = 400;
  reply
    .code(status)
    .type('application/json; charset=utf-8')
    .send({ ok: false, error: { code, message } });
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
    const raw = /** @type {{ '*'?: string }} */ (request.params)['*'] ?? '';
    const decoded = safeDecode(raw);
    if (decoded === '') {
      return reply
        .code(404)
        .type('application/json; charset=utf-8')
        .send({ ok: false, error: { code: 'ENOENT', message: 'missing path' } });
    }

    try {
      // The URL carries an absolute path with the leading slash removed.
      const absoluteInput = decoded.startsWith('/') ? decoded : `/${decoded}`;
      const resolved = await resolveVaultAbsolute(vault, absoluteInput);

      const st = await fs.promises.stat(resolved.abs);
      if (!st.isFile()) {
        return reply
          .code(404)
          .type('application/json; charset=utf-8')
          .send({ ok: false, error: { code: 'ENOENT', message: 'not a file' } });
      }

      const headers = {
        'Content-Type': contentTypeFor(resolved.abs),
        'Accept-Ranges': 'bytes',
        'Last-Modified': new Date(st.mtimeMs).toUTCString(),
        'Cache-Control': 'no-cache',
      };

      const range = parseRange(request.headers.range, st.size);
      if (range === 'invalid') {
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
      return sendFileError(reply, err);
    }
  };

  app.get('/v/*', { exposeHeadRoute: false }, getOrHead);
  app.head('/v/*', getOrHead);

  app.put('/v/*', { bodyLimit }, async (request, reply) => {
    const raw = /** @type {{ '*'?: string }} */ (request.params)['*'] ?? '';
    const decoded = safeDecode(raw);
    if (decoded === '') {
      return reply
        .code(400)
        .type('application/json; charset=utf-8')
        .send({ ok: false, error: { code: 'EINVAL', message: 'missing path' } });
    }

    try {
      const absoluteInput = decoded.startsWith('/') ? decoded : `/${decoded}`;
      const resolved = await resolveVaultAbsolute(vault, absoluteInput);
      const body = Buffer.isBuffer(request.body)
        ? request.body
        : request.body === undefined || request.body === null
          ? Buffer.alloc(0)
          : Buffer.from(String(request.body));

      await fs.promises.writeFile(resolved.abs, body);
      return reply.code(204).send();
    } catch (err) {
      return sendFileError(reply, err);
    }
  });
}
