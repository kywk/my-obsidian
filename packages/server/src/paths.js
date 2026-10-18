/**
 * Path containment for the vault.
 *
 * Every filesystem operation in this package goes through one of the resolvers
 * below. They guarantee that the *lexical* path and the *symlink-resolved*
 * path both stay inside the vault root. A path that escapes throws a
 * {@link VaultError} with code `EPERM`.
 *
 * @typedef {object} Vault
 * @property {string} root      Canonical vault root (realpath, no trailing slash).
 * @property {string} rootReal  Same value, kept for readability at call sites.
 *
 * @typedef {object} ResolvedPath
 * @property {string} rel   Normalized vault-relative posix path ('' = root).
 * @property {string} abs   Lexical absolute path used for fs calls.
 * @property {string} real  Symlink-resolved absolute path.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Filesystem errors intentionally surfaced to the client. */
export class VaultError extends Error {
  /**
   * @param {string} code Node errno string (EPERM, ENOENT, ...).
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'VaultError';
    this.code = code;
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @param {unknown} [cause]
 * @returns {VaultError}
 */
export function vaultError(code, message, cause) {
  return new VaultError(code, message, cause === undefined ? {} : { cause });
}

/**
 * Open a vault directory and canonicalize its root.
 *
 * @param {string} vaultPath
 * @returns {Promise<Vault>}
 */
export async function openVault(vaultPath) {
  if (typeof vaultPath !== 'string' || vaultPath.trim() === '') {
    throw vaultError('ENOENT', 'VAULT_PATH is not set');
  }

  const requested = path.resolve(vaultPath);
  let root;
  try {
    root = await fs.promises.realpath(requested);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code ?? 'ENOENT';
    throw vaultError(code, `vault root cannot be resolved: ${requested}`, err);
  }

  const st = await fs.promises.stat(root);
  if (!st.isDirectory()) {
    throw vaultError('ENOTDIR', `vault root is not a directory: ${root}`);
  }

  return { root, rootReal: root };
}

/**
 * Validate and normalize a vault-relative posix path.
 *
 * Contract: `path` is relative to the vault root; the empty string means root.
 * Absolute paths are rejected even when they happen to point inside the vault,
 * because callers must not guess the server's mount point.
 *
 * @param {unknown} relativePath
 * @returns {string}
 */
export function normalizeVaultPath(relativePath) {
  if (relativePath === undefined || relativePath === null) return '';
  if (typeof relativePath !== 'string') {
    throw vaultError('EPERM', 'path must be a string');
  }
  if (relativePath.includes('\0')) {
    throw vaultError('EPERM', 'path contains a NUL byte');
  }
  if (relativePath === '') return '';
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw vaultError('EPERM', `absolute paths are not allowed: ${relativePath}`);
  }
  // On Windows a backslash is a separator; allowing it would let "..\\..\\x"
  // slip past the posix normalization below.
  if (path.sep === '\\' && relativePath.includes('\\')) {
    throw vaultError('EPERM', `backslashes are not allowed on this platform: ${relativePath}`);
  }

  const normalized = path.posix.normalize(relativePath);
  if (normalized === '.') return '';
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    throw vaultError('EPERM', `path escapes the vault: ${relativePath}`);
  }
  return normalized;
}

/**
 * @param {string} root
 * @param {string} candidate
 * @returns {boolean}
 */
export function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Resolve symlinks one component at a time. Unlike fs.realpath() this also
 * resolves *broken* symlinks, which matters because writing through a broken
 * link that points outside the vault would create a file outside the vault.
 *
 * @param {string} root Canonical vault root.
 * @param {string} absolute Lexically-contained absolute path.
 * @param {number} [depth]
 * @returns {Promise<string>}
 */
async function resolveReal(root, absolute, depth = 0) {
  if (!isInside(root, absolute)) {
    throw vaultError('EPERM', `path escapes the vault: ${absolute}`);
  }
  if (absolute === root) return root;
  if (depth > 40) {
    throw vaultError('EPERM', `too many symbolic links: ${absolute}`);
  }

  const rel = path.relative(root, absolute);
  const parts = rel.split(path.sep).filter(Boolean);
  let current = root;

  for (let i = 0; i < parts.length; i += 1) {
    const candidate = path.join(current, parts[i]);
    let st;
    try {
      st = await fs.promises.lstat(candidate);
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // Nothing below this point can be a symlink; append the remainder
        // lexically. The real fs operation will report ENOTDIR if applicable.
        return path.join(current, ...parts.slice(i));
      }
      throw err;
    }

    if (st.isSymbolicLink()) {
      const linkTarget = await fs.promises.readlink(candidate);
      const resolvedTarget = path.resolve(current, linkTarget);
      if (!isInside(root, resolvedTarget)) {
        throw vaultError('EPERM', `symlink escapes the vault: ${candidate} -> ${linkTarget}`);
      }
      current = await resolveReal(root, resolvedTarget, depth + 1);
    } else {
      current = candidate;
    }
  }

  return current;
}

/**
 * Resolve a vault-relative path.
 *
 * @param {Vault} vault
 * @param {unknown} relativePath
 * @returns {Promise<ResolvedPath>}
 */
export async function resolveVaultPath(vault, relativePath) {
  const rel = normalizeVaultPath(relativePath);
  const abs = rel === '' ? vault.root : path.join(vault.root, ...rel.split('/'));

  if (!isInside(vault.root, abs)) {
    throw vaultError('EPERM', `path escapes the vault: ${String(relativePath)}`);
  }

  const real = await resolveReal(vault.root, abs);
  return { rel, abs, real };
}

/**
 * Resolve the nearest existing ancestor and append the missing tail. Used to
 * decide whether an absolute path that is not lexically under the vault root
 * (for example /var vs /private/var on macOS) still lands inside it.
 *
 * @param {string} absolute
 * @returns {Promise<string | null>}
 */
async function projectRealpath(absolute) {
  let probe = absolute;
  /** @type {string[]} */
  const missing = [];

  while (true) {
    try {
      const real = await fs.promises.realpath(probe);
      return missing.length === 0 ? real : path.join(real, ...missing.slice().reverse());
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      missing.push(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * Resolve the absolute form used by `/v/*`. The contract passes an absolute
 * path with the leading slash removed; relative input is also accepted and
 * interpreted against the vault root.
 *
 * Both the canonical path and filesystem aliases (e.g. /var -> /private/var)
 * are accepted, but only when the resolved target is inside the vault.
 *
 * @param {Vault} vault
 * @param {string} inputPath
 * @returns {Promise<ResolvedPath>}
 */
export async function resolveVaultAbsolute(vault, inputPath) {
  if (typeof inputPath !== 'string' || inputPath.includes('\0')) {
    throw vaultError('EPERM', 'invalid path');
  }

  const abs = path.isAbsolute(inputPath)
    ? path.normalize(inputPath)
    : path.resolve(vault.root, inputPath);

  if (!isInside(vault.root, abs)) {
    // The URL may carry an alias of the vault root. Resolve it before giving
    // up, otherwise macOS's /var -> /private/var would 403 every attachment.
    const projected = await projectRealpath(abs);
    if (projected === null || !isInside(vault.root, projected)) {
      throw vaultError('EPERM', `path escapes the vault: ${inputPath}`);
    }
    const aliasRel = path.relative(vault.root, projected).split(path.sep).join('/');
    return resolveVaultPath(vault, aliasRel === '' ? '' : aliasRel);
  }

  const rel = path.relative(vault.root, abs).split(path.sep).join('/');
  return resolveVaultPath(vault, rel === '' ? '' : rel);
}

/**
 * Convert a platform path to posix form (used in API responses).
 *
 * @param {string} value
 * @returns {string}
 */
export function toPosix(value) {
  return value.split(path.sep).join('/');
}

/**
 * Convert an absolute real path back to a vault-relative posix path.
 *
 * @param {Vault} vault
 * @param {string} absolute
 * @returns {string}
 */
export function relativeFromVault(vault, absolute) {
  const rel = path.relative(vault.root, absolute);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw vaultError('EPERM', `path escapes the vault: ${absolute}`);
  }
  return rel.split(path.sep).join('/');
}

/**
 * Shape an exception into the REST error envelope. Never leaks a non-errno
 * code: unknown failures become EUNKNOWN.
 *
 * @param {unknown} err
 * @returns {{ ok: false, error: { code: string, message: string } }}
 */
export function toErrorResponse(err) {
  const anyErr = /** @type {{ code?: unknown, message?: unknown }} */ (err);
  const code = typeof anyErr?.code === 'string' && anyErr.code ? anyErr.code : 'EUNKNOWN';
  const message =
    typeof anyErr?.message === 'string' && anyErr.message
      ? anyErr.message
      : String(err ?? 'unknown error');
  return { ok: false, error: { code, message } };
}
