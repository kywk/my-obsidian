# Shim 缺口清單

本檔案記錄 `packages/shim/src/**` 與 `packages/runtime/index.html` 中所有
**近似實作 / 尚未實作 / 明知不正確** 的行為。

維護規則（`AGENTS.md`）：遇到不確定的行為就寫在這裡，不要猜一個看起來合理的實作。
每一條都要寫出：位置、目前行為、正確行為應該是什麼。

---

## 1. Boot 與 terms

| 位置 | 目前行為 | 正確行為 |
|---|---|---|
| `boot-data.js`（`validate`） | `termsAccepted === true` 但 `termsText` 為空時直接 boot fatal 並丟 `MYOBS_BOOT_DATA_INVALID`。shim 本身不含任何授權字串。 | Server 必須依 `DESIGN.md` §8 注入操作者已同意的字串；此檢查只是在避免 Obsidian 靜默 `window.close()` 的白畫面。 |
| `boot-data.js`（`resourcePrefix`） | 若結尾不是 `/` 會**自動補上**。 | CONTRACTS §1 已規定 `/v/`；server 應直接提供正確值，shim 的寬容處理只是防禦。 |
| `index.html`（inline script） | `window.close` 被覆寫：`window.app` 尚未建立時呼叫 `close()` 會改顯示 fatal 畫面。 | 正確的宿主會提供正確 terms 字串讓 renderer 不呼叫 `close()`。此覆寫是 `DESIGN.md` §8 要求的可觀測化。 |
| `index.html`（inline script） | 所有 `unhandledrejection` 都會顯示全螢幕錯誤（可關閉）。 | 外掛的良性 rejection 不應蓋住 UI；長期應改為只在前台記錄 + 狀態列提示。 |

## 2. `process` / `electron` / IPC

| 位置 | 目前行為 | 正確行為 |
|---|---|---|
| `process-shim.js` | `versions.electron/node/chrome` 固定為 `35.0.0 / 22.0.0 / 128.0.0`。 | 應反映實際瀏覽器版本（`navigator.userAgent`）；依 chrome 版本分支的行為可能誤判。 |
| `process-shim.js` | `env` 為空物件，`argv`/`pid`/`execPath` 為假值，`nextTick` 用 microtask。 | Node 的 nextTick queue 早於 promise microtask；實際順序會有些微差異。 |
| `process-shim.js` | `on/once/removeListener/emit` 全部 no-op。 | 依賴 signal/exit 事件的外掛永遠不會收到事件。 |
| `electron-shim.js`（`sendSync`） | 未知頻道回 `undefined` 並在 console 警告一次。`frame → "native"`、`trash → false`、`update → "update-manual-required"` 都是策略選擇。 | 應逐一由 server 提供真實值；`trash` 的正確行為是作業系統垃圾桶（目前退回 vault 內 `.trash/`）。 |
| `electron-shim.js`（`request-url`） | 以 `fetch` 實作，受 CORS / cookie / proxy 限制；body 一律包成 `ArrayBuffer`。 | Electron main process 的 `net` 不受 CORS 限制、可帶系統 proxy。`binary` body 目前假設是 base64。 |
| `electron-shim.js` | `print-to-pdf` 回 `null`，沒有 PDF 輸出。 | 需 server 端 headless 列印或瀏覽器 `print()` 流程。 |
| `electron-shim.js` | `set-menu` / `render-menu` / `update-menu-items` 只記錄、不顯示原生選單；`remote.Menu.popup()` 是 no-op。 | 需以 DOM 選單重繪 Obsidian 的 menu template（`DESIGN.md` §3 第 5 項「自繪選單列」）。 |
| `electron-shim.js` | `remote.app.getPath()` 是近似對應：`userData → <vault>/.obsidian/myobs-userdata`、`temp → /tmp`、`downloads` 等由 `documentsDir` 推導。 | Electron 回傳作業系統真實路徑；目前 tmp/home 等路徑不在 vault 內，經 fs shim 會得到 `ENOENT`。 |
| `electron-shim.js`（`safeStorage`） | `isEncryptionAvailable()` 固定 `false`；`encrypt/decryptString` 只是 base64 來回。 | 應使用作業系統 keychain；目前 Obsidian 會走未加密分支。 |
| `electron-shim.js`（`nativeTheme`） | `shouldUseDarkColors` 讀 `matchMedia`；`on/removeAllListeners` 是 no-op，所以系統主題變化不會通知 renderer。 | 應用 `matchMedia` 的 `change` 事件轉發 `"updated"`。 |
| `electron-shim.js`（`webFrame`） | 縮放用 `document.documentElement.style.zoom` 近似，`getZoomLevel()` 用 `log(zoom)/log(1.2)`。 | Electron 的 zoom 會影響 `devicePixelRatio` 與 popout；CSS zoom 不完全等價。 |
| `electron-shim.js`（`remote.dialog`） | 所有對話框回 `null` / `canceled: true`。 | 需要 `<input type="file">` 或 server 端檔案瀏覽器；目前「自訂 icon」、「選擇翻譯檔」功能不可用。 |
| `electron-shim.js`（`clipboard` / `capturePage`） | clipboard 轉發 `navigator.clipboard`（非 HTTPS 會 reject）；`capturePage` 回空白圖。 | 需 secure context；截圖功能（dev:screenshot）不可用。 |
| `electron-shim.js`（`relaunch`） | `location.reload()`。 | Electron 是重啟整個 app process；僅影響「重新啟動」選項。 |
| `electron-shim.js`（`open-url` / `open-file`） | `http(s)/mailto` 以 `window.open` 開啟；`file:` 與 `open-file` 直接丟棄。 | 應將 `file:` 轉成 `/v/<abs>` 下載或 `obsidian://` web URL（`DESIGN.md` §3 第 5 項）。 |
| `electron-shim.js`（`get-icon`） | 永遠回 `null`（無自訂 icon）；`set-icon` no-op。 | 需 server 端儲存 icon 並由 `userData` 提供。 |
| `electron-shim.js`（`app.getPreferredSystemLanguages`） | 只回 `navigator.language`。 | 應列出系統語言清單。 |
| `electron-shim.js`（`frame`） | 回 `"native"`，讓 Obsidian 不建立自繪 title bar。 | 與 Desktop 的 frameless UI 不同；若要對齊 Desktop 需回 `"hidden"` 並實作 traffic-light/視窗控制。 |

## 3. `fs` shim

| 位置 | 目前行為 | 正確行為 |
|---|---|---|
| `fs-shim.js`（`existsSync`） | 只查由非同步 `/api/fs` `list/stat/...` 填出的快取；未快取的一律 `false`。 | 真正的同步檔案系統呼叫。目前 `FileSystemAdapter` 只在 `testInsensitive()` 探針與少數外掛路徑使用它。 |
| `fs-shim.js`（探針） | 檔名 `.OBSIDIANTEST`（不分大小寫）完全被吸收：`writeFileSync`/`unlinkSync` no-op，`existsSync` 在 darwin/win32 回 `true`、其他平台回 `false`。 | 真的寫入再以小寫查詢；目前假設 darwin/win32 都是 case-insensitive，case-sensitive APFS 會誤判。 |
| `fs-shim.js`（`writeFileSync` / `unlinkSync`） | 佇列化 fire-and-forget，立即回傳；錯誤只寫 console。 | 真正的同步 API；目前在後續非同步操作前不保證已完成，且不會丟錯。 |
| `fs-shim.js`（`statSync` / `lstatSync`） | 只讀快取，回傳 size 0、mtime = now 的假 stats；未快取丟 `ENOENT`。 | 真正的同步 stat。外掛（如 externalfile manager）會因此看不到檔案。 |
| `fs-shim.js`（`readFileSync`） | 只支援 `__MYOBS.resourcesPath`（`/obsidian/*`）的靜態資源，且用 sync XHR；vault 路徑丟 `ENOTSUP`。 | Node 可同步讀任何路徑；目前 i18n dev 檔、自訂 icon 等同步讀取會失敗。 |
| `fs-shim.js`（`watch`） | 回傳 no-op watcher（有 `on/close` 介面但永不觸發）。 | 真正的檔案監控。外部變更必須由 server 的 `/api/watch` WebSocket 接到 adapter 的 `onFileChange`，這條線目前尚未接上。 |
| `fs-shim.js`（`lstat` / symlink） | 直接轉呼 `stat`；server 的 `stat` 會 follow symlink，`isSymbolicLink()` 永遠 `false`。 | 需要 server 端 lstat op；目前 symlink 會被當成檔案/資料夾，且不會走 Obsidian 的 `reconcileSymbolicLinkCreation`。 |
| `fs-shim.js`（`stat.realpath`） | 直接透傳 server `stat` 回的 `realpath`；目前 `packages/server/src/fs-api.js` 回的是**絕對、已解析 symlink** 路徑。adapter 不讀此欄位。 | Node 的 stat 沒有 `realpath` 欄位；契約 §2 對此描述模糊。外掛若要一致請改讀 `fs.promises.realpath()`。 |
| `fs-shim.js`（`readFile`） | 未指定 encoding 時回 `Uint8Array`（不是 Node `Buffer`）。 | Node 回 `Buffer`；外掛若直接呼叫 `.toString("utf8")` 等方法會失敗，需傳 encoding。 |
| `fs-shim.js`（`writeFile`） | `ifMtimeMs` / `token` 只有呼叫端自己放在 options 才會轉發；Obsidian adapter 並不傳。conflict copy 只記錄在 `window.__MYOBS_LAST_CONFLICT` 與 console。 | 應在 UI 提示 conflict（`DESIGN.md` §5）；目前 `conflictSavedAs` 不會被使用者看到。 |
| `fs-shim.js`（`access`） | 忽略 mode（R_OK/W_OK/X_OK 都視為存在性檢查）。 | 需尊重 mode；唯讀資源也應區分 `EACCES`。 |
| `fs-shim.js`（`mkdir`） | 一律走 server 的遞迴 mkdir；`recursive: false` 不生效。 | 非遞迴時 parent 不存在應丟 `ENOENT`。 |
| `fs-shim.js`（`rm` / `rmdir`） | `rm` 在 `recursive:true` 時送 `rmdir {recursive:true}`，否則送 `remove`（server 對資料夾回 `EISDIR`，與 Node 一致）；`maxRetries`/`retryDelay` 忽略。 | `maxRetries` 等重試語意仍未實作；`force` 只吞 `ENOENT`。 |
| `fs-shim.js`（`copyFile`） | `COPYFILE_EXCL` 以「先 access 再 copy」兩個請求檢查，有 TOCTOU 競態；`COPYFILE_FICLONE*` 忽略。 | 應由 server copy op 帶 flags 原子處理。 |
| `fs-shim.js`（`readdir`） | 回傳 `files` 再接 `folders`（非檔案系統順序）；`recursive` 與 `encoding: "buffer"` 不支援；`withFileTypes` 的 `parentPath` 是絕對路徑。 | 完整 Node `readdir` 語意。單層名稱清單本身正確。 |
| `fs-shim.js`（`utimes`） | 只送 `mtimeMs`，忽略 atime，也不會設定 ctime。 | Node `utimes` 設定 atime+mtime；`btime` 無法設定。 |
| `fs-shim.js`（`workspace.json`） | 只改寫 vault 根目錄的 `.obsidian/workspace.json` → `.obsidian/workspace-server.json`；`workspace-mobile.json` 與自訂 config dir 不處理。rename/copy 的目的地也會被改寫。 | 若 Obsidian 允許自訂 config dir，需同步隔離；目前符合 `DESIGN.md` §4 的預設情況。 |
| `fs-shim.js`（路徑大小寫） | darwin/win32 對 vault/resources 前綴一律 case-insensitive 比對。 | 應以 `testInsensitive()` 的實際結果為準；case-sensitive APFS 可能誤把 `/Vault/...` 當成 vault 內。 |
| `fs-shim.js`（resources） | `/obsidian/*` 只能 read/stat/access（HTTP GET/HEAD）；`existsSync` 一律 `false`，`readdir` 丟 `EPERM`，寫入丟 `EPERM`。 | Electron 的 `resourcesPath` 是磁碟路徑。這裡沒有「絕對磁碟路徑 → 靜態 URL」的映射，只接受 URL 前綴本身。若 renderer 用 `original-fs` 讀 `/Applications/Obsidian.app/...` 會得到 `ENOENT`。 |
| `fs-shim.js`（resource `stat`） | 由 `Content-Length` / `Last-Modified` 拼出 stats；HEAD 405 時退回 GET。 | 與磁碟 stat 的 ino/mode/mtime 精度不同。 |
| `fs-shim.js`（callback API） | 只提供 `promises.*`、`existsSync`、`exists` 與少數 sync；沒有 callback 版 `readFile/writeFile/...` 與 `readFileSync(vault)`。 | L2 外掛若使用 callback fs 會直接失敗。 |
| `fs-shim.js`（缺的 promises） | 沒有 `opendir`、`readlink`、`symlink`、`link`、`chmod`、`chown`、`mkdtemp`、`cp`、`statfs`、`watch`。 | 完整 Node fs.promises 介面。 |
| `fs-shim.js`（`constants`） | 只提供 `COPYFILE_*`、`O_*`、`S_IF*` 等基本常數。 | 完整 `fs.constants`。目前 adapter 只用到 `COPYFILE_EXCL`。 |
| `fs-shim.js`（`realpath`） | vault 路徑回 `vaultRoot + 相對路徑` 的絕對字串；server 端 op 本身回相對路徑。 | Node 語意是解析 symlink 後的絕對路徑；目前不解析 symlink。 |

## 4. `path` / `os` / `url`

| 位置 | 目前行為 | 正確行為 |
|---|---|---|
| `path-shim.js` | 不是 Node 的完整移植：`parse` 對結尾斜線/`.` 目錄、win32 drive-relative、UNC 細節、`toNamespacedPath`、`matchesGlob` 都不同。 | 有需要時改用 `path-browserify` 或補齊；目前涵蓋 Obsidian adapter 與常見外掛用法。 |
| `path-shim.js`（`resolve`） | 相對路徑以 `process.cwd()` 為基準，而 shim 的 cwd 固定 `/`（win32 為 `C:\`）。 | Node 在桌面是 process cwd；此差異不影響 Obsidian（它只用絕對路徑）。 |
| `os-shim.js` | `version()`/`release()` 用 `navigator.userAgentData.platform` 或固定字串，不是 kernel 版本。 | 只能由 server 注入或接受此近似；只影響 About 視窗顯示。 |
| `os-shim.js` | `hostname()` 依序用 `__MYOBS.deviceName`（非 CONTRACTS 欄位）、`location.hostname`、`"my-obsidian"`。 | 應由 server 注入作業系統主機名。 |
| `os-shim.js` | `tmpdir`/`homedir` 由 `documentsDir` 推導；兩者可能落在 vault 外，經 fs shim 會 `ENOENT`。 | 應由 server 提供可讀寫的 tmp/home 或映射進 vault。 |
| `os-shim.js` | `cpus/totalmem/freemem/networkInterfaces` 回空值。 | 瀏覽器無法取得；外掛若用於診斷會顯示 0。 |
| `url-shim.js` | `pathToFileURL` 的 percent-encoding 與 Node 略有差異（例如 `~` 保持字面、Node 會編成 `%7E`）；回傳的是 plain object，不是 WHATWG `URL`。 | 需要位元級 URL 輸出的程式會不同；`FileSystemAdapter.getResourcePath` 只做字串處理，實測等價。 |
| `url-shim.js` | `parse`/`format` 是簡化版 legacy API。 | 完整 Node `url.parse` 欄位語意（auth/port/host 組合等）。 |

## 5. `crypto` / `btime`

| 位置 | 目前行為 | 正確行為 |
|---|---|---|
| `crypto-shim.js`（`scrypt`） | 明確丟 `Error("crypto.scrypt is not available in the browser shim")`；`scryptSync` 同理。 | 需要 scrypt 的外掛（Templater user scripts 等）在瀏覽器 runtime 無法執行；若要做，需 WASM 或 server 端 API。 |
| `crypto-shim.js` | `createHash`、`createHmac`、`pbkdf2`、`createCipheriv`/`createDecipheriv` 全部丟 `MODULE_NOT_SUPPORTED`。 | 可改用 `crypto.subtle` 的非同步版本，但會改變同步 API 語意。 |
| `crypto-shim.js`（`timingSafeEqual`） | 自行以迴圈比較，不是真正的 constant-time。 | 應用 `crypto.subtle` 實作；目前只用於非安全關鍵路徑。 |
| `crypto-shim.js`（`randomBytes`） | 回 `Uint8Array`（非 `Buffer`）；callback 版用 microtask 呼叫。 | Node 回 `Buffer` 並在 I/O 之後呼叫；外掛若檢查 `Buffer.isBuffer` 會失敗。 |
| `crypto-shim.js`（`subtle`） | 直接轉發 `window.crypto.subtle`；非 secure context 會是 `undefined`。 | 需要 HTTPS 或 localhost；server 部署時要注意（`DESIGN.md` §3 第 7 項）。 |
| `btime-shim.js` | `btime()` no-op 回 `true`；creation time 不會被還原。 | 瀏覽器無法設定伺服器檔案的 birth time；`stat.birthtimeMs` 目前來自 server 的 ctime。 |

## 6. `require` 白名單

| 位置 | 目前行為 | 正確行為 |
|---|---|---|
| `require-shim.js` | 只提供 `electron`、`fs`、`original-fs`、`path`、`os`、`url`、`crypto`、`btime`、`process`。 | `DESIGN.md` §7 的 `util`、`buffer`、`querystring` 尚未提供；使用它們的外掛會失敗。 |
| `require-shim.js` | `obsidian`、`@codemirror/*`、`@lezer/*` 不在此 shim 內；預期由 Obsidian 的外掛載入器轉發。 | 若外掛直接呼叫 `window.require("obsidian")`，目前會丟 `MODULE_NOT_SUPPORTED`。 |
| `require-shim.js` | 子路徑（`fs/promises`、`stream/web`）不支援。 | Node 支援子路徑；有外掛使用時需補。 |
| `require-shim.js` | 錯誤有 `code = "MODULE_NOT_SUPPORTED"` 與 `moduleName`，但只在 console。 | `DESIGN.md` §7 要求 UI 提示「此 plugin 需要伺服器端執行權限，已被拒絕」；目前尚未接上。 |

## 7. `index.html` / 資產路徑

| 位置 | 目前行為 | 正確行為 |
|---|---|---|
| `index.html` | Shim 以 `/shim/*` 載入、Obsidian 資產以 `/obsidian/*` 載入。截至目前 `packages/server/src/static.js` 只註冊 `/obsidian/*` 與 `/`，**沒有 `/shim/*` 路由**，因此十個 shim 會 404；必須由 server 補上（服務 `packages/shim/src`），或在契約中另訂 shim 路徑。 | 兩個靜態路由都必須存在；若改路徑需同步修改 `index.html` 與 boot-data 的 worker resolver。 |
| `boot-data.js`（Worker resolver） | 只改寫 `worker.js`、`/worker.js`、`sim.js`、`/sim.js` 四種寫法到 `resourcesPath`。 | 外掛以相對 URL 建立的 worker 仍以 document URL 為基準；若 runtime 頁面不在 `/obsidian/`，外掛需自己用絕對路徑。 |
| `index.html` | 沒有 PWA manifest / service worker。 | `DESIGN.md` §3 第 13 項的行動版需求尚未實作。 |
| `index.html` | fatal overlay 以 inline style/script 實作，CSP 只限制 `style-src`。 | 若 server 之後加上 `script-src` CSP，inline script 會被擋掉，需改為外部檔案或 nonce。 |

## 8. 與 server 的假設（不在此 repo 內，但會影響正確性）

| 假設 | 目前行為 | 備註 |
|---|---|---|
| `termsText` 注入 | `boot-data.js` 在 `termsAccepted === true` 時要求非空字串；CONTRACTS §1 範例沒有此欄位。 | Server 必須補上；否則會 boot fatal（這是刻意的，避免白畫面）。 |
| `resourcesPath` 是 URL 前綴 | fs shim 只認字串前綴 `/obsidian`，不認磁碟上的 `Contents/Resources`。 | 若 renderer 以 `original-fs` 讀真正的 Electron 資源磁碟路徑，會 `ENOENT`。 |
| `stat.realpath` | Server `stat` 回絕對、已解析 symlink 的 `realpath`；shim 直接透傳。`fs.promises.realpath()` 走獨立的 `realpath` op（server 回 vault 相對路徑，shim 再接成絕對）。 | 契約 §2 對 `stat.realpath` 的相對/絕對沒有明說；server 與 shim 目前一致，但需要寫進契約。 |
| `write.conflictSavedAs` | shim 有轉發，但 Obsidian adapter 沒把結果傳到 UI。 | 需要獨立的 server→client 通知或 `__MYOBS_LAST_CONFLICT` 的 UI 消費端。 |
| `/api/watch` WebSocket | shim 尚未把 WS 事件接進 adapter 的 `onFileChange`。 | fs.watch 目前 no-op；外部變更的熱重載要靠這條線（`DESIGN.md` §4）。 |
