/**
 * Community-plugin installation (DESIGN.md §3 #11).
 *
 *   GET  /api/plugins            list installed plugins
 *   POST /api/plugins/install    { repo: "owner/name", version?: "<tag>" }
 *   POST /api/plugins/uninstall  { id }
 *
 * The server fetches releases from GitHub, verifies what it downloaded, and
 * writes a complete plugin directory in one rename. It never edits
 * `.obsidian/community-plugins.json`: enabling a plugin is the user's choice,
 * not an installation side effect.
 *
 * All filesystem access goes through paths.js so a crafted manifest id or repo
 * cannot escape `.obsidian/plugins/`.
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isInside, resolveVaultPath } from './paths.js';

/** GitHub's own rules for owner/repo names, per the task contract. */
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Obsidian sanitizes command ids with `[^_a-zA-Z0-9-]`, and every shipped
 * community plugin id is a single path component. Dots are allowed for
 * compatibility with existing manifests, but the first character must be
 * alphanumeric so "." and ".." can never be interpreted as traversal.
 */
const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Release tags are used as a URL path segment; keep them boring. */
const VERSION_RE = /^[A-Za-z0-9._+-]{1,100}$/;

const MAX_JSON_BODY = 64 * 1024;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

const ASSET_NAMES = ['manifest.json', 'main.js'];

export class PluginError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'PluginError';
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {import('fastify').FastifyReply} reply
 * @param {unknown} err
 * @returns {import('fastify').FastifyReply}
 */
function sendPluginError(reply, err) {
  const known = err instanceof PluginError;
  const status = known ? err.status : 500;
  const code = known ? err.code : 'EUNKNOWN';
  const message = err instanceof Error ? err.message : String(err);
  return reply
    .code(status)
    .type('application/json; charset=utf-8')
    .send({ ok: false, error: { code, message } });
}

/**
 * Map a filesystem error to the same envelope the explicit checks use.
 *
 * @param {unknown} err
 * @returns {PluginError}
 */
function pluginFsError(err) {
  if (err instanceof PluginError) return err;
  const code = /** @type {NodeJS.ErrnoException} */ (err).code ?? 'EUNKNOWN';
  const status =
    code === 'EPERM' || code === 'EACCES'
      ? 403
      : code === 'ENOENT'
        ? 404
        : code === 'ENOTDIR' || code === 'EEXIST'
          ? 409
          : 500;
  return new PluginError(
    status,
    code,
    /** @type {Error} */ (err).message ?? String(err),
  );
}

/**
 * Accept both Fastify's parsed JSON object and a raw buffer/string. The app
 * registers a catch-all content-type parser for PUT /v/*, so a POST without
 * `Content-Type: application/json` (curl -d does exactly that) arrives as a
 * Buffer even though it is JSON.
 *
 * @param {import('fastify').FastifyRequest} request
 * @returns {Record<string, unknown>}
 */
function readJsonBody(request) {
  const raw = request.body;

  if (raw === undefined || raw === null) return {};

  if (Buffer.isBuffer(raw) || typeof raw === 'string') {
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
    if (buffer.length === 0) return {};
    if (buffer.length > MAX_JSON_BODY) {
      throw new PluginError(413, 'E2BIG', `request body exceeds ${MAX_JSON_BODY} bytes`);
    }
    let parsed;
    try {
      parsed = JSON.parse(buffer.toString('utf8'));
    } catch {
      throw new PluginError(400, 'EINVAL', 'request body is not valid JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new PluginError(400, 'EINVAL', 'request body must be a JSON object');
    }
    return /** @type {Record<string, unknown>} */ (parsed);
  }

  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return /** @type {Record<string, unknown>} */ (raw);
  }

  throw new PluginError(400, 'EINVAL', 'request body must be a JSON object');
}

/**
 * @param {unknown} repo
 * @returns {{ owner: string, name: string }}
 */
function parseRepo(repo) {
  if (typeof repo !== 'string' || repo === '') {
    throw new PluginError(400, 'EINVAL', 'repo is required');
  }
  if (repo.length > 200) {
    throw new PluginError(400, 'EINVAL', 'repo is too long');
  }
  if (!REPO_RE.test(repo)) {
    throw new PluginError(
      400,
      'EINVAL',
      'repo must look like "owner/name" using letters, digits, dot, underscore or hyphen',
    );
  }
  const [owner, name] = repo.split('/');
  if (owner === '.' || owner === '..' || name === '.' || name === '..') {
    throw new PluginError(400, 'EINVAL', 'repo owner and name must not be "." or ".."');
  }
  if (owner.length > 100 || name.length > 100) {
    throw new PluginError(400, 'EINVAL', 'repo owner or name is too long');
  }
  return { owner, name };
}

/**
 * @param {unknown} id
 * @returns {string}
 */
export function validatePluginId(id) {
  if (typeof id !== 'string' || id === '') {
    throw new PluginError(400, 'EINVAL', 'id is required');
  }
  if (!PLUGIN_ID_RE.test(id)) {
    throw new PluginError(
      400,
      'EINVAL',
      'id must be a single path component starting with a letter or digit, containing only A-Z a-z 0-9 . _ -',
    );
  }
  return id;
}

/**
 * @param {unknown} version
 * @returns {string | null}
 */
function parseVersion(version) {
  if (version === undefined || version === null) return null;
  if (typeof version !== 'string' || version === '') {
    throw new PluginError(400, 'EINVAL', 'version must be a non-empty string');
  }
  if (!VERSION_RE.test(version)) {
    throw new PluginError(
      400,
      'EINVAL',
      'version must contain only letters, digits, dot, underscore, plus or hyphen',
    );
  }
  return version;
}

/**
 * @param {Buffer} buffer
 * @param {unknown} source
 * @returns {Record<string, unknown>}
 */
function parseManifest(buffer, source) {
  if (buffer.length === 0) {
    throw new PluginError(422, 'EINVALID', `${source} is empty`);
  }
  if (buffer.length > 1024 * 1024) {
    throw new PluginError(422, 'EINVALID', `${source} is larger than 1 MiB`);
  }
  let manifest;
  try {
    manifest = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new PluginError(422, 'EINVALID', `${source} is not valid JSON`);
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new PluginError(422, 'EINVALID', `${source} must contain a JSON object`);
  }
  if (typeof manifest.id !== 'string' || manifest.id === '') {
    throw new PluginError(422, 'EINVALID', `${source} is missing a string "id"`);
  }
  try {
    validatePluginId(manifest.id);
  } catch (err) {
    throw new PluginError(
      422,
      'EINVALID',
      `${source} has an unsafe id: ${/** @type {Error} */ (err).message}`,
    );
  }
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new PluginError(422, 'EINVALID', `${source} is missing a string "version"`);
  }
  return /** @type {Record<string, unknown>} */ (manifest);
}

/**
 * @param {unknown} asset
 * @param {Buffer} buffer
 * @param {string} name
 */
function verifyDigest(asset, buffer, name) {
  const digest = /** @type {{ digest?: unknown }} */ (asset)?.digest;
  if (digest === undefined || digest === null || digest === '') return;
  if (typeof digest !== 'string') {
    throw new PluginError(422, 'EINVALID', `${name}: digest is not a string`);
  }

  const colon = digest.indexOf(':');
  if (colon <= 0) {
    throw new PluginError(422, 'EINVALID', `${name}: malformed digest "${digest}"`);
  }
  const algorithm = digest.slice(0, colon).toLowerCase();
  const expected = digest.slice(colon + 1).toLowerCase();
  if (algorithm !== 'sha256' || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new PluginError(
      422,
      'EINVALID',
      `${name}: unsupported digest "${algorithm}" (only sha256 is supported)`,
    );
  }

  const actual = createHash('sha256').update(buffer).digest('hex');
  if (actual !== expected) {
    throw new PluginError(
      422,
      'EINVALID',
      `${name}: digest mismatch (expected ${expected}, got ${actual})`,
    );
  }
}

/**
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readCapped(response, maxBytes) {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const bytes = Number(declared);
    if (Number.isFinite(bytes) && bytes > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new PluginError(502, 'ETOOBIG', `asset declares ${bytes} bytes; limit is ${maxBytes}`);
    }
  }

  if (response.body === null) return Buffer.alloc(0);

  /** @type {Buffer[]} */
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      await response.body.cancel().catch(() => {});
      throw new PluginError(502, 'ETOOBIG', `asset exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * @param {object} options
 * @param {(input: string, init: object) => Promise<Response>} options.fetchImpl
 * @param {string} options.apiBase
 * @param {string} [options.token]
 * @param {(url: string) => void} options.assertDownloadUrl
 * @param {{ owner: string, name: string }} options.repo
 * @param {string | null} options.version
 * @returns {Promise<Record<string, unknown>>}
 */
async function fetchRelease(options) {
  const { owner, name } = options.repo;
  const suffix =
    options.version === null
      ? 'latest'
      : `tags/${encodeURIComponent(options.version)}`;
  const url = `${options.apiBase.replace(/\/+$/, '')}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases/${suffix}`;

  /** @type {Record<string, string>} */
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'my-obsidian/0.1',
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  let response;
  try {
    response = await options.fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new PluginError(
      502,
      'EBADGATEWAY',
      `GitHub API request failed: ${/** @type {Error} */ (err).message ?? String(err)}`,
    );
  }

  if (response.status === 404) {
    throw new PluginError(
      404,
      'ENOENT',
      `release not found for ${owner}/${name}${options.version ? `@${options.version}` : ''}`,
    );
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const message = detail.slice(0, 300).replace(/\s+/g, ' ').trim();
    throw new PluginError(
      502,
      'EBADGATEWAY',
      `GitHub API responded ${response.status}${message ? `: ${message}` : ''}`,
    );
  }

  let release;
  try {
    release = await response.json();
  } catch {
    throw new PluginError(502, 'EBADGATEWAY', 'GitHub API returned invalid JSON');
  }
  if (release === null || typeof release !== 'object' || !Array.isArray(release.assets)) {
    throw new PluginError(502, 'EBADGATEWAY', 'GitHub release has no assets array');
  }
  return /** @type {Record<string, unknown>} */ (release);
}

/**
 * @param {object} options
 * @param {(input: string, init: object) => Promise<Response>} options.fetchImpl
 * @param {Record<string, unknown>} options.release
 * @param {string} options.name
 * @param {(url: string) => void} options.assertDownloadUrl
 * @returns {Promise<{ buffer: Buffer, asset: Record<string, unknown> }>}
 */
async function downloadAsset(options) {
  const assets = /** @type {Record<string, unknown>[]} */ (options.release.assets);
  const asset = assets.find(
    (candidate) => /** @type {{ name?: unknown }} */ (candidate)?.name === options.name,
  );
  if (asset === undefined) {
    throw new PluginError(404, 'ENOENT', `release has no ${options.name} asset`);
  }

  const url = /** @type {{ browser_download_url?: unknown }} */ (asset)
    .browser_download_url;
  if (typeof url !== 'string' || url === '') {
    throw new PluginError(502, 'EBADGATEWAY', `${options.name} asset has no download URL`);
  }
  // Trusted-API output is still validated: a compromised or buggy upstream
  // response must not turn the installer into an arbitrary-URL fetcher.
  options.assertDownloadUrl(url);

  let response;
  try {
    response = await options.fetchImpl(url, {
      headers: {
        accept: 'application/octet-stream',
        'user-agent': 'my-obsidian/0.1',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // GitHub release assets redirect to objects.githubusercontent.com.
      redirect: 'follow',
    });
  } catch (err) {
    throw new PluginError(
      502,
      'EBADGATEWAY',
      `downloading ${options.name} failed: ${/** @type {Error} */ (err).message ?? String(err)}`,
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new PluginError(
      502,
      'EBADGATEWAY',
      `downloading ${options.name} failed with HTTP ${response.status}`,
    );
  }

  let buffer;
  try {
    buffer = await readCapped(response, MAX_ASSET_BYTES);
  } catch (err) {
    if (err instanceof PluginError) throw err;
    throw new PluginError(
      502,
      'EBADGATEWAY',
      `reading ${options.name} failed: ${/** @type {Error} */ (err).message ?? String(err)}`,
    );
  }
  verifyDigest(asset, buffer, options.name);
  return { buffer, asset };
}

/**
 * Replace a plugin directory with a fully written temp directory.
 *
 * `rename()` atomically publishes the new directory, but POSIX cannot rename
 * over a non-empty directory. When the plugin already exists it is first moved
 * aside, then the new directory is renamed into place, then the old one is
 * removed. If the second rename fails the old directory is restored, so a
 * failed update leaves the previous version intact. A crash between the two
 * renames leaves a hidden `.myobs-backup-*` directory; the plugin still has its
 * previous version in that case.
 *
 * @param {string} pluginsReal Absolute real path of `.obsidian/plugins`.
 * @param {string} id
 * @param {Record<string, Buffer>} files
 * @returns {Promise<void>}
 */
async function atomicInstall(pluginsReal, id, files) {
  const target = path.join(pluginsReal, id);
  if (!isInside(pluginsReal, target) || path.dirname(target) !== pluginsReal) {
    throw new PluginError(403, 'EPERM', `plugin path escapes the plugins directory: ${id}`);
  }

  const temp = path.join(pluginsReal, `.myobs-tmp-${randomUUID()}`);
  const backup = path.join(pluginsReal, `.myobs-backup-${randomUUID()}`);

  await fs.promises.mkdir(temp, { recursive: false, mode: 0o755 });
  try {
    for (const [name, buffer] of Object.entries(files)) {
      await fs.promises.writeFile(path.join(temp, name), buffer, { flag: 'wx' });
    }

    let movedAside = false;
    try {
      const targetStat = await fs.promises.lstat(target);
      // `data.json` is the user's plugin settings, not part of the release.
      // Replacing the directory (the only atomic swap POSIX offers for a
      // non-empty directory) would otherwise delete it on every update.
      if (targetStat.isDirectory()) {
        const dataFile = path.join(target, 'data.json');
        try {
          const dataStat = await fs.promises.lstat(dataFile);
          if (dataStat.isFile()) {
            await fs.promises.copyFile(
              dataFile,
              path.join(temp, 'data.json'),
              fs.constants.COPYFILE_EXCL,
            );
          }
        } catch (err) {
          if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err;
        }
      }
      await fs.promises.rename(target, backup);
      movedAside = true;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err;
    }

    try {
      await fs.promises.rename(temp, target);
    } catch (err) {
      if (movedAside) {
        await fs.promises.rename(backup, target).catch(() => {
          // Nothing better to do; the error below names the failed operation.
        });
      }
      throw err;
    }

    if (movedAside) {
      await fs.promises.rm(backup, { recursive: true, force: true }).catch(() => {
        // A leftover hidden backup is harmless and ignored by GET /api/plugins.
      });
    }
  } catch (err) {
    await fs.promises.rm(temp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {object} options
 * @param {import('./paths.js').Vault} options.vault
 * @param {string} [options.githubApiBase]
 * @param {string} [options.githubToken] Defaults to GITHUB_TOKEN.
 * @param {(input: string, init: object) => Promise<Response>} [options.fetchImpl]
 * @param {boolean} [options.allowInsecureDownload] Test-only: local stub servers.
 * @returns {void}
 */
export function registerPluginRoutes(app, options) {
  const { vault } = options;
  const apiBase =
    options.githubApiBase ??
    process.env.MYOBS_GITHUB_API ??
    'https://api.github.com';
  const token = options.githubToken ?? process.env.GITHUB_TOKEN ?? undefined;
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const allowInsecureDownload = options.allowInsecureDownload === true;

  /**
   * @param {string} url
   * @returns {void}
   */
  function assertDownloadUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new PluginError(502, 'EBADGATEWAY', `invalid asset URL: ${url}`);
    }

    if (allowInsecureDownload) return;

    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    const allowed = new Set([
      'github.com',
      'objects.githubusercontent.com',
      'github-releases.githubusercontent.com',
      'release-assets.githubusercontent.com',
      'codeload.github.com',
    ]);
    if (parsed.protocol !== 'https:' || !allowed.has(host)) {
      throw new PluginError(
        502,
        'EBADGATEWAY',
        `asset URL is outside the GitHub download hosts: ${parsed.protocol}//${host}`,
      );
    }
  }

  app.get('/api/plugins', async (_request, reply) => {
    try {
      /** @type {{ id: string, name: string, version: string, minAppVersion: string | null, isDesktopOnly: boolean, enabled: boolean, dir: string }[]} */
      const plugins = [];
      /** @type {{ dir: string, message: string }[]} */
      const errors = [];

      const enabled = new Set();
      try {
        const file = await resolveVaultPath(vault, '.obsidian/community-plugins.json');
        const parsed = JSON.parse(await fs.promises.readFile(file.real, 'utf8'));
        if (Array.isArray(parsed)) {
          for (const value of parsed) {
            if (typeof value === 'string') enabled.add(value);
          }
        }
      } catch {
        // Missing or malformed enabled-list means "nothing enabled"; it must
        // not make the plugin list unavailable.
      }

      let dirs = [];
      try {
        const pluginsDir = await resolveVaultPath(vault, '.obsidian/plugins');
        dirs = await fs.promises.readdir(pluginsDir.real, { withFileTypes: true });
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err;
      }

      for (const entry of dirs) {
        if (entry.name.startsWith('.')) continue; // temp/backup directories
        const dir = entry.isDirectory() || entry.isSymbolicLink() ? entry.name : null;
        if (dir === null) continue;

        try {
          const manifestPath = await resolveVaultPath(
            vault,
            `.obsidian/plugins/${dir}/manifest.json`,
          );
          const raw = await fs.promises.readFile(manifestPath.real, 'utf8');
          const manifest = JSON.parse(raw);
          if (
            manifest === null ||
            typeof manifest !== 'object' ||
            typeof manifest.id !== 'string' ||
            manifest.id === ''
          ) {
            throw new Error('manifest is missing a string "id"');
          }
          validatePluginId(manifest.id);
          if (typeof manifest.version !== 'string' || manifest.version === '') {
            throw new Error('manifest is missing a string "version"');
          }
          plugins.push({
            id: manifest.id,
            name: typeof manifest.name === 'string' ? manifest.name : manifest.id,
            version: manifest.version,
            minAppVersion:
              typeof manifest.minAppVersion === 'string'
                ? manifest.minAppVersion
                : null,
            isDesktopOnly: manifest.isDesktopOnly === true,
            enabled: enabled.has(manifest.id),
            dir,
          });
        } catch (err) {
          errors.push({
            dir,
            message: /** @type {Error} */ (err).message ?? String(err),
          });
        }
      }

      plugins.sort((a, b) => a.id.localeCompare(b.id));
      errors.sort((a, b) => a.dir.localeCompare(b.dir));
      return reply.send({ ok: true, plugins, errors });
    } catch (err) {
      return sendPluginError(reply, pluginFsError(err));
    }
  });

  app.post('/api/plugins/install', async (request, reply) => {
    try {
      const body = readJsonBody(request);
      const repo = parseRepo(body.repo);
      const version = parseVersion(body.version);

      const release = await fetchRelease({
        fetchImpl,
        apiBase,
        token,
        repo,
        version,
      });

      // manifest first: its id decides the destination directory, and nothing
      // is written until every downloaded file has passed validation.
      const manifestAsset = await downloadAsset({
        fetchImpl,
        release,
        name: 'manifest.json',
        assertDownloadUrl,
      });
      const manifest = parseManifest(manifestAsset.buffer, 'manifest.json');
      const id = validatePluginId(manifest.id);

      const mainAsset = await downloadAsset({
        fetchImpl,
        release,
        name: 'main.js',
        assertDownloadUrl,
      });
      if (mainAsset.buffer.length === 0) {
        throw new PluginError(422, 'EINVALID', 'main.js is empty');
      }

      /** @type {Record<string, Buffer>} */
      const files = {
        'manifest.json': manifestAsset.buffer,
        'main.js': mainAsset.buffer,
      };
      /** @type {string[]} */
      const written = ['manifest.json', 'main.js'];

      const hasStyles = /** @type {{ name?: unknown }[]} */ (release.assets).some(
        (asset) => asset?.name === 'styles.css',
      );
      if (hasStyles) {
        const styles = await downloadAsset({
          fetchImpl,
          release,
          name: 'styles.css',
          assertDownloadUrl,
        });
        files['styles.css'] = styles.buffer;
        written.push('styles.css');
      }

      const pluginsDir = await resolveVaultPath(vault, '.obsidian/plugins');
      await fs.promises.mkdir(pluginsDir.real, { recursive: true });
      const pluginsReal = await fs.promises.realpath(pluginsDir.real);
      if (!isInside(vault.root, pluginsReal)) {
        throw new PluginError(403, 'EPERM', 'plugins directory escapes the vault');
      }

      await atomicInstall(pluginsReal, id, files);

      return reply.send({
        ok: true,
        id,
        version: /** @type {string} */ (manifest.version),
        files: written,
      });
    } catch (err) {
      return sendPluginError(reply, pluginFsError(err));
    }
  });

  app.post('/api/plugins/uninstall', async (request, reply) => {
    try {
      const body = readJsonBody(request);
      const id = validatePluginId(body.id);

      const source = await resolveVaultPath(vault, `.obsidian/plugins/${id}`);
      let stat;
      try {
        stat = await fs.promises.lstat(source.abs);
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
          throw new PluginError(404, 'ENOENT', `plugin "${id}" is not installed`);
        }
        throw err;
      }
      if (!stat.isDirectory() && !stat.isSymbolicLink()) {
        throw new PluginError(409, 'ENOTDIR', `plugin "${id}" is not a directory`);
      }

      const trashDir = await resolveVaultPath(vault, '.trash/plugins');
      await fs.promises.mkdir(trashDir.real, { recursive: true });
      if (!isInside(vault.root, trashDir.real)) {
        throw new PluginError(403, 'EPERM', 'trash directory escapes the vault');
      }

      let destination = null;
      let trashedTo = null;
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        const name = attempt === 0 ? id : `${id}-${attempt}`;
        const candidate = path.join(trashDir.real, name);
        try {
          await fs.promises.lstat(candidate);
          continue; // never overwrite an earlier trash entry
        } catch (err) {
          if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err;
        }
        destination = candidate;
        trashedTo = `.trash/plugins/${name}`;
        break;
      }
      if (destination === null) {
        throw new PluginError(409, 'EEXIST', `too many trash copies of "${id}"`);
      }

      // Rename the directory entry itself, not the symlink target: dev setups
      // often symlink a plugin directory into the vault.
      await fs.promises.rename(source.abs, destination);
      return reply.send({ ok: true, id, trashedTo });
    } catch (err) {
      return sendPluginError(reply, pluginFsError(err));
    }
  });
}
