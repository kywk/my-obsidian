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
 * private network. Each hop's hostname is also resolved and refused when any
 * answer is private or reserved (DNS rebinding). That lookup is a mitigation,
 * not a guarantee: fetch resolves the name again, so this is TOCTOU-able.
 *
 * Responses are streamed, not buffered. A response over the byte cap is
 * rejected before the first byte whenever Content-Length announces it, and the
 * stream is aborted otherwise (headers may already have been sent at that
 * point; there is no way to turn a partially delivered 200 into a 502).
 */

import dns from 'node:dns/promises';
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
  // GitHub moved release-asset downloads here; without it, installing a plugin
  // through Obsidian's own Browse UI 403s after the redirect from github.com.
  'release-assets.githubusercontent.com',
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
 * Parse a dotted-quad IPv4 literal.
 *
 * @param {string} address
 * @returns {number[] | null} four octets, or null when this is not IPv4
 */
function ipv4Octets(address) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (match === null) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((value) => value >= 0 && value <= 255) ? octets : null;
}

/**
 * @param {string} host
 * @returns {boolean}
 */
function isPrivateIpv4(host) {
  const octets = ipv4Octets(host);
  if (octets === null) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 192 && b === 0 && c === 0) return true; // IETF assignments
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/**
 * Expand an IPv6 literal into eight 16-bit groups.
 *
 * Handles `::` compression, a trailing dotted-quad (`::ffff:127.0.0.1`) and a
 * zone identifier (`fe80::1%en0`). Returns null for anything that is not a
 * valid IPv6 literal.
 *
 * @param {string} address
 * @returns {number[] | null}
 */
function ipv6Groups(address) {
  let text = String(address).toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (!text.includes(':')) return null;

  const halves = text.split('::');
  if (halves.length > 2) return null;

  /** @param {string} part */
  const expand = (part) => {
    if (part === '') return [];
    const raw = part.split(':');
    const out = [];
    for (let i = 0; i < raw.length; i += 1) {
      const group = raw[i];
      if (group.includes('.')) {
        // A dotted quad is only legal as the final 32 bits.
        if (i !== raw.length - 1) return null;
        const octets = ipv4Octets(group);
        if (octets === null) return null;
        out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };

  const head = expand(halves[0]);
  const tail = halves.length === 2 ? expand(halves[1]) : [];
  if (head === null || tail === null) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;
  // `::` must stand for at least one zero group.
  if (head.length + tail.length > 7) return null;
  return head.concat(new Array(8 - head.length - tail.length).fill(0), tail);
}

/**
 * Private/reserved IPv6 ranges, including addresses that embed an IPv4 target.
 *
 * @param {string} address
 * @returns {boolean}
 */
function isPrivateIpv6(address) {
  const groups = ipv6Groups(address);
  if (groups === null) return false;

  // ::ffff:0:0/96 (IPv4-mapped) and ::/96 (unspecified, loopback, deprecated
  // IPv4-compatible) carry an IPv4 address in the last two groups.
  if (groups.slice(0, 5).every((value) => value === 0)) {
    if (groups[5] === 0xffff) {
      return isPrivateIpv4(
        `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`,
      );
    }
    if (groups[5] === 0) {
      if (groups[6] === 0 && groups[7] <= 1) return true; // :: and ::1
      return isPrivateIpv4(
        `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`,
      );
    }
  }

  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((groups[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true; // documentation
  if (groups[0] === 0x2001 && groups[1] === 0x0000) return true; // Teredo
  if (groups[0] === 0x2002) return true; // 6to4 (embeds an IPv4 target)
  if (groups[0] === 0x0100 && groups.slice(1, 4).every((value) => value === 0)) {
    return true; // 100::/64 discard-only
  }
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
  return isPrivateIpv6(host);
}

/**
 * The address check above only covers URL *literals*. A hostname on the
 * allowlist can still resolve to 127.0.0.1 (DNS rebinding), so every hop is
 * resolved and rejected when any answer is private or reserved.
 *
 * This is a mitigation, not a defence: `fetch` resolves the name again after
 * this check, so a resolver that answers differently on the second query wins
 * (TOCTOU). Pinning the checked address into the connection would require a
 * custom dispatcher; the proxy API has no such hook. Keep the check short-lived
 * (one lookup per hop, never cached) so a poisoned answer has to be served on
 * two consecutive queries.
 *
 * @param {URL} url
 * @param {object} policy
 * @param {boolean} [policy.allowHttp] Test-only: local fake upstreams.
 * @param {(hostname: string, options: object) => Promise<Array<{address: string, family: number}>>} [policy.lookupImpl]
 * @param {number} [policy.timeoutMs]
 * @returns {Promise<Array<{address: string, family: number}>>}
 * @throws {ProxyError}
 */
export async function assertPublicResolution(url, policy = {}) {
  // Tests point the proxy at a local HTTP server; that mode exists to make the
  // proxy mechanics testable and is never enabled by the production config.
  if (policy.allowHttp === true) return [];

  const host = normalizeHostname(url.hostname);
  const lookupImpl = policy.lookupImpl ?? ((name, options) => dns.lookup(name, options));
  const timeoutMs = Number.isFinite(policy.timeoutMs) ? Number(policy.timeoutMs) : PROXY_TIMEOUT_MS;

  let timer;
  const timeout = new Promise((_, reject) => {
    // Not unref'd on purpose: a resolver that never answers must still fire
    // this deadline even when nothing else is pending (and it keeps a test
    // harness that stubs a hanging resolver alive long enough to observe it).
    timer = setTimeout(() => {
      reject(new ProxyError(504, 'ETIMEDOUT', `DNS lookup for ${host} exceeded ${timeoutMs} ms`));
    }, timeoutMs);
  });

  let addresses;
  try {
    addresses = await Promise.race([
      lookupImpl(host, { all: true, verbatim: true }),
      timeout,
    ]);
  } catch (err) {
    if (err instanceof ProxyError) throw err;
    throw new ProxyError(
      502,
      'EBADGATEWAY',
      `DNS lookup failed for ${host}: ${/** @type {Error} */ (err)?.message ?? String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new ProxyError(502, 'EBADGATEWAY', `DNS lookup returned no addresses for ${host}`);
  }

  for (const entry of addresses) {
    const address = normalizeHostname(String(entry?.address ?? ''));
    if (isPrivateAddress(address)) {
      throw new ProxyError(
        403,
        'EPERM',
        `host "${host}" resolves to a private or reserved address (${address}); refusing a DNS-rebinding target`,
      );
    }
  }
  return addresses;
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
 * @param {object} context.policy See assertPublicResolution().
 * @returns {Promise<{ response: Response, url: URL }>}
 */
async function followRedirects(start, context) {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // Re-resolve on every hop: a trusted host may redirect to another trusted
    // host whose DNS answer points into the private network. No caching, so an
    // attacker cannot pin a "public" answer from an earlier request.
    await assertPublicResolution(current, context.policy);
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
 * @param {boolean} [options.allowHttp] Test-only (local fake upstreams). Also
 *   disables the DNS private-address check, because those fake upstreams
 *   deliberately listen on 127.0.0.1.
 * @param {(hostname: string, options: object) => Promise<Array<{address: string, family: number}>>} [options.lookupImpl]
 *   Test-only DNS seam; defaults to node:dns/promises.lookup.
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
    lookupImpl: options.lookupImpl,
    timeoutMs,
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
