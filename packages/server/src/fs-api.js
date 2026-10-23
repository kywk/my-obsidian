/**
 * POST /api/fs implementation.
 *
 * All operations return the CONTRACTS.md envelope. Every failure is converted
 * here, so no exception reaches Fastify's default error handler (which would
 * render a 500 HTML page).
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  relativeFromVault,
  resolveVaultPath,
  toErrorResponse,
  vaultError,
} from './paths.js';
import { saveConflictCopy } from './conflict.js';
import { recordOriginToken, captureOriginVersion, readOriginVersion, hashOriginContent, runOriginMutation } from './watch.js';

/**
 * @typedef {import('./paths.js').Vault} Vault
 * @typedef {import('./paths.js').ResolvedPath} ResolvedPath
 * @typedef {{ [key: string]: unknown }} Args
 */

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isMissing(err) {
  const code = /** @type {NodeJS.ErrnoException} */ (err)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * @param {string} absPath
 * @returns {Promise<fs.Stats | null>}
 */
async function statIfExists(absPath) {
  try {
    return await fs.promises.stat(absPath);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/**
 * mtime values round-trip through JSON; allow sub-millisecond float noise.
 *
 * @param {number} diskValue
 * @param {number} requested
 * @returns {boolean}
 */
function sameMtime(diskValue, requested) {
  // JSON round-trips and Obsidian's Date.getTime() truncate sub-millisecond
  // nanoseconds, so exact equality would create false conflicts on APFS.
  return Math.abs(diskValue - requested) < 1.001;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function requireFiniteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw vaultError('EINVAL', `${name} must be a finite number`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function requireString(value, name) {
  if (typeof value !== 'string') {
    throw vaultError('EINVAL', `${name} must be a string`);
  }
  return value;
}

/**
 * Save a conflict copy when a conditional write lost the race.
 *
 * @param {ResolvedPath} resolved
 * @param {Args} args
 * @returns {Promise<string | undefined>}
 */
async function maybeSaveConflict(resolved, args) {
  if (args.ifMtimeMs === undefined || args.ifMtimeMs === null) return undefined;
  const expected = requireFiniteNumber(args.ifMtimeMs, 'ifMtimeMs');

  const st = await statIfExists(resolved.abs);
  // A missing target is not a conflict: there is nothing to preserve.
  if (st === null || !st.isFile()) return undefined;
  if (sameMtime(st.mtimeMs, expected)) return undefined;

  const { savedAs } = await saveConflictCopy(resolved.abs, resolved.rel);
  return savedAs;
}

/**
 * @param {Vault} vault
 * @param {ResolvedPath} resolved
 * @param {string | undefined} token
 * @param {string | undefined} expectedDigest
 * @param {boolean} missing
 * @param {boolean} followTarget
 */
async function rememberToken(vault, resolved, token, expectedDigest, missing = false, followTarget = false) {
  const version = missing ? { kind: 'missing' } : await captureOriginVersion(resolved.real, expectedDigest);
  recordOriginToken(resolved.rel, token, version);
  if (followTarget && resolved.real !== resolved.abs) {
    recordOriginToken(relativeFromVault(vault, resolved.real), token, version);
  }
}

/**
 * @param {Vault} vault
 * @param {ResolvedPath} resolved
 * @param {string | undefined} conflictSavedAs
 * @param {string | undefined} token
 * @param {string | undefined} expectedDigest
 * @returns {Promise<{ mtimeMs: number, size: number, conflictSavedAs?: string }>}
 */
async function writeResult(vault, resolved, conflictSavedAs, token, expectedDigest) {
  await rememberToken(vault, resolved, token, expectedDigest, false, true);
  // mtime must be the value the kernel actually assigned, so stat after write.
  const st = await fs.promises.stat(resolved.abs);
  /** @type {{ mtimeMs: number, size: number, conflictSavedAs?: string }} */
  const result = { mtimeMs: st.mtimeMs, size: st.size };
  if (conflictSavedAs !== undefined) result.conflictSavedAs = conflictSavedAs;
  return result;
}

/**
 * @param {Vault} vault
 * @param {unknown} relativePath
 * @param {Args} args
 * @param {'text' | 'binary'} kind
 * @param {boolean} append
 * @returns {Promise<{ mtimeMs: number, size: number, conflictSavedAs?: string }>}
 */
async function writeFileOp(vault, relativePath, args, kind, append) {
  const resolved = await resolveVaultPath(vault, relativePath);
  const token = typeof args.token === 'string' ? args.token : undefined;

  // Validate the payload before touching the disk: otherwise a malformed
  // request could leave a conflict copy behind without writing anything.
  /** @type {string | Buffer} */
  let data;
  if (kind === 'text') {
    data = requireString(args.data, 'data');
  } else {
    data = Buffer.from(requireString(args.base64, 'base64'), 'base64');
  }

  const conflictSavedAs = await maybeSaveConflict(resolved, args);
  let expectedDigest = hashOriginContent(data);
  if (append) {
    const before = await readOriginVersion(vault, resolved.real, data);
    if (before?.kind !== 'missing') expectedDigest = before?.digest;
  }

  if (append) {
    if (kind === 'text') {
      await fs.promises.appendFile(resolved.abs, /** @type {string} */ (data), 'utf8');
    } else {
      await fs.promises.appendFile(resolved.abs, /** @type {Buffer} */ (data));
    }
  } else if (kind === 'text') {
    await fs.promises.writeFile(resolved.abs, /** @type {string} */ (data), 'utf8');
  } else {
    await fs.promises.writeFile(resolved.abs, /** @type {Buffer} */ (data));
  }

  return writeResult(vault, resolved, conflictSavedAs, token, expectedDigest);
}

/**
 * @param {Vault} vault
 * @param {unknown} relativePath
 * @returns {Promise<{ files: string[], folders: string[] }>}
 */
async function listDirectory(vault, relativePath) {
  const resolved = await resolveVaultPath(vault, relativePath);
  const entries = await fs.promises.readdir(resolved.abs, { withFileTypes: true });

  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const folders = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      folders.push(entry.name);
      continue;
    }
    if (entry.isFile()) {
      files.push(entry.name);
      continue;
    }
    if (entry.isSymbolicLink()) {
      // Directory symlinks are deliberately not followed and not reported as
      // folders. File symlinks remain usable, but only when their target is
      // still inside the vault.
      try {
        const child = await resolveVaultPath(
          vault,
          resolved.rel === '' ? entry.name : `${resolved.rel}/${entry.name}`,
        );
        const st = await fs.promises.stat(child.abs);
        if (!st.isDirectory()) files.push(entry.name);
      } catch (err) {
        const code = /** @type {NodeJS.ErrnoException} */ (err).code;
        if (code !== 'EPERM' && code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      }
      continue;
    }

    // Sockets/FIFOs and other exotic entries are surfaced as files if stat
    // says they are not directories; Obsidian will ignore what it cannot read.
    try {
      const st = await fs.promises.lstat(path.join(resolved.abs, entry.name));
      if (st.isDirectory()) folders.push(entry.name);
      else files.push(entry.name);
    } catch {
      // Entry disappeared between readdir and lstat; skip it.
    }
  }

  files.sort();
  folders.sort();
  return { files, folders };
}

/**
 * @param {Vault} vault
 * @param {unknown} relativePath
 * @param {Args} args
 * @returns {Promise<null>}
 */
async function rmdirOp(vault, relativePath, args) {
  const resolved = await resolveVaultPath(vault, relativePath);
  if (resolved.rel === '') {
    throw vaultError('EPERM', 'refusing to remove the vault root');
  }
  if (args.recursive === true) {
    await fs.promises.rm(resolved.abs, { recursive: true, force: false });
  } else {
    await fs.promises.rmdir(resolved.abs);
  }
  await rememberToken(vault, resolved, typeof args.token === 'string' ? args.token : undefined, undefined, true);
  return null;
}

/**
 * @param {Vault} vault
 * @param {unknown} relativePath
 * @param {Args} args
 * @returns {Promise<null>}
 */
async function removeOp(vault, relativePath, args) {
  const resolved = await resolveVaultPath(vault, relativePath);
  if (resolved.rel === '') {
    throw vaultError('EPERM', 'refusing to remove the vault root');
  }
  const st = await fs.promises.lstat(resolved.abs);
  if (st.isDirectory() && !st.isSymbolicLink()) {
    throw vaultError('EISDIR', `is a directory: ${resolved.rel}`);
  }
  await fs.promises.unlink(resolved.abs);
  await rememberToken(vault, resolved, typeof args.token === 'string' ? args.token : undefined, undefined, true);
  return null;
}

/**
 * @param {Vault} vault
 * @param {unknown} from
 * @param {Args} args
 * @returns {Promise<null>}
 */
async function renameOp(vault, from, args) {
  const source = await resolveVaultPath(vault, from);
  const to = requireString(args.to, 'to');
  const destination = await resolveVaultPath(vault, to);

  if (source.rel === '' || destination.rel === '') {
    throw vaultError('EPERM', 'refusing to rename the vault root');
  }

  const before = await readOriginVersion(vault, source.real);
  await fs.promises.rename(source.abs, destination.abs);
  const token = typeof args.token === 'string' ? args.token : undefined;
  await rememberToken(vault, source, token, undefined, true);
  // rename replaces a destination symlink rather than writing through it.
  const committedDestination = await resolveVaultPath(vault, to);
  await rememberToken(vault, committedDestination, token, before?.digest);
  return null;
}

/**
 * @param {Vault} vault
 * @param {unknown} from
 * @param {Args} args
 * @returns {Promise<null>}
 */
async function copyOp(vault, from, args) {
  const source = await resolveVaultPath(vault, from);
  const to = requireString(args.to, 'to');
  const destination = await resolveVaultPath(vault, to);

  if (source.rel === '' || destination.rel === '') {
    throw vaultError('EPERM', 'refusing to copy the vault root');
  }
  if (
    destination.rel === source.rel ||
    destination.rel.startsWith(`${source.rel}/`)
  ) {
    throw vaultError('EPERM', 'cannot copy a path into itself');
  }

  const st = await fs.promises.lstat(source.abs);
  const before = await readOriginVersion(vault, source.real);
  if (st.isDirectory() && !st.isSymbolicLink()) {
    // The lexical check above misses aliases; compare the resolved roots too.
    const relativeReal = path.relative(source.real, destination.real);
    if (
      relativeReal === '' ||
      (!relativeReal.startsWith(`..${path.sep}`) && relativeReal !== '..' && !path.isAbsolute(relativeReal))
    ) {
      throw vaultError('EPERM', 'cannot copy a directory into itself');
    }
    await fs.promises.cp(source.abs, destination.abs, {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: false,
    });
  } else {
    await fs.promises.copyFile(source.abs, destination.abs);
  }

  await rememberToken(vault, destination, typeof args.token === 'string' ? args.token : undefined, before?.digest, false, true);
  return null;
}

/**
 * @param {Vault} vault
 * @param {unknown} relativePath
 * @param {Args} args
 * @returns {Promise<null>}
 */
async function utimesOp(vault, relativePath, args) {
  const resolved = await resolveVaultPath(vault, relativePath);
  const mtimeMs = requireFiniteNumber(args.mtimeMs, 'mtimeMs');
  // ctime is inode-change time and cannot be set from userspace. If the shim
  // sends ctimeMs we accept the field but deliberately do not fake it.
  const seconds = mtimeMs / 1000;
  const before = await readOriginVersion(vault, resolved.real);
  await fs.promises.utimes(resolved.abs, seconds, seconds);
  await rememberToken(vault, resolved, typeof args.token === 'string' ? args.token : undefined, before?.digest, false, true);
  return null;
}

/**
 * @param {Vault} vault
 * @param {unknown} relativePath
 * @returns {Promise<{ type: 'file' | 'folder', mtimeMs: number, ctimeMs: number, size: number, realpath: string } | null>}
 */
async function statOp(vault, relativePath) {
  const resolved = await resolveVaultPath(vault, relativePath);

  let lst;
  try {
    lst = await fs.promises.lstat(resolved.abs);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }

  let st = lst;
  let realpath = resolved.real;
  if (lst.isSymbolicLink()) {
    try {
      st = await fs.promises.stat(resolved.abs);
      realpath = await fs.promises.realpath(resolved.abs);
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  return {
    type: st.isDirectory() ? 'folder' : 'file',
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    size: st.size,
    // Absolute, symlink-resolved. The separate `realpath` op returns a
    // vault-relative path per the contract. See report for the rationale.
    realpath,
  };
}

/**
 * Execute one fs operation.
 *
 * @param {Vault} vault
 * @param {string} op
 * @param {unknown} relativePath
 * @param {Args} args
 * @returns {Promise<unknown>}
 */
async function execute(vault, op, relativePath, args) {
  switch (op) {
    case 'read': {
      const { abs } = await resolveVaultPath(vault, relativePath);
      return fs.promises.readFile(abs, 'utf8');
    }

    case 'readBinary': {
      const { abs } = await resolveVaultPath(vault, relativePath);
      const data = await fs.promises.readFile(abs);
      return { base64: data.toString('base64') };
    }

    case 'write':
      return writeFileOp(vault, relativePath, args, 'text', false);

    case 'writeBinary':
      return writeFileOp(vault, relativePath, args, 'binary', false);

    case 'append':
      return writeFileOp(vault, relativePath, args, 'text', true);

    case 'appendBinary':
      return writeFileOp(vault, relativePath, args, 'binary', true);

    case 'exists': {
      const { abs } = await resolveVaultPath(vault, relativePath);
      try {
        await fs.promises.access(abs);
        return true;
      } catch (err) {
        if (isMissing(err)) return false;
        throw err;
      }
    }

    case 'stat':
      return statOp(vault, relativePath);

    case 'list':
      return listDirectory(vault, relativePath);

    case 'mkdir': {
      const resolved = await resolveVaultPath(vault, relativePath);
      await fs.promises.mkdir(resolved.abs, { recursive: true });
      await rememberToken(vault, resolved, typeof args.token === 'string' ? args.token : undefined);
      return null;
    }

    case 'rmdir':
      return rmdirOp(vault, relativePath, args);

    case 'remove':
      return removeOp(vault, relativePath, args);

    case 'rename':
      return renameOp(vault, relativePath, args);

    case 'copy':
      return copyOp(vault, relativePath, args);

    case 'utimes':
      return utimesOp(vault, relativePath, args);

    case 'access': {
      const { abs } = await resolveVaultPath(vault, relativePath);
      await fs.promises.access(abs);
      return null;
    }

    case 'realpath': {
      const { abs } = await resolveVaultPath(vault, relativePath);
      const real = await fs.promises.realpath(abs);
      return relativeFromVault(vault, real);
    }

    default:
      throw vaultError('EUNKNOWN', `unsupported op: ${op}`);
  }
}

/**
 * Handle one POST /api/fs body.
 *
 * @param {Vault} vault
 * @param {unknown} body
 * @returns {Promise<{ ok: true, result: unknown } | { ok: false, error: { code: string, message: string } }>}
 */
export async function handleFsRequest(vault, body) {
  try {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw vaultError('EINVAL', 'request body must be an object');
    }
    const { op } = /** @type {{ op?: unknown }} */ (body);
    if (typeof op !== 'string' || op === '') {
      throw vaultError('EINVAL', 'op must be a non-empty string');
    }

    const rawArgs = /** @type {{ args?: unknown }} */ (body).args;
    if (rawArgs !== undefined && (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
      throw vaultError('EINVAL', 'args must be an object');
    }
    const args = /** @type {Args} */ (rawArgs ?? {});
    const relativePath = /** @type {{ path?: unknown }} */ (body).path;
    const resolvedPath =
      relativePath === undefined || relativePath === null ? '' : relativePath;

    const mutations = new Set(['write', 'writeBinary', 'append', 'appendBinary', 'mkdir', 'rmdir', 'remove', 'rename', 'copy', 'utimes']);
    let result;
    if (mutations.has(op)) {
      const source = await resolveVaultPath(vault, resolvedPath);
      const paths = [source.abs, source.real];
      if (op === 'rename' || op === 'copy') {
        const destination = await resolveVaultPath(vault, requireString(args.to, 'to'));
        paths.push(destination.abs, destination.real);
      }
      result = await runOriginMutation(paths, () => execute(vault, op, resolvedPath, args));
    } else {
      result = await execute(vault, op, resolvedPath, args);
    }
    return { ok: true, result };
  } catch (err) {
    return toErrorResponse(err);
  }
}
