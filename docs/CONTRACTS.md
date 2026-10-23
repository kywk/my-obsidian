# 介面契約（server ↔ shim）

實作前必讀。兩邊都照這份寫，不得各自發明欄位。
改動任何端點、header、錯誤碼或 boot 注入前，先確認這裡的語意；改完同步更新。

---

## 1. Boot 注入（server → 瀏覽器）

Server 在 HTML 中注入一段同步可用的 JSON，**必須早於任何 shim 與 Obsidian 的 script**：

```html
<script>window.__MYOBS = {
  vaultId: "myvault",
  vaultName: "MyVault",
  vaultPath: "/Users/you/Notes/MyVault",   // 絕對路徑，結尾不加斜線
  resourcesPath: "/obsidian",               // app 資源的 URL 前綴（對應 Electron resourcesPath）
  resourcePrefix: "/v/",                    // 供 adapter.getResourcePath 使用
                                            // ＝ ipcRenderer.sendSync("file-url") 必須回這個值
                                            //   （不是 resourcesPath！回錯會讓所有附件 URL 變成
                                            //    /obsidianprivate/var/… 被靜態路由吃掉，DESIGN.md §11.7）
  version: "1.14.4",
  build: "1.14.4",
  platform: "darwin",
  arch: "arm64",
  documentsDir: "/Users/you/Documents",
  desktopDir: "/Users/you/Desktop",
  policy: {
    plugins: true, themes: true, snippets: true, sync: true,
    publish: true, webViewer: true, devTools: true, insider: true
  },
  termsAccepted: true,
  termsText: "<操作者本人確認後提供的聲明字串；未提供時為空字串>",
  devMode: false
}</script>
```

`policy` **不可以是空物件**。renderer 會 `Object.freeze(sendSync("policy"))` 無條件覆蓋自己的寬鬆預設值，
之後每個社群 plugin／主題／snippet 都必須通過 `policyAllows(policy.plugins, id)`。
送 `{}` 的結果是**所有社群 plugin 靜默不載入**（沒有錯誤、沒有日誌）。上面的值是桌面版 main process
自己的正常建置預設，逐欄相同。詳見 `DESIGN.md` §11.3。

`termsAccepted` / `termsText` 的關係：`termsAccepted` 必須由「`termsText` 非空」推導，而不是由任何布林旗標推導。
若用 `TERMS_ACK=1` 這種「存在即同意」的值，renderer 的 `sendSync("terms")` 會拿到 `"1"`，
比對失敗後呼叫 `window.close()`，症狀是永遠停在載入畫面。

`termsAccepted` 為 false 時，server **不得提供 app.js**，且 `GET /` 改回同意頁
（與 `GET /consent` 同一頁）。

本機開發可用 `--dev` / `DEV_MODE=1`：server 在啟動時從 `vendor/obsidian/app.js`
讀出同一段字串，只存在記憶體並注入；**只允許 loopback**，不寫入 config。
這是 server-local 的行為，不是 wire contract 的例外。

---

## 2. `POST /api/fs`

請求：`{ op, path, args? }`。`path` 是**相對 vault root** 的 posix 路徑，允許空字串代表 root。

回應成功：`{ ok: true, result: <op-specific> }`
回應失敗：`{ ok: false, error: { code, message } }`，`code` 用 Node errno 字串（`ENOENT`、`EISDIR`、`EEXIST`、`ENOTDIR`、`EPERM`、`ECONFLICT`）。

| op | args | result |
|---|---|---|
| `read` | — | `string`（utf8） |
| `readBinary` | — | `{ base64: string }` |
| `write` | `{ data: string, ifMtimeMs?: number, token?: string }` | `{ mtimeMs, size, conflictSavedAs?: string }` |
| `writeBinary` | `{ base64: string, ifMtimeMs?: number, token?: string }` | 同上 |
| `append` / `appendBinary` | 同 write | 同上 |
| `exists` | — | `boolean` |
| `stat` | — | `{ type:"file"\|"folder", mtimeMs, ctimeMs, size, realpath } \| null` |
| `list` | — | `{ files: string[], folders: string[] }`（單層，名稱不含路徑） |
| `mkdir` | — | `null`（遞迴建立，已存在視為成功） |
| `rmdir` | — | `null`（預設非遞迴；`args.recursive` 可遞迴） |
| `remove` | — | `null`（目錄回 `EISDIR`，不代為遞迴） |
| `rename` | `{ to: string }`（相對路徑） | `null` |
| `copy` | `{ to: string }` | `null` |
| `utimes` | `{ mtimeMs, ctimeMs? }` | `null`（`ctimeMs` 為 inode change time，不可設定，伺服器刻意忽略） |
| `access` | — | `null` 或 `ENOENT` |
| `realpath` | — | `string`（**相對** vault root 的真實路徑） |

`stat` 缺檔時回 `{ ok:true, result:null }`，由 shim 轉成 `ENOENT`；`stat.realpath` 為**絕對**路徑。
指向 vault 外的符號連結：`stat` 回 `EPERM`；指向 vault 外而斷裂的連結回 `null`。

**規則**

- 任何解析後落在 vault root 之外的路徑 → `EPERM`。
- `write` 帶 `ifMtimeMs` 且與磁碟現值不符 → 先另存 `<name>.conflict-<epochms>.<ext>`，
  再寫入，回傳 `conflictSavedAs`。若 `ifMtimeMs` 省略則直接覆寫。
- `stat` 對符號連結回傳 `realpath` 為解析後路徑（adapter 依賴此欄位）。

---

## 3. `GET|PUT|HEAD /v/<absolute-path-without-leading-slash>`

供 `resourcePathPrefix` 產生附件 URL（`<img>`、`<video>`、PDF）。

- 僅允許 vault root 內的路徑，否則 403。
- 支援 `Range`（回 206 + `Content-Range` + `Accept-Ranges`）、`Last-Modified`、
  `Cache-Control: no-cache`（mtime 已在 query string 上）。
- `PUT` 供大檔上傳。**串流寫入**：route-level `onRequest` + `reply.hijack()`，把 `request.raw`
  流進同目錄的 sibling temp 檔（`.name.<uuid>.myobs-upload`、`flags:"wx"`、0600），
  成功後 `rename` 覆蓋目標（走 `resolved.real`，維持寫穿 symlink 的語意）。
  中斷或失敗一律刪 temp，舊檔內容不變、不留半檔。任何 content-type 都接受
  （不再受 Fastify 的 JSON parser 影響）；`bodyLimit` 在串流中以位元組計數強制，超過回 413 `ETOOBIG`。
  `X-Write-Token` 在 rename 成功後才登記，並綁定串流內容雜湊與寫後 metadata（§4）。實測 64 MiB 上傳峰值 +34 MiB `arrayBuffers`
  （整包 buffered 會持有完整 64 MiB）。
- `PUT` 可選帶 `X-Write-Token` 標頭，帶了就登記到與 `/api/fs`
  相同的 origin token 表，讓上傳者略過自己的回音事件。`GET`/`HEAD` 不登記（下載不是變更）。
- URL 形式為 `/v/` + 絕對路徑去掉開頭 `/`，例如
  `/v/Users/you/Notes/MyVault/assets/a.png?1730000000000`。
- 路徑由 `pathToFileURL` **逐段 percent-encode**；Fastify 的 wildcard 參數**已經解碼過一次**，
  伺服器端**不得再 `decodeURIComponent`**：多解一次會把 `a%20b.png` 當成 `a b.png`，
  在檔名含 `%XX` 時**靜默回傳錯誤檔案的位元組**（HTTP 200，內容是別人的）。
- `Range` 三態：未知 unit、多範圍 `a-b,c-d`、`end < start`、非數字 → **忽略並回 200 全文**
  （不實作 multipart/byteranges）；`start >= size`、`bytes=-0`、空檔案 → 416 +
  `Content-Range: bytes */<size>`。合法範圍超出 EOF 要夾到 `size-1`。
- `HEAD` 的 header 與 `GET` 逐欄相同且**無 body**（由 handler 明示，不依賴 Node 丟掉 body）。
- `.md` / `.markdown` → `text/markdown; charset=utf-8`（否則瀏覽器會下載而不是顯示）；
  所有 `text/*`、`application/json`、`image/svg+xml`、`application/xml` 一律帶 `; charset=utf-8`。

---

## 4. `GET /api/watch`（WebSocket）

Server → 客戶端：

```json
{ "type": "change", "events": [
  { "path": "notes/a.md", "kind": "create|change|delete", "mtimeMs": 1730000000000, "size": 1234,
    "originToken": "abc123" }
] }
```

- `originToken` 表示「**目前觀察到的磁碟版本符合此 token 的成功寫入**」。瀏覽器逐事件
  略過等於自己 session token 的項目；同批、同路徑的其他事件仍各自判斷。
- 一般檔案以預期內容的 SHA256 與成功寫入後的 inode、大小、mtime、ctime 等 metadata
  比對；預期內容取自請求或寫入前的來源，不把任意寫後讀值當成自己的版本。
  watcher 透過固定 descriptor 串流計算雜湊，確認讀取前後與路徑仍是同一版本。
- `/api/fs` 修改與 PUT 最後的 rename 共用路徑佇列；watcher 等待該路徑的修改完成後取樣。
  PUT 上傳過程不佔用佇列，雜湊在接收串流時計算，不把整個上傳載入記憶體；
  排隊後、rename 前再次確認連線未中斷，中斷時清除 temp 並保留目的檔。
- 寫穿 vault 內 symlink 時同時登記別名與實際目標；watcher 先走 vault 路徑檢查，
  再對解析後的路徑取樣。開啟 descriptor 後、讀取內容前再次檢查 canonical 路徑與
  descriptor 身分，以拒絕檢查後的祖先 symlink 替換。這是多步防護，並非核心層
  原子目錄隔離；無法保證抵禦惡意本機程式持續、精準改換命名空間。
- token **不消費即刪除**：同一版本跨批次的 create/change 仍帶 token，避免
  「自己存檔 → 外掛重載 → 又存檔」迴圈。版本不符立即撤銷紀錄並送出未標記事件。
  **TTL（30 s）只限制紀錄保存時間**，不再讓這段期間的同檔外部修改被一律略過。
- 同一路徑只保留最後成功寫入的 token 與版本。成功但未帶 token 的修改清除舊紀錄；
  失敗請求不登記新 token。刪除使用不存在的標記，目錄只比對本身 metadata，
  遞迴修改不替所有後代登記 token。
- 註冊表上限 2000 筆路徑，超過時逐出最久未寫入者；只有候選 token 路徑需要內容雜湊。
  兩個分頁持續互改同檔仍各自收到對方事件；這不是多寫入者協作或衝突合併協定。
- **事件不是 Node 的粒度**：同一路徑在同一個 150 ms 批次內會被去重（delete 優先）。
  依賴「先 create 再 change」兩個獨立事件的程式會看到合併後的單一事件。
- 批次聚合視窗 150 ms。
- chokidar 設定：`ignoreInitial: true`、`awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }`。
- 忽略清單：`.git/`、`.docusaurus/`、`node_modules/`，以及 `.obsidian/workspace.json`。
- 環境變數 `WATCH_DISABLED=1` 時不啟動 watcher。

客戶端 → server：目前只有 `{ "type": "ping" }`。

---

## 5. fs shim 的路徑規則

shim 收到絕對路徑時：

| 落在 | 對應 |
|---|---|
| `vaultPath` 之下 | → `/api/fs`，`path` 取相對部分 |
| `resourcesPath` 之下 | → 靜態資產 `/obsidian/*` |
| `.obsidian/workspace.json`（vault 內） | **改寫**為 `.obsidian/workspace-server.json` 再送出 |
| 其他 | throw `ENOENT` |

`testInsensitive()` 的探針（`.OBSIDIANTEST`）由 shim 直接吸收：`writeFileSync`/`unlinkSync` 為
no-op，`existsSync` 依 `__MYOBS.platform` 判斷（darwin/win32 → true）。

---

## 6. 我要的 shim 模組介面

每個 shim 都是 classic script，掛在 `window.__MYOBS_MODULES[name]`，
最後由 `require-shim.js` 建立 `window.require`：

```js
window.require = (name) => window.__MYOBS_MODULES[name]
  ?? (throw new Error("..."))
```

必要模組名：`electron`、`fs`、`original-fs`、`path`、`os`、`url`、`crypto`、`btime`、`process`。
`process` 同時要是 `window.process`（renderer 直接讀 `process.platform`）。

不可用模組（明確拋錯並附 `code: "MODULE_NOT_SUPPORTED"`）：
`net`、`worker_threads`。

`child_process`／`node:child_process` 可匯入；exec／execFile／spawn／fork、同步版本、
ChildProcess／_forkChild 一律在呼叫時同步拋相同錯誤碼，另附
`moduleName: "child_process"`、`reason: "server-side-module"`、`operation`。
不執行 callback、不產生子程序、不傳輸命令；promisify 包裝後得到 rejected Promise。
通知只含操作名稱與能力限制，不含命令或環境變數。

也可用（`node-globals-shim.js`）：`util`、`buffer`、`querystring`，以及全域 `Buffer`、
`global`、`setImmediate`。

---

## 7. 選單（renderer → runtime）

`set-menu` / `update-menu-items` / `render-menu` 是 **renderer → main 的單向頻道**，
Electron 的 main 不會回覆，因此 runtime **不得**用 `ipcRenderer.on()` 等待它們。
`electron-shim.js` 的 `send()` 直接呼叫 `window.__MYOBS_MENU`：

| channel | payload | runtime 動作 |
|---|---|---|
| `set-menu` | `{ template }` | 重畫選單列 |
| `update-menu-items` | `[{ itemId, eState }]`、`force?` | 以 `id \|\| appCommand` 更新 checked/enabled/visible/label |
| `render-menu` | — | 在最後游標位置彈出 root menu |

`context-menu` 是**唯一有 reply** 的頻道：renderer 送空請求，宿主必須回**非 null** 物件，
否則 renderer 直接放棄右鍵選單：

```js
{ editFlags: { canCut, canCopy, canPaste, canUndo, canRedo, canDelete,
               canSelectAll, canEditRichly },
  misspelledWord: "", dictionarySuggestions: [], webContentsId: 1 }
```

`remote.Menu.buildFromTemplate(t).popup(options)` 必須轉呼叫
`window.__MYOBS_MENU.popupTemplate(t, options, onClose)`；關閉時觸發 `menu-will-close`。

`nativeMenus`（1.14.4 在 `.obsidian/appearance.json`）設 `false` 時，右鍵選單由 Obsidian
自己畫 HTML，上述 fallback 就不會被走到 —— 這是建議設定。

---

## 8. `GET /api/proxy?url=<absolute-url>`

社羣外掛 Browse 的 CORS 缺口（`DESIGN.md` §11.12）。

- **server 端 allowlist 是唯一強制點**：`github.com`、`api.github.com`、
  `raw.githubusercontent.com`、`objects.githubusercontent.com`、
  `github-releases.githubusercontent.com`、`codeload.github.com`、`obsidian.md`、
  `forum.obsidian.md`、`help.obsidian.md`。
- deny by default：非 https、非 80/443、URL 內嵌憑證、`localhost`、私有／保留 IP、
  allowlist 外主機（含 lookalike 與 IDN）→ 403 `EPERM`。
- redirect **逐跳**重新驗證，不用 `redirect: "follow"`。
- 只轉發 `Accept`；不轉發 `Cookie` / `Authorization`；回應剝除 `Set-Cookie`。
- 串流輸出，上限 32 MB（`ETOOBIG`）；header 與 chunk 各 10 秒 timeout（`ETIMEDOUT`）。
- 一律 `Cache-Control: no-store`；成功與上游錯誤帶 `X-MyOBS-Proxy: 1`，
  proxy 自身錯誤另帶 `X-MyOBS-Proxy-Error: <code>`。
- 錯誤碼：400 `EINVAL`、403 `EPERM`、502 `EBADGATEWAY`/`ETOOBIG`、504 `ETIMEDOUT`。
- **DNS 檢查（每一跳、每個請求）**：`dns.lookup(host, {all:true})`，
  **任何**一個答案是私有／保留位址就 403 `EPERM`；解析失敗或 0 筆答案 → 502；解析逾時 → 504。
  覆蓋 IPv4（`0/8`、`10/8`、`100.64/10`、`127/8`、`169.254/16`、`172.16/12`、`192.0.0/24`、
  `192.0.2/24`、`198.18/15`、`198.51.100/24`、`203.0.113/24`、`192.168/16`、`224/4`、`240/4`）
  與 IPv6（`::`、`::1`、`fc00::/7`、`fe80::/10`、`ff00::/8`、`2001:db8::/32`、Teredo、6to4、
  `100::/64`、**IPv4-mapped** 與 deprecated IPv4-compatible）。不快取解析結果。
  **這是 TOCTOU-able 的緩解，不是完整防護** —— 檢查後 `fetch` 會再解析一次；
  真正的修法是位址 pinning（自訂 dispatcher 連到已檢查的 IP），目前沒有這個 hook。

---

## 9. `/api/plugins`

| 端點 | 說明 |
|---|---|
| `GET /api/plugins` | `{ ok, plugins:[{id,name,version,minAppVersion,isDesktopOnly,enabled,dir}], errors:[{dir,message}] }` |
| `POST /api/plugins/install` | body `{ repo:"owner/name", version?:"<tag>" }`；成功 `{ ok, id, version, files }` |
| `POST /api/plugins/uninstall` | body `{ id }`；移到 `.trash/plugins/<id>[-N]`，**不覆蓋**既有項目 |

install 流程：GitHub API 取 release → 下載 `manifest.json`/`main.js`（`styles.css` 若有）
→ 驗 manifest 可解析、`main.js` 非空、`digest` 相符 → **temp + rename 替換**
（先備份舊目錄，交換失敗就還原）→ 保留一般檔案形式的 `data.json`。
`repo` 需符合 `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`；解析後路徑不得逃出 plugins 目錄。
**server 不自動啟用外掛、不改 `community-plugins.json`。**

同一 Fastify instance 以 plugin id 序列化 install/uninstall 的磁碟修改；下載可並行，
順序依完成下載後進入修改佇列決定，不保證 HTTP 抵達順序。不同 id 可獨立修改。
兩次 rename 間仍有短暫的目錄空窗；此鎖不涵蓋官方 UI 的 `/api/fs`、外部同步工具或其他程序。

| 錯誤 | 處理 |
|---|---|
| `409 EINVALID`：既有 `data.json` 為 symlink 或目錄 | 保留舊版，請先將設定資料整理為一般檔案後重試 |
| `500 EROLLBACK`：新版發布與舊版復原都失敗 | 保留 `.obsidian/plugins/.myobs-backup-*`；錯誤訊息指出可復原位置，先復原再重試 |

---

## 10. PWA 與 runtime 診斷介面

```
GET /manifest.webmanifest  -> application/manifest+json; charset=utf-8, no-cache
GET /sw.js                 -> text/javascript; charset=utf-8, no-cache, Service-Worker-Allowed: /
  precache 僅 /obsidian/app.css、/obsidian/icon.png、/shim/*.js、/runtime/*.js
  **絕不快取** /api/fs、/api/watch、/v/*、/obsidian/app.js
GET /                      -> 在 </head> 前注入 <link rel="manifest">、theme-color、apple-touch-icon
                              （packages/runtime/index.html 本身不改）
```

```js
window.__MYOBS_MENU             = { installed, setTemplate, updateMenuItems, renderMenuAtCursor, popupTemplate, events[] }
window.__MYOBS_POPOUT           = { installed, frames[], events[], blocked, request, restore { saved[], offered, restored[] }, openInNewWindow }
window.__MYOBS_PLUGIN_WATCH     = { enabled, subscribed, events[], reloadAll() }
window.__MYOBS_PRINT            = { installed, printActiveNote(), beginPrintView(), endPrintView(), lastResult, events[] }
window.__MYOBS_PLATFORM_BRIDGE  = { installed, captured, overrides, applied, breakpointPx: 600, events[] }
window.__MYOBS_NET              = { enabled, hosts[], rewrite(url), stats { rewritten, skipped, lastUrl } }
window.__MYOBS_WATCH            = { watch, subscribe, state { connected, reconnects, received, dispatched, filtered } }
window.__MYOBS_NOTICES          = { installed, enabled, push, dismiss, list, clear, events[], consumeLastConflict }
window.__MYOBS_RESILIENCE       = { installed, online, probes, networkFailures, lastProbe, reconciling,
                                    lastReconcile { ok, durationMs, checked, created, changed, deletedFiles,
                                                    deletedFolders, createdFolders, skipped, errors },
                                    events[] { type }, noteNetworkFailure, noteWriteBlocked, probeNow, reconcileNow }
window.__MYOBS_DIALOG           = { installed, calls[], lastResult, lastSaveSource, syntheticPath }
```

### 10.1 `__MYOBS_NOTICES` 契約

```js
push({ level:"info"|"warn"|"error", source, message, detail?, dedupeKey?, actions? }) -> id | null
```

- `info` 8 秒、`warn` 20 秒、`error` **不自動消失**；展開 detail 時暫停計時。
- 同 `dedupeKey` 重複 push **合併成一張卡並累加 count**，訊息取最新。
- `enabled = false` 時 `push` 回 `null`、不進 DOM，但 `events` 仍記 `{ action:"push", suppressed:true }`。
- `push` 全包 try/catch；**呼叫端一律寫 `window.__MYOBS_NOTICES?.push?.(…)`**。
- 樣式只用 Obsidian 的 CSS 變數；z-index 低於 fatal 畫面。
- 已使用的 key：
  `resilience.js` → `server:offline` / `server:reconnected` / `server:reconciled` /
  `server:reconciled-none` / `server:reconcile-failed` / `write-blocked:<path>`；
  `fs-shim.js` → `fs:conflict:<path>` / `fs:conflict-missing:<path>`；
  `plugin-watch.js` → `plugin:<id>` / `plugin-disabled:<id>` / `plugin-disable-failed:<id>` / `plugin-policy`；
  `net-rewrite.js` → `proxy-host:<host>`。

### 10.2 fs 錯誤碼（client 端）

| code | 意義 | 可重試 |
|---|---|---|
| `EOFFLINE` | 已知離線，shim 直接擋下（未送出請求） | 否，等恢復 |
| `ECONNREFUSED` | 請求未到達伺服器 | 讀取一次，寫入否 |
| `EIO` | HTTP 層錯誤或非預期回應 | 否 |
| `EPERM` / `ENOENT` / `EISDIR` / `EEXIST` / `ECONFLICT` | 伺服器回報的語意錯誤 | 否 |

診斷欄位：`err.myobs = { op, path, write, network, blocked }`。
寫入類的 `EOFFLINE` / `ECONNREFUSED` unhandled rejection 會被抑制（`fatal-suppressed`），
讀取與啟動錯誤仍顯示 fatal 畫面。

列印結果形狀：成功 `{ ok:true, reason:"browser-print-dialog", printed:true, fileWritten:false, path, kind, filepath }`；
沒有開啟筆記 `{ ok:false, reason:"no-active-note", error:{ code:"NO_ACTIVE_NOTE" } }`。
**瀏覽器永遠不會寫入 `filepath`。**
