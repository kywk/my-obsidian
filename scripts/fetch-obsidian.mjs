#!/usr/bin/env node
/**
 * Extract the official Obsidian desktop renderer bundle from obsidian.asar.
 *
 * Zero dependencies: the ASAR reader below is intentionally minimal and
 * self-contained so this works offline and in CI.
 *
 *   node scripts/fetch-obsidian.mjs
 *   node scripts/fetch-obsidian.mjs --from /path/to/obsidian.asar --out vendor/obsidian --force
 *
 * The output directory must resolve inside <repo>/vendor/.  The manifest is
 * written next to the output directory, e.g. vendor/obsidian.manifest.json.
 */

import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const VENDOR_ROOT = path.join(REPO_ROOT, 'vendor');

const DEFAULT_OUT = 'vendor/obsidian';

/**
 * Where an installed Obsidian keeps its renderer on macOS.
 *
 * Obsidian self-updates the renderer without touching the .app: a newer
 * obsidian-<version>.asar is dropped into Application Support and is what
 * actually runs. Reading only /Applications would extract a stale renderer on
 * any machine that has auto-updated, so every location is considered and the
 * highest version wins.
 */
function candidateAsars() {
  const home = os.homedir();
  const list = [
    path.join('/Applications/Obsidian.app/Contents/Resources/obsidian.asar'),
    path.join(home, 'Applications/Obsidian.app/Contents/Resources/obsidian.asar'),
  ];
  const support = path.join(home, 'Library/Application Support/obsidian');
  try {
    for (const name of fsSync.readdirSync(support)) {
      if (/^obsidian-\d+\.\d+\.\d+\.asar$/.test(name)) list.push(path.join(support, name));
    }
  } catch {
    // Not installed, or never auto-updated; the .app locations still apply.
  }
  return list.filter((file) => fsSync.existsSync(file));
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/** Cheap version probe: only the ASAR header and package.json are read. */
async function probeAsarVersion(asarPath) {
  const handle = await fs.open(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    await handle.read(head, 0, 16, 0);
    const jsonLength = head.readUInt32LE(12);
    const dataOffset = 8 + head.readUInt32LE(4);
    const jsonBuf = Buffer.alloc(jsonLength);
    await handle.read(jsonBuf, 0, jsonLength, 16);
    const entry = JSON.parse(jsonBuf.toString('utf8')).files?.['package.json'];
    if (!entry || typeof entry.offset !== 'string') return null;
    const buf = Buffer.alloc(entry.size);
    await handle.read(buf, 0, entry.size, dataOffset + Number(entry.offset));
    return JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, '')).version ?? null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function detectAsar() {
  const found = [];
  for (const file of candidateAsars()) {
    const version = await probeAsarVersion(file);
    if (version) found.push({ file, version });
  }
  if (found.length === 0) return null;
  found.sort((x, y) => compareVersions(y.version, x.version));
  return found[0];
}

const HASHED_FILES = ['app.js', 'app.css', 'worker.js', 'index.html'];
const SKIPPED_DIRS = new Set(['node_modules']);
const EXPECTED_VERSION_APP_JS_SIZE = { '1.14.4': 3942126 };
// Versions the shim layer has been verified against (npm run check:*). Others
// extract fine but may break at boot; say so instead of failing silently later.
const TESTED_VERSIONS = new Set(['1.14.4']);

const log = (...args) => console.log(...args);

function usage() {
  log(`Usage: node scripts/fetch-obsidian.mjs [options]

Options:
  --from <path>   Path to obsidian.asar (also: OBSIDIAN_ASAR env)
                  default: auto-detect the newest installed version under
                  /Applications, ~/Applications and
                  ~/Library/Application Support/obsidian (macOS)
  --out <dir>     Output directory, must resolve inside ${VENDOR_ROOT}
                  (default: ${DEFAULT_OUT})
  --force         Re-extract even if the existing manifest is up to date
  -h, --help      Show this help
`);
}

class CliError extends Error {}

function fail(message) {
  throw new CliError(message);
}

function parseArgs(argv) {
  const opts = { from: process.env.OBSIDIAN_ASAR || null, out: null, force: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--from' || arg.startsWith('--from=')) {
      const value = arg === '--from' ? argv[++i] : arg.slice('--from='.length);
      if (!value) fail('--from requires a path');
      opts.from = value;
    } else if (arg === '--out' || arg.startsWith('--out=')) {
      const value = arg === '--out' ? argv[++i] : arg.slice('--out='.length);
      if (!value) fail('--out requires a directory');
      opts.out = value;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }

  return opts;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Resolve symlinks for the longest existing prefix, appending the not-yet
 * existing tail.  Used to test containment without requiring the target to
 * exist yet.
 */
async function realpathNearest(target) {
  let current = path.resolve(target);
  const tail = [];

  for (;;) {
    try {
      const real = await fs.realpath(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function isStrictlyInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

async function resolveOutput(outArg) {
  // The default is repo-relative; an explicit --out is cwd-relative.
  const outAbs = outArg
    ? path.isAbsolute(outArg)
      ? path.resolve(outArg)
      : path.resolve(process.cwd(), outArg)
    : path.join(REPO_ROOT, DEFAULT_OUT);

  await fs.mkdir(VENDOR_ROOT, { recursive: true });
  const vendorReal = await fs.realpath(VENDOR_ROOT);
  const repoReal = await fs.realpath(REPO_ROOT);
  if (vendorReal !== path.join(repoReal, 'vendor')) {
    fail(`vendor/ must be a real directory inside the repo: ${vendorReal}`);
  }

  const outReal = await realpathNearest(outAbs);

  if (!isStrictlyInside(vendorReal, outReal)) {
    fail(`refusing to write outside vendor/: ${outAbs}\n       vendor root: ${vendorReal}`);
  }

  // The manifest is a sibling file; refuse to follow a symlink out of vendor/.
  // lstat is required because realpath() reports ENOENT for a dangling symlink,
  // which would otherwise let writeFile() create the file outside vendor/.
  const manifestPath = `${outReal}.manifest.json`;
  try {
    const manifestStat = await fs.lstat(manifestPath);
    if (manifestStat.isSymbolicLink()) {
      fail(`refusing to use symlinked manifest: ${manifestPath}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return { outAbs: outReal, manifestPath };
}

/**
 * Minimal ASAR reader.
 *
 * Layout (little-endian):
 *   0x00  uint32  pickle header size (always 4)
 *   0x04  uint32  size of the pickle payload that follows these 8 bytes
 *   0x08  uint32  header string size
 *   0x0c  uint32  JSON length
 *   0x10  JSON header
 *
 * The data section starts at 8 + <uint32 at 0x04>.  File offsets inside the
 * JSON are relative to that data section, NOT to the start of the file.
 */
async function readAsar(asarPath) {
  const stat = await fs.stat(asarPath);
  if (!stat.isFile()) fail(`not a file: ${asarPath}`);

  const raw = await fs.readFile(asarPath);
  if (raw.length < 16) fail(`file is too small to be an ASAR archive: ${asarPath}`);

  const pickleHeaderSize = raw.readUInt32LE(0);
  const picklePayloadSize = raw.readUInt32LE(4);
  const headerStringSize = raw.readUInt32LE(8);
  const jsonLength = raw.readUInt32LE(12);

  if (pickleHeaderSize !== 4) {
    fail(`unexpected pickle header size ${pickleHeaderSize} (expected 4)`);
  }
  if (jsonLength === 0 || 16 + jsonLength > raw.length) {
    fail(`invalid ASAR header length ${jsonLength}`);
  }
  if (8 + picklePayloadSize > raw.length) {
    fail(`invalid ASAR data offset ${8 + picklePayloadSize}`);
  }
  if (headerStringSize !== jsonLength + 4) {
    // Not fatal, but a mismatch means the format is not the one we expect.
    console.warn(
      `warning: header string size ${headerStringSize} != JSON length + 4 (${jsonLength + 4})`,
    );
  }

  const jsonText = raw.toString('utf8', 16, 16 + jsonLength);
  let header;
  try {
    header = JSON.parse(jsonText);
  } catch (error) {
    fail(`cannot parse ASAR header JSON: ${error.message}`);
  }
  if (!header || typeof header.files !== 'object') fail('ASAR header has no files tree');

  // Validated by matching every file against the integrity hashes shipped in
  // the header (see extract()).
  const dataOffset = 8 + picklePayloadSize;
  if (dataOffset < 16 + jsonLength) {
    fail(`ASAR data offset ${dataOffset} overlaps the header`);
  }

  return { raw, dataOffset, header, sourceSha256: sha256(raw) };
}

function collectEntries(header) {
  const files = [];
  const dirs = [];

  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      if (!name || name.includes('\0') || name === '.' || name === '..' || name.includes('/')) {
        fail(`unsafe file name in ASAR header: ${JSON.stringify(name)}`);
      }

      const relPath = prefix ? `${prefix}/${name}` : name;

      if (entry.files) {
        if (SKIPPED_DIRS.has(name)) continue;
        dirs.push(relPath);
        walk(entry, relPath);
        continue;
      }

      if (entry.link) {
        // Links are resolved later against the collected tree.
        files.push({ relPath, link: entry.link });
        continue;
      }

      if (typeof entry.offset !== 'string' || !/^\d+$/.test(entry.offset)) {
        fail(`missing/unsafe offset for ${relPath}`);
      }
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
        fail(`missing/unsafe size for ${relPath}`);
      }

      files.push({
        relPath,
        offset: Number(entry.offset),
        size: entry.size,
        unpacked: entry.unpacked === true,
        integrity: entry.integrity ?? null,
      });
    }
  };

  walk(header, '');
  return { files, dirs };
}

function resolveLinks(files) {
  const byPath = new Map(files.map((file) => [file.relPath, file]));

  const resolve = (file, seen = new Set()) => {
    if (!file.link) return file;
    if (seen.has(file.relPath)) fail(`circular ASAR link: ${[...seen, file.relPath].join(' -> ')}`);

    const targetPath = path.posix.normalize(file.link).replace(/^\/+/, '');
    if (targetPath.startsWith('../') || targetPath === '..') {
      fail(`unsafe ASAR link target for ${file.relPath}: ${file.link}`);
    }
    const target = byPath.get(targetPath);
    if (!target) fail(`dangling ASAR link for ${file.relPath}: ${file.link}`);

    seen.add(file.relPath);
    return resolve(target, seen);
  };

  return files.map((file) => (file.link ? { ...resolve(file), relPath: file.relPath } : file));
}

function verifyIntegrity(relPath, buf, integrity) {
  if (!integrity || typeof integrity.hash !== 'string') return;
  if (integrity.algorithm !== 'SHA256') return;

  const actual = sha256(buf);
  if (actual !== integrity.hash) {
    fail(
      `integrity mismatch for ${relPath}\n` +
        `       expected ${integrity.hash}\n` +
        `       actual   ${actual}`,
    );
  }
}

async function readEntryContent(file, asar) {
  if (file.unpacked) {
    // Electron keeps unpacked files next to the archive in `<asar>.unpacked/`.
    const unpackedPath = path.join(`${asar.path}.unpacked`, ...file.relPath.split('/'));
    const buf = await fs.readFile(unpackedPath);
    if (buf.length !== file.size) {
      fail(`unpacked size mismatch for ${file.relPath}: ${buf.length} != ${file.size}`);
    }
    return buf;
  }

  const start = asar.dataOffset + file.offset;
  const end = start + file.size;
  if (start < asar.dataOffset || end > asar.raw.length) {
    fail(`file range out of bounds for ${file.relPath}`);
  }
  return asar.raw.subarray(start, end);
}

async function readManifest(manifestPath) {
  try {
    return JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    console.warn(`warning: ignoring unreadable manifest ${manifestPath}: ${error.message}`);
    return null;
  }
}

async function isUpToDate(manifestPath, sourceSha256, expectedAppJsSize, outDir) {
  const manifest = await readManifest(manifestPath);
  if (!manifest) return false;
  if (manifest.sourceSha256 !== sourceSha256) return false;

  try {
    const stat = await fs.stat(path.join(outDir, 'app.js'));
    if (!stat.isFile() || stat.size !== expectedAppJsSize) return false;
  } catch {
    return false;
  }

  return true;
}

async function extract(files, dirs, asar, tempDir) {
  await fs.mkdir(tempDir, { recursive: true });
  // mkdtemp creates 0700; the extracted tree is served as static assets.
  await fs.chmod(tempDir, 0o755);

  for (const dir of dirs) {
    await fs.mkdir(path.join(tempDir, ...dir.split('/')), { recursive: true });
  }

  let fileCount = 0;
  let unpackedCount = 0;
  const hashes = Object.fromEntries(HASHED_FILES.map((name) => [name, null]));

  for (const file of files) {
    const buf = await readEntryContent(file, asar);
    if (buf.length !== file.size) {
      fail(`size mismatch for ${file.relPath}: ${buf.length} != ${file.size}`);
    }
    verifyIntegrity(file.relPath, buf, file.integrity);

    const dest = path.resolve(tempDir, ...file.relPath.split('/'));
    if (!isStrictlyInside(path.resolve(tempDir), dest)) {
      fail(`refusing to write outside output directory: ${file.relPath}`);
    }

    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, buf, { mode: 0o644 });

    if (HASHED_FILES.includes(file.relPath)) hashes[file.relPath] = sha256(buf);
    if (file.unpacked) unpackedCount++;
    fileCount++;
  }

  return { fileCount, unpackedCount, hashes, dirCount: dirs.length };
}

async function readVersion(files, asar) {
  const pkg = files.find((file) => file.relPath === 'package.json');
  if (!pkg) fail('package.json not found in ASAR');

  const buf = await readEntryContent(pkg, asar);
  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    fail(`cannot parse package.json from ASAR: ${error.message}`);
  }
  if (typeof parsed.version !== 'string' || !parsed.version) {
    fail('package.json in ASAR has no version field');
  }
  return parsed.version;
}

async function swapIntoPlace(tempDir, outDir) {
  const backupDir = `${outDir}.old-${process.pid}-${Date.now()}`;
  const hadOld = await pathExists(outDir);

  if (hadOld) await fs.rename(outDir, backupDir);
  try {
    await fs.rename(tempDir, outDir);
  } catch (error) {
    if (hadOld) await fs.rename(backupDir, outDir).catch(() => {});
    throw error;
  }

  if (hadOld) await fs.rm(backupDir, { recursive: true, force: true });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let source = opts.from;
  if (!source) {
    if (process.platform !== 'darwin') {
      fail('目前只支援 macOS 自動偵測。請用 --from <obsidian.asar> 指定來源（或設 OBSIDIAN_ASAR）。');
    }
    const detected = await detectAsar();
    if (!detected) {
      fail(
        '找不到已安裝的 Obsidian。請先從 https://obsidian.md 安裝官方桌面版，' +
          '或用 --from <obsidian.asar> 指定來源。',
      );
    }
    source = detected.file;
    log(`detected Obsidian ${detected.version}`);
  }
  const asarPath = path.resolve(source);

  if (!(await pathExists(asarPath))) {
    fail(`source archive not found: ${asarPath}`);
  }

  const { outAbs, manifestPath } = await resolveOutput(opts.out);

  const asar = await readAsar(asarPath);
  asar.path = asarPath;

  const { files: rawFiles, dirs } = collectEntries(asar.header);
  const files = resolveLinks(rawFiles);
  const version = await readVersion(files, asar);

  const appJs = files.find((file) => file.relPath === 'app.js');
  if (!appJs) fail('app.js not found in ASAR');

  const expectedSize = EXPECTED_VERSION_APP_JS_SIZE[version];
  if (expectedSize !== undefined && appJs.size !== expectedSize) {
    fail(
      `app.js size ${appJs.size} does not match the known size ${expectedSize} for v${version}\n` +
        '       the archive layout may have changed; do not trust extracted output',
    );
  }

  if (!TESTED_VERSIONS.has(version)) {
    console.warn(
      `warning: Obsidian ${version} 尚未驗證（已驗證：${[...TESTED_VERSIONS].join(', ')}）。` +
        '可能無法開機；請回報 issue，或改用已驗證版本的 --from。',
    );
  }

  if (!opts.force && (await isUpToDate(manifestPath, asar.sourceSha256, appJs.size, outAbs))) {
    log(`up to date: ${outAbs}`);
    log(`  source   ${asarPath}`);
    log(`  version  ${version}`);
    log(`  sha256   ${asar.sourceSha256}`);
    return;
  }

  log(`source   ${asarPath}`);
  log(`version  ${version}`);
  log(`sha256   ${asar.sourceSha256}`);
  log(`output   ${outAbs}`);

  const tempDir = await fs.mkdtemp(path.join(VENDOR_ROOT, '.obsidian-tmp-'));
  let result;
  try {
    result = await extract(files, dirs, asar, tempDir);

    const manifest = {
      source: asarPath,
      sourceSha256: asar.sourceSha256,
      version,
      extractedAt: new Date().toISOString(),
      // ASAR counts directories as entries too; 1.14.4 has 368 files + 28 dirs.
      fileCount: result.fileCount + result.dirCount,
      fileCountFiles: result.fileCount,
      dirCount: result.dirCount,
      unpackedCount: result.unpackedCount,
      skipped: ['node_modules'],
      hashes: result.hashes,
    };

    await swapIntoPlace(tempDir, outAbs);
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  log(
    `done: extracted ${result.fileCount} files in ${result.dirCount} directories ` +
      `(${result.unpackedCount} unpacked)`,
  );
  log(`manifest ${manifestPath}`);
  for (const name of HASHED_FILES) {
    log(`  ${name.padEnd(10)} ${result.hashes[name] ?? '-'}`);
  }
}

main().catch((error) => {
  if (error instanceof CliError) {
    console.error(`error: ${error.message}`);
  } else {
    console.error(`error: ${error?.stack ?? String(error)}`);
  }
  process.exit(1);
});
