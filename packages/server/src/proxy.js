/**
 * GET /api/proxy?url=<absolute-url>
 *
 * The community-plugin browser in Obsidian talks to github.com and
 * raw.githubusercontent.com through `requestUrl`. Those hosts do not send CORS
 * headers, so the browser cannot fetch them directly; the shim rewrites those
 * calls to this route (packages/shim/src/net-rewrite.js).
 *
 * Security posture (DESIGN.md §3 #11): the server, not the client, decides what
 * may be fetched. The default is deny: only https on port 443, only hosts on
 * {@link PROXY_ALLOWED_HOSTS}, no credentials in the URL, no localhost or
 * private-IP literals. Redirects are followed manually and re-validated on every
 * hop, because a trusted host could otherwise redirect the proxy into the
 * private network.
 *
 * Responses are streamed, not buffered. A response over the byte cap is
 * rejected before the first byte whenever Content-Length announces it, and the
 * stream is aborted otherwise (headers may already have been sent at that
 * point; there is no way to turn a partially delivered 200 into a 502).
 */

import { Readable } from 'node:stream';

/**
 * Hosts the proxy may reach. Keep this list in sync with PROXY_HOSTS in
 * packages/shim/src/net-rewrite.js -- the shim list is a UX hint only; this
 * one is the enforcement point.
 *
 * @type {readonly string[]}
 */
export const PROXY_ALLOWED_HOSTS = Object.freeze([
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'codeload.github.com',
  'obsidian.md',
  'forum.obsidian.md',
  'help.obsidian.md',
]);

export const PROXY_TIMEOUT_MS = 10_000;
export const PROXY_MAX_BYTES = 32 * 1024 * 1024;

const DEFAULT_ALLOWED_HOSTS = new Set(PROXY_ALLOWED_HOSTS);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/**
 * Response headers worth passing through. Everything else is dropped,
 * including `set-cookie`: the proxy must never plant cookies in the browser's
 * origin for an upstream host.
 *
 * @type {Set<string>}
 */
const FORWARDED_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-disposition',
  'link',
  'etag',
  'last-modified',
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
]);

export class ProxyError extends Error {
  /**
   * @param {number} status HTTP status to return to the browser.
   * @param {string} code Machine-readable errno-style code.
   * @param {string} message Operator-facing explanation.
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'ProxyError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Lowercase a URL hostname and drop the optional trailing dot. The WHATWG URL
 * parser already lowercases ASCII hosts; the trailing dot survives, and
 * `github.com.` resolves to `github.com` at the DNS layer.
 *
 * @param {string} hostname
 * @returns {string}
 */
export function normalizeHostname(hostname) {
  let host = String(hostname).toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

/**
 * @param {string} host
 * @returns {boolean}
 */
function isPrivateIpv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match === null) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/**
 * @param {string} host
 * @returns {boolean}
 */
function isPrivateAddress(host) {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isPrivateIpv4(host)) return true;
  if (!host.includes(':')) return false;

  // IPv6 literal (URL.hostname keeps the brackets for IPv6; normalizeHostname
  // strips them). All IPv6 literals fail the allowlist anyway; this only makes
  // the rejection reason accurate.
  if (host === '::' || host === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // fe80::/10 link-local
  if (host.startsWith('::ffff:')) {
    const tail = host.slice('::ffff:'.length);
    return tail.includes('.') ? isPrivateIpv4(tail) : true;
  }
  return false;
}

/**
 * Validate a URL against the proxy policy.
 *
 * @param {string} raw
 * @param {object} [options] Test-only overrides. Production callers pass nothing.
 * @param {Iterable<string>} [options.allowedHosts]
 * @param {boolean} [options.allowHttp] Allow http and any port (local fake servers).
 * @returns {URL}
 * @throws {ProxyError}
 */
export function validateProxyUrl(raw, options = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ProxyError(400, 'EINVAL', 'missing url query parameter');
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ProxyError(400, 'EINVAL', `not an absolute URL: ${raw.slice(0, 200)}`);
  }

  const allowHttp = options.allowHttp === true;
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new ProxyError(
      403,
      'EPERM',
      `proxy only allows https: URLs (got ${url.protocol}); update the caller or use https`,
    );
  }

  // Credentials in the URL would be forwarded upstream as an Authorization
  // header by fetch. The proxy contract says Authorization is never forwarded.
  if (url.username !== '' || url.password !== '') {
    throw new ProxyError(403, 'EPERM', 'URLs with embedded credentials are not allowed');
  }

  if (!allowHttp && url.port !== '' && url.port !== '443' && url.port !== '80') {
    throw new ProxyError(
      403,
      'EPERM',
      `proxy only allows https on port 80 or 443 (got ${url.port})`,
    );
  }

  const host = normalizeHostname(url.hostname);
  const allowedHosts = options.allowedHosts
    ? new Set([...options.allowedHosts].map(normalizeHostname))
    : DEFAULT_ALLOWED_HOSTS;

  // The allowlist contains no IP literals or localhost, so these would fail
  // anyway. Checking first keeps the error message truthful and keeps the
  // private-address guard in place even if the allowlist gains an alias later.
  if (!allowHttp && isPrivateAddress(host)) {
    throw new ProxyError(
      403,
      'EPERM',
      `proxy refuses localhost and private addresses (${host})`,
    );
  }

  if (!allowedHosts.has(host)) {
    throw new ProxyError(
      403,
      'EPERM',
      `host "${host}" is not in the server proxy allowlist; edit PROXY_ALLOWED_HOSTS in packages/server/src/proxy.js`,
    );
  }

  return new URL(url.href);
}

/**
 * Follow redirects manually so every hop is re-validated.
 *
 * @param {URL} start
 * @param {object} context
 * @param {(input: string, init: object) => Promise<Response>} context.fetchImpl
 * @param {AbortSignal} context.signal
 * @param {Record<string, string>} context.headers
 * @param {object} context.policy
 * @returns {Promise<{ response: Response, url: URL }>}
 */
async function followRedirects(start, context) {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await context.fetchImpl(current.href, {
      method: 'GET',
      headers: context.headers,
      redirect: 'manual',
      signal: context.signal,
    });

    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, url: current };
    }

    const location = response.headers.get('location');
    if (response.body) {
      await response.body.cancel().catch(() => {});
    }
    if (typeof location !== 'string' || location === '') {
      throw new ProxyError(502, 'EBADGATEWAY', 'upstream redirect has no Location header');
    }

    const next = (() => {
      try {
        return new URL(location, current);
      } catch {
        throw new ProxyError(
          502,
          'EBADGATEWAY',
          'upstream redirect has an invalid Location header',
        );
      }
    })();
    // Throws ProxyError when the redirect leaves the allowlist, which is the
    // whole point of not using redirect: "follow".
    current = validateProxyUrl(next.href, context.policy);
  }

  throw new ProxyError(502, 'EBADGATEWAY', `upstream exceeded ${MAX_REDIRECTS} redirects`);
}

/**
 * @param {import('fastify').FastifyReply} reply
 * @param {unknown} err
 * @returns {import('fastify').FastifyReply}
 */
function sendProxyError(reply, err) {
  const known = err instanceof ProxyError;
  const status = known ? err.status : 500;
  const code = known ? err.code : 'EUNKNOWN';
  const message = err instanceof Error ? err.message : String(err);

  // A stream that failed after the first chunk cannot be turned into a JSON
  // error; destroy the connection so the client sees a truncated response
  // rather than a silently short body that looks complete.
  if (reply.raw.headersSent) {
    reply.raw.destroy();
    return reply;
  }

  return reply
    .code(status)
    .type('application/json; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('X-MyOBS-Proxy', '1')
    .header('X-MyOBS-Proxy-Error', code)
    .send({ ok: false, error: { code, message } });
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {object} [options]
 * @param {(input: string, init: object) => Promise<Response>} [options.fetchImpl]
 * @param {number} [options.timeoutMs] Budget for response headers and for each
 *   body chunk wait. Not a total download deadline: a 30 MB release download
 *   may legitimately take longer, but a stalled socket is aborted.
 * @param {number} [options.maxBytes]
 * @param {Iterable<string>} [options.allowedHosts] Test-only.
 * @param {boolean} [options.allowHttp] Test-only (local fake upstreams).
 * @returns {void}
 */
export function registerProxyRoutes(app, options = {}) {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Number(options.timeoutMs)
    : PROXY_TIMEOUT_MS;
  const maxBytes = Number.isFinite(options.maxBytes)
    ? Number(options.maxBytes)
    : PROXY_MAX_BYTES;
  const policy = {
    allowedHosts: options.allowedHosts,
    allowHttp: options.allowHttp === true,
  };

  app.get('/api/proxy', async (request, reply) => {
    try {
      const raw = /** @type {{ url?: unknown }} */ (request.query ?? {}).url;
      const target = validateProxyUrl(raw, policy);

      /** @type {Record<string, string>} */
      const headers = {
        // GitHub rejects requests without a User-Agent. Use our own rather
        // than forwarding the browser's, which is not relevant upstream.
        'user-agent': 'my-obsidian-proxy/0.1',
      };
      const accept = request.headers.accept;
      if (typeof accept === 'string' && accept !== '') headers.accept = accept;
      // Deliberately not forwarded: cookie, authorization, proxy-authorization.

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('proxy timeout'));
      }, timeoutMs);
      timer.unref?.();

      // If the browser goes away, stop pulling from upstream. 'close' also
      // fires after a normal finish; aborting then is harmless.
      reply.raw.once('close', () => controller.abort());

      let upstream;
      try {
        ({ response: upstream } = await followRedirects(target, {
          fetchImpl,
          signal: controller.signal,
          headers,
          policy,
        }));
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof ProxyError) throw err;
        if (timedOut) {
          throw new ProxyError(
            504,
            'ETIMEDOUT',
            `upstream did not respond within ${timeoutMs} ms`,
          );
        }
        throw new ProxyError(
          502,
          'EBADGATEWAY',
          `upstream request failed: ${/** @type {Error} */ (err).message ?? String(err)}`,
        );
      } finally {
        clearTimeout(timer);
      }

      // Announce before streaming so the shim can tell a proxy-generated 404
      // (route missing) from an upstream 404 passed through untouched.
      reply.header('X-MyOBS-Proxy', '1');
      reply.header('Cache-Control', 'no-store');

      for (const [name, value] of upstream.headers.entries()) {
        if (FORWARDED_RESPONSE_HEADERS.has(name.toLowerCase())) {
          reply.header(name, value);
        }
      }
      reply.code(upstream.status);
      if (!reply.hasHeader('content-type')) {
        reply.type('application/octet-stream');
      }

      if (upstream.status === 204 || upstream.status === 304 || upstream.body === null) {
        return reply.send();
      }

      const declared = upstream.headers.get('content-length');
      if (declared !== null) {
        const declaredBytes = Number(declared);
        if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
          await upstream.body.cancel().catch(() => {});
          throw new ProxyError(
            502,
            'ETOOBIG',
            `upstream response declares ${declaredBytes} bytes; limit is ${maxBytes}`,
          );
        }
      }

      const iterator = upstream.body[Symbol.asyncIterator]();
      let bodyTimedOut = false;

      /**
       * Read one chunk with an idle timeout. The 10 s budget is per read, not
       * for the whole body: a 30 MB release download may legitimately take
       * longer than 10 s, but a stalled socket must not hang the request
       * forever.
       *
       * @returns {Promise<IteratorResult<Uint8Array>>}
       */
      const readNext = async () => {
        const bodyTimer = setTimeout(() => {
          bodyTimedOut = true;
          controller.abort(new Error('proxy body timeout'));
        }, timeoutMs);
        bodyTimer.unref?.();
        try {
          return await iterator.next();
        } finally {
          clearTimeout(bodyTimer);
        }
      };

      let first;
      try {
        first = await readNext();
      } catch (err) {
        if (bodyTimedOut) {
          throw new ProxyError(
            504,
            'ETIMEDOUT',
            `upstream body stalled for ${timeoutMs} ms`,
          );
        }
        throw new ProxyError(
          502,
          'EBADGATEWAY',
          `upstream body failed: ${/** @type {Error} */ (err).message ?? String(err)}`,
        );
      }

      if (first.done) return reply.send();

      if (first.value.length > maxBytes) {
        await iterator.return?.().catch(() => {});
        throw new ProxyError(
          502,
          'ETOOBIG',
          `upstream response exceeded ${maxBytes} bytes`,
        );
      }

      let sent = first.value.length;
      const body = Readable.from(
        (async function* streamBody() {
          try {
            yield first.value;
            for (;;) {
              let next;
              try {
                next = await readNext();
              } catch (err) {
                if (bodyTimedOut) {
                  throw new ProxyError(
                    504,
                    'ETIMEDOUT',
                    `upstream body stalled for ${timeoutMs} ms`,
                  );
                }
                throw err;
              }
              if (next.done) return;
              sent += next.value.length;
              if (sent > maxBytes) {
                throw new ProxyError(
                  502,
                  'ETOOBIG',
                  `upstream response exceeded ${maxBytes} bytes`,
                );
              }
              yield next.value;
            }
          } finally {
            await iterator.return?.().catch(() => {});
          }
        })(),
      );

      body.once('error', () => {
        // Once headers are out, the only honest signal is a broken connection.
        reply.raw.destroy();
      });

      return reply.send(body);
    } catch (err) {
      return sendProxyError(reply, err);
    }
  });
}
