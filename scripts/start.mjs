#!/usr/bin/env node
/**
 * Launcher and preflight for my-obsidian.
 *
 * The server itself only needs VAULT_PATH; everything else has a sane default.
 * This wrapper exists so the operator does not have to remember the env var
 * names, and so a missing piece reports *which* piece instead of a stack trace.
 *
 *   node scripts/start.mjs --vault ~/my-vault [--port 3000] [--host 0.0.0.0]
 *                          [--auth-token secret] [--no-watch] [--dev]
 *   node scripts/start.mjs --doctor [--vault ...]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isLoopbackHost } from '../packages/server/src/consent.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_ENTRY = path.join(REPO_ROOT, 'packages/server/src/index.js');
const VENDOR_DIR = path.join(REPO_ROOT, 'vendor/obsidian');

const CONFIG_PATH =
  process.env.MYOBS_CONFIG ||
  path.join(os.homedir(), '.config', 'my-obsidian', 'config.json');

function parseArgs(argv) {
  const out = {
    doctor: false,
    dev: false,
    vault: null,
    port: null,
    host: null,
    authToken: null,
    watch: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--doctor') out.doctor = true;
    else if (a === '--dev') out.dev = true;
    else if (a === '--vault') out.vault = argv[++i];
    else if (a === '--port') out.port = argv[++i];
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--auth-token') out.authToken = argv[++i];
    else if (a === '--no-watch') out.watch = false;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
    else if (!out.vault) out.vault = a;
  }
  return out;
}

const USAGE = `用法：
  node scripts/start.mjs --vault <vault 路徑> [選項]
  node scripts/start.mjs --doctor [--vault <路徑>]

選項：
  --vault <path>        要服務的 vault（必填；也可用 MYOBS_VAULT 環境變數）
  --port <n>            預設 3000
  --host <addr>         預設 127.0.0.1。設 0.0.0.0 前請先讀 README 的安全說明
  --auth-token <token>  共用 token；設定後所有請求都要帶 cookie myobs_token
  --no-watch            關閉檔案監看（debug 用）
  --dev                 本地開發模式：跳過同意畫面，從 vendor/obsidian/app.js 讀取字串注入；
                        只允許 loopback，不會寫入 config
  --doctor              只做環境檢查，不啟動

第一次使用請先跑 \`npm run vendor\` 取得 Obsidian renderer。`;

function readConsent() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const text = typeof raw.termsText === 'string' ? raw.termsText.trim() : '';
    return { present: true, accepted: text.length > 0, path: CONFIG_PATH };
  } catch (err) {
    if (err.code === 'ENOENT') return { present: false, accepted: false, path: CONFIG_PATH };
    return { present: true, accepted: false, path: CONFIG_PATH, broken: err.message };
  }
}

function checkVendor() {
  const appJs = path.join(VENDOR_DIR, 'app.js');
  if (!fs.existsSync(appJs)) return { ok: false, reason: 'vendor/obsidian/app.js 不存在' };
  const size = fs.statSync(appJs).size;
  // 3,942,126 is the shipped 1.14.4 size; a mismatch means a partial or patched
  // extraction, which is exactly what AGENTS.md hard rule 1 forbids.
  return { ok: size === 3942126, size, expected: 3942126, version: readVendorVersion() };
}

function readVendorVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, 'package.json'), 'utf8'));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

function runDoctor(args) {
  const lines = [];
  const problems = [];
  const notes = [];

  lines.push(`repo        ${REPO_ROOT}`);
  lines.push(`node        ${process.version}`);

  const vendor = checkVendor();
  if (vendor.ok) {
    lines.push(`vendor      OK（Obsidian ${vendor.version ?? '?'}，app.js ${vendor.size} bytes）`);
  } else if (vendor.size !== undefined) {
    lines.push(`vendor      app.js ${vendor.size} bytes（預期 ${vendor.expected}）`);
    problems.push('vendor/obsidian/app.js 大小不符 → 重跑 `npm run vendor -- --force`');
  } else {
    lines.push('vendor      缺少');
    problems.push('尚未取得 Obsidian renderer → 執行 `npm run vendor`');
  }

  const consent = readConsent();
  const devMode = args.dev || process.env.DEV_MODE === '1';
  if (devMode) {
    lines.push('consent     dev mode（跳過同意畫面；只允許 loopback；不寫入 config）');
  } else if (consent.accepted) {
    lines.push(`consent     已設定（${consent.path}）`);
  } else if (consent.broken) {
    lines.push(`consent     設定檔無法解析（${consent.broken}）`);
    problems.push('config 檔壞掉 → 刪掉後重開服務，於 / 完成同意畫面');
  } else {
    lines.push('consent     未設定');
    notes.push('啟動後開 http://127.0.0.1:<port>/ 完成同意畫面，即可啟動 renderer');
  }

  const vault = args.vault || process.env.MYOBS_VAULT || null;
  if (vault) {
    const absolute = path.resolve(vault.replace(/^~(?=\/|$)/, os.homedir()));
    if (!fs.existsSync(absolute)) {
      lines.push(`vault       ${absolute}（不存在）`);
      problems.push(`vault 路徑不存在：${absolute}`);
    } else if (!fs.existsSync(path.join(absolute, '.obsidian'))) {
      lines.push(`vault       ${absolute}（沒有 .obsidian，會被當成新 vault）`);
      notes.push('這個目錄不是既有 vault；Obsidian 會建立新的 .obsidian');
    } else {
      lines.push(`vault       ${absolute}`);
    }
  } else {
    lines.push('vault       未指定');
    notes.push('用 --vault <路徑> 或設定 MYOBS_VAULT');
  }

  const serverModules = path.join(REPO_ROOT, 'packages/server/node_modules');
  if (!fs.existsSync(serverModules)) {
    lines.push('server deps 缺少');
    problems.push('尚未安裝 server 依賴 → `cd packages/server && npm install`');
  } else {
    lines.push('server deps OK');
  }

  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  lines.push(`chrome      ${fs.existsSync(chrome) ? 'OK（工具脚本需要）' : '找不到（只有 tools/ 底下的驗收脚本需要）'}`);

  console.log(lines.join('\n'));
  if (notes.length) console.log(`\n提醒：\n${notes.map((n) => `  - ${n}`).join('\n')}`);
  if (problems.length) {
    console.log(`\n需要處理：\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    return 1;
  }
  console.log('\n一切就緒。');
  return 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  if (args.doctor) {
    process.exitCode = runDoctor(args);
    return 0;
  }

  const vaultInput = args.vault || process.env.MYOBS_VAULT;
  if (!vaultInput) {
    console.error('缺少 vault 路徑。\n');
    console.error(USAGE);
    return 1;
  }
  const vault = path.resolve(vaultInput.replace(/^~(?=\/|$)/, os.homedir()));

  if (!fs.existsSync(vault)) {
    console.error(`vault 不存在：${vault}\n先確認路徑，或用 --doctor 看環境檢查。`);
    return 1;
  }
  if (!fs.existsSync(path.join(VENDOR_DIR, 'app.js'))) {
    console.error('尚未取得 Obsidian renderer。先執行：\n  npm run vendor\n');
    return 1;
  }

  const port = args.port ?? process.env.PORT ?? '3000';
  const host = args.host ?? process.env.HOST ?? '127.0.0.1';
  const devMode = args.dev || process.env.DEV_MODE === '1';
  if (devMode && !isLoopbackHost(host)) {
    console.error(
      `--dev / DEV_MODE 只允許 loopback（127.0.0.1、::1、localhost）；目前是 ${host}。\n` +
        '要對外服務請關掉 dev mode 並完成同意畫面。',
    );
    return 1;
  }

  const env = {
    ...process.env,
    VAULT_PATH: vault,
    PORT: String(port),
    HOST: host,
  };
  if (args.authToken) env.AUTH_TOKEN = args.authToken;
  if (!args.watch) env.WATCH_DISABLED = '1';
  if (devMode) env.DEV_MODE = '1';
  if (process.env.TERMS_ACCEPTED === undefined) delete env.TERMS_ACCEPTED;

  const consent = readConsent();
  console.log(`vault   ${vault}`);
  console.log(`bind    http://${host}:${port}/`);
  if (args.authToken) console.log('auth    已啟用（cookie myobs_token）');
  if (devMode) {
    console.log('dev     已啟用（跳過同意畫面；只允許 loopback；不寫入 config）');
  }
  if (!isLoopbackHost(host)) {
    console.log('警告    你綁定了非 loopback 位址。沒有 auth token 時，能連到這個埠的人都能讀寫整個 vault。');
  }
  if (!consent.accepted && !devMode) {
    console.log('提醒    尚未完成授權聲明確認，開 http://%s:%s/ 會看到同意畫面。', host, port);
  }

  const child = spawn(process.execPath, [SERVER_ENTRY], { env, stdio: 'inherit' });
  const forward = (signal) => () => child.kill(signal);
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  child.on('exit', (code) => {
    process.exitCode = code ?? 0;
  });
  return 0;
}

try {
  process.exitCode = main() ?? 0;
} catch (err) {
  console.error(`啟動失敗：${err.message}`);
  process.exitCode = 1;
}
