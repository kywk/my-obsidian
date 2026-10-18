/**
 * Conflict copies for conditional writes.
 *
 * Contract: `<name>.conflict-<epochms>.<ext>`. The timestamp doubles as the
 * collision breaker: if that exact copy already exists we advance by 1 ms,
 * which keeps the documented shape instead of inventing a new suffix.
 */

import fs from 'node:fs';
import path from 'node:path';
import { vaultError } from './paths.js';

/**
 * @param {string} fileName Base name only (no directory part).
 * @param {number} epochMs
 * @returns {string}
 */
export function conflictFileName(fileName, epochMs) {
  const ext = path.extname(fileName);
  const stem = ext === '' ? fileName : fileName.slice(0, -ext.length);
  return `${stem}.conflict-${epochMs}${ext}`;
}

/**
 * Copy the on-disk version of `absPath` next to itself.
 *
 * @param {string} absPath Absolute path of the file about to be overwritten.
 * @param {string} relPath Vault-relative posix path of the same file.
 * @param {{ now?: number }} [options]
 * @returns {Promise<{ savedAs: string, absPath: string }>}
 */
export async function saveConflictCopy(absPath, relPath, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();

  let st;
  try {
    st = await fs.promises.stat(absPath);
  } catch (err) {
    throw err;
  }
  if (!st.isFile()) {
    throw vaultError('EISDIR', `cannot save a conflict copy of a non-file: ${relPath}`);
  }

  const dir = path.dirname(absPath);
  const baseName = path.basename(absPath);
  const relDir = path.posix.dirname(relPath);

  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const name = conflictFileName(baseName, Math.floor(now) + attempt);
    const destination = path.join(dir, name);
    try {
      // COPYFILE_EXCL guarantees we never clobber an existing conflict copy.
      await fs.promises.copyFile(absPath, destination, fs.constants.COPYFILE_EXCL);
      const savedAs =
        relDir === '.' || relDir === '' ? name : path.posix.join(relDir, name);
      return { savedAs, absPath: destination };
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'EEXIST') continue;
      throw err;
    }
  }

  throw vaultError('ECONFLICT', `could not allocate a conflict copy for: ${relPath}`);
}
