# my-obsidian — 設計文件

在瀏覽器裡執行 **Obsidian 官方 renderer（未修改）**，由自架 Node 服務提供 vault 檔案 API。
目標：self-host 一個可線上存取／編輯指定 vault 的服務，功能與 plugin 支援對齊 Desktop 版體驗。

> 本文件是 2026-10-18 設計訪談的結論固化。所有決策都有對應的觀察證據；
> 標記 **[證據]** 者是直接從 shipped artifact 讀出，**[推論]** 者是尚未驗證的設計假設。

---

## 1. 為什麼可行（REA 觀察）

目標 artifact：`/Applications/Obsidian.app`（v1.14.4）。官方 1.14.4 Android APK 亦可取得。

| 事實 | 位置 | 意義 |
|---|---|---|
| Renderer 由自訂 `app://` protocol 服務 | `app.asar/main.js` **[證據]** | Obsidian 本來就是「本地 web server + web app」，只是 protocol 綁在 Electron 內 |
| Renderer 是單一 bundle `app.js`（3.94 MB） | `obsidian.asar/` **[證據]** | 3.94 MB 就是全部 UI 邏輯 |
| `FileSystemAdapter(fs, path, url, trash, btime, resourcePathPrefix, basePath)` **7 個參數全為注入** | `app.js` **[證據]** | 換掉注入物即可接別的後端 |
| **Adapter 全部 19 個方法都是 async**（`this.queue()` + `fs.promises`） | `app.js` **[證據]** | **不需要 preload VFS**，逐檔 HTTP 即可 |
| 同步 fs 呼叫只有 5 處，全在 `testInsensitive()` 探針 | `app.js` **[證據]** | 該探針可被 shim 吸收 |
| `worker.js`（metadata cache）無任何 Node `require`，用相對路徑建立 | `worker.js` **[證據]** | 瀏覽器可直接跑，5,124 篇的索引不必重寫 |
| Boot 期同步 IPC 只有 7 個 | `app.js` **[證據]** | 用注入的 JSON 可同步回答，零網路往返 |
| Plugin 以 `window.eval("(function anonymous(require,module,exports){...})")` 載入 | `app.js` **[證據]** | plugin 在 renderer 內執行，能力邊界 = 我們提供的 `require` |
| `write()` = `fsPromises.writeFile`，**無 temp+rename** | `app.js` **[證據]** | 寫入非原子性；並行寫入會撕裂，需條件寫入 |
| Workspace 檔名由 `Platform.isMobile` 決定，僅 2 個呼叫點 | `app.js` **[證據]** | 可在 fs shim 層改寫路徑隔離 |

### Boot 期同步 IPC（實測清單）

`vault`、`file-url`、`version`、`policy`、`terms`、`resources`、`documents-dir`

其餘非同步：`trash`（sync）、`request-url`、`print-to-pdf`、`set-menu`、`render-menu`、
`is-quitting`、`is-closing`、`desktop-dir`、`vault-list`、`get-icon`、`set-language` 等約 20 個。

---

## 2. 架構

```
瀏覽器
  ├─ /obsidian/*        vendor 靜態資產（app.js / worker.js / lib / i18n）— 未修改
  ├─ shim 層（classic script，依序載入）
  │    process → electron → fs → original-fs → path/os/url/crypto/btime → require
  └─ /api/fs  REST + /api/watch WS + /v/* 檔案直取（支援 Range）
Node 服務（Fastify）
  ├─ vault 監控（chokidar）→ WS 推播
  ├─ Dropbox / Desktop Obsidian / git / 手動編輯 皆為外部寫入者
  └─ plugin 安裝與更新代理（server 端抓 GitHub release）
```

### 目錄結構

```
my-obsidian/
  packages/server/     Fastify + WS；/api/fs、/api/watch、/v/*、/api/plugins
  packages/shim/       classic scripts：process、electron、fs、original-fs、path、os、url、crypto、btime、require
  packages/runtime/    index.html、boot、platform-bridge、同意畫面、popout
  vendor/obsidian/     gitignore；由 scripts/fetch-obsidian.mjs 產生
  docs/                本文件、api-fs.md、TODO.md
```

**每個決策的理由（不可任意更動）**

- **不上前端 bundler**：shim 必須在 Obsidian 的 `app.js` 之前以 classic script 生效；bundle 化只會製造載入順序問題。
- **`vendor/` 永不入版控**：Obsidian 非開源，程式碼透過腳本在使用者本機取得。
- **零 renderer patch**：所有平台行為在 runtime 以 shim 調整（`Object.defineProperty` 攔 `Platform`），`app.js` 保持與官方釋出檔位元一致。

---

## 3. 已定案的決策

| # | 決策 | 結論 |
|---|---|---|
| 1 | 交付架構 | 網頁原生客戶端，重用**官方 desktop bundle**（非 mobile bundle）；目標是 Desktop 版 UI 語意 |
| 2 | Renderer 來源與版本 | 本機 `/Applications/Obsidian.app/Contents/Resources/obsidian.asar`，版本跟隨安裝版（1.14.4）；`scripts/fetch-obsidian.mjs` 取得 |
| 3 | `terms` 閘 | **首啟同意畫面**：使用者本人按下同意 → 存 server config → 注入 `sendSync("terms")`。**程式碼不內建該字串**。未同意則拒絕啟動並顯示明確錯誤（不可停在白色載入動畫） |
| 4 | MVP 驗收邊界 | 編輯／預覽、檔案樹、分頁與分割、搜尋、標籤／反向連結、圖譜、Canvas、命令面板、核心 plugin 全數、社群 plugin 可安裝啟用、主題／片段 |
| 5 | 桌面專屬功能 | **MVP 要**：多視窗 popout、自繪選單列、右鍵選單、列印 PDF、手機寬度降級。**降級**：外部 App 開啟（檔案→下載）、`obsidian://`→ web URL。**不做**：全域快捷鍵、系統匣、CLI、Sync/Publish |
| 6 | Plugin 支援深度 | **L2**：瀏覽器端 Node polyfill + `fs`→RPC。L3（server 端執行）僅保留架構空間，不實作 |
| 7 | 部署與存取控制 | 預設 bind `127.0.0.1`；`--host 0.0.0.0 --auth-token` 才對外；TLS 交給 reverse proxy。單一 vault，路由 `/v/<vaultId>/` 預留多 vault |
| 8 | 資料一致性 | **server 為單一寫入者**為原則；外部寫入者存在時採條件寫入 + conflict copy（見 §6） |
| 9 | 專案落點 | `~/kywk/project/obsidian/my-obsidian`，獨立 git repo |
| 10 | 與 Markport 的關係 | **不 fork、不引入程式碼**（GPL-3.0 會綁住產品方向）。僅閱讀其 `archive/desktop-runtime` tag 作為參考，結論寫進本文件並標註出處 |
| 11 | Plugin 安裝流程 | Server 端代理抓取 GitHub release 資產 → 寫入 `.obsidian/plugins/<id>/`；安裝／啟用時顯示第三方程式碼執行確認 |
| 12 | 同步拓撲 | MVP 預設與 vault 同機（Maestral 已在跑）；server 不主動執行任何 git 指令 |
| 13 | 目標 UI 形態 | 桌機版面為預設；< 768px 自動降級手機版面；PWA manifest 有，service worker 只快取靜態資產 |
| 14 | 外部變更監控 | **服務啟動即監控（來源不限）**：Maestral/Dropbox、Desktop Obsidian、git、手動編輯 |
| 15 | `/api/fs` 契約 | 單一 `POST /api/fs`（`{op, path, args}`）+ `ifMtimeMs` 條件寫入；大檔走 `GET/PUT /v/<id>/<path>` |
| 16 | WS 推播 | `awaitWriteFinish` + 150ms 批次聚合 + write-token 回音過濾 + `WATCH_DISABLED` 開關 |
| 17 | Plugin `require` 白名單 | 見 §7 |

---

## 4. 外部變更與熱重載

| 變更 | 處置 |
|---|---|
| 筆記／附件 | 交給 Obsidian 內建 reconcile |
| `plugins/*/main.js`、`manifest.json` | **unload → load**（保留 plugin data） |
| `plugins/*/data.json` | 重載；若使用者正在編輯該設定頁則延後套用 |
| themes、snippets、核心設定 | 交給內建 `reloadConfig` |
| `workspace.json` | **完全排除**。fs shim 將 `.obsidian/workspace.json` 的讀寫改寫為 `.obsidian/workspace-server.json`，與 Desktop 各用一份 |
| `.git/`、`.docusaurus/` | watcher 強制忽略（沿用 `app.json` 的 `userIgnoreFilters` 並加入 `.git/`） |

提供 UI 開關「外部變更自動重載 plugin」（預設開）與手動「重新載入所有 plugin」。

### 已知熱區（實測）

`.obsidian/workspace.json` 會被 Desktop Obsidian 持續重寫（其餘設定檔 mtime 停在 2026-09-08，
`workspace.json` 為當日）。這是必須隔離該檔的直接證據。

---

## 5. `/api/fs` 契約

單一端點 `POST /api/fs`，body `{ op, path, args }`。
`path` 為相對於 vault root 的 posix 路徑。回傳 `{ ok, result }` 或 `{ ok:false, error:{ code, message } }`。

必要 ops（對應 adapter 方法）：
`read`、`readBinary`、`write`、`writeBinary`、`append`、`appendBinary`、`exists`、`stat`、`list`、
`mkdir`、`rmdir`、`remove`、`rename`、`copy`、`utimes`、`access`、`realpath`

**條件寫入**：`write` / `writeBinary` 可帶 `args.ifMtimeMs`。
不符時：把磁碟現有版本另存為 `<name>.conflict-<timestamp>.<ext>` → 再寫入新版本 → 回傳
`{ ok:true, result:{ conflictSavedAs } }`，由 UI 提示。

`stat` 回傳 `{ type: "file"|"folder", mtimeMs, ctimeMs, size, realpath }`。

大檔與附件走 `GET /v/<abs-path-without-leading-slash>`（支援 `Range`、`Accept-Ranges`、
`Last-Modified`）。此路徑由 `resourcePathPrefix` 產生。

---

## 6. 並行寫入的風險與處置

Obsidian 的 `write()` 不是原子寫入（無 temp+rename），因此：

1. `awaitWriteFinish.stabilityThreshold = 300` 是**必需**而非優化。
2. 兩個客戶端（瀏覽器 + Desktop Obsidian）同時寫同一檔會撕裂 → 以 §5 的條件寫入 + conflict copy 處理。
3. Server 不主動執行 git 指令，避免成為 index 衝突的第二個競爭者。

---

## 7. Plugin `require` 白名單（L2）

| 模組 | 提供方式 |
|---|---|
| `obsidian`、`@codemirror/*`、`@lezer/*` | bundle 內建，直接轉發（bundle 內有 14 個） |
| `path`、`os`、`util`、`url`、`crypto`、`buffer`、`querystring` | 瀏覽器 polyfill |
| `fs` / `original-fs` | → `/api/fs`。讀取放行；**寫入需 `PLUGIN_FS_WRITE=1`** |
| `electron` | partial：`remote.app.getVersion`、`shell.openExternal`→`window.open`、`clipboard` |
| `child_process`、`net`、`worker_threads` | **明確拋錯** + UI 提示「此 plugin 需要伺服器端執行權限，已被拒絕」 |

### 對照本人 vault（20 個已安裝 plugin）

需要 Node／Electron 的只有 5 個：`kanban`(path, electron)、`auto-link-title`(electron)、
`brat`(os)、`templater`(child_process, util)。白名單涵蓋前三個；**`templater` 的 user scripts
是唯一明確不支援項**，留待 v2。
（另註：`symlinks-obsidian/` 已損壞 — `main.js` 0 bytes、無 manifest。）

---

## 8. `terms` 閘

1.13+ 的 renderer 會在 boot 期向宿主索取一份聲明字串，並與自己內建的那份逐字比對；
不符就中止啟動。兩個通道的行為（本專案只走前者）：

| 通道 | 索取方式 | 不符時的結果 |
|---|---|---|
| desktop（本專案採用） | `ipcRenderer.sendSync("terms")` | `return window.close()` |
| mobile（不使用） | `App.getInfo().terms`（Capacitor） | `throw new Error` |

**該字串本身不記錄在本 repo 任何檔案中**（見 `AGENTS.md` 硬規則 3）。要在本機取得它：
從 `vendor/obsidian/app.js` 內 grep 該比對式即可得到字面值 —— 這是 renderer 自己內建的那份。
本機 spike 就是以這個方式取得，未落盤。

**本專案的處置**：程式碼不內建該字串；首次啟動顯示同意畫面，由操作者本人確認後寫入
server config，再由此注入（契約欄位為 `termsText`，見 `CONTRACTS.md` §1）。
未設定時服務拒絕啟動並輸出明確說明。

**必須理解的界線**：把 bundle 送進他人的瀏覽器，在字面上就落在該聲明的射程內。
私有自用（自己機器、自己 vault）與對外提供服務是兩件不同的事，後者需要 Obsidian team 的
明示同意。此判斷由操作者承擔。

**實作要求**：`terms` 不符時的失敗模式在瀏覽器是「卡在載入畫面」（`window.close()` 關不掉
非 script 開啟的分頁），因此必須自行攔截並顯示明確錯誤畫面。

---

## 9. 五層驗收與測試

1. **Smoke（Playwright）**：等到 `window.app` → 開既有筆記 → 打字 → 存檔 → 比對磁碟內容。
2. **Plugin 矩陣**：對 20 個已安裝 plugin 斷言「載入成功／拋錯」，把 L1/L2 覆蓋率變成數字。
3. **Vault 真實資料回歸**：對 `~/kywk/obsidian` 的**複本**執行（不動真實 vault）。
4. **熱重載**：外部改檔 → 斷言瀏覽器端內容／plugin 狀態更新。
5. **並行寫入**：模擬 Desktop Obsidian 同時寫入 → 斷言產生 conflict copy 且無資料遺失。

效能門檻（實測）：5,124 篇 / 1.6 GB vault，冷啟 < 5 秒（server 與瀏覽器同機）。

---

## 10. 第一個 Spike

**範圍**：1.14.4 desktop bundle 在瀏覽器開起來 → 讀 vault 筆記 → 寫回。
**不做**：plugin、popout、選單、熱重載。

**驗收條件 — 2026-10-18 全部通過**

| 條件 | 結果 |
|---|---|
| `window.app` 存在 | ✅ |
| `app.vault.getFiles().length > 5000` | ✅ 10,034 篇 markdown / 14,285 個已載入項目 |
| `app.metadataCache.initialized === true` | ✅ |
| 開筆記、打字存檔、磁碟逐字元相符 | ✅ 寫入後回讀一致並還原原內容 |
| 冷啟 < 5 秒（同機） | ✅ **513 ms** |
| `workspace.json` 未被寫入、`workspace-server.json` 已建立 | ✅ mtime 不變 |
| console 無未處理例外 | ✅ 0 exception / 0 error（19,280 個 fs 請求、0 失敗） |

驗收對象是 `~/kywk/obsidian` 的複本（10,150 檔、341 MB），**不是真實 vault**。
執行方式：`node tools/spike-check.mjs --vault <複本路徑>`（零依賴，用 Node 內建 WebSocket 驅動本機 Chrome 的 CDP）。

---

## 11. Spike 期間發現的兩件事（必須保留的設計知識）

### 11.1 adapter 的序列化佇列，被 `readdir` 繞過 → 併發無上限

`FileSystemAdapter.queue()` 是這樣實作的：

```js
e.prototype.queue = function (fn) {
  var i = this.promise.then(n, n);
  return this.promise = i, i;          // ← 每個操作都鏈在前一個之後
};
```

所有 adapter 方法都經過它，所以看起來是嚴格序列化。**但 `listRecursive` 用的是 `this.fsPromises.readdir`（直接呼叫），不經過 `queue`**，而它又是 `Promise.all` 對整棵目錄樹展開。結果是併發無上限。

實測：對 10,150 檔的 vault，**2 秒內爆出 7,000 個請求**，Chrome 開始以 `Failed to fetch` 拒絕請求 —— 而且是在**請求離開瀏覽器之前**就失敗（伺服器端 0 筆紀錄）。一個 rejection 讓 `Promise.all` 失敗 → 整個 vault load 中止 → 掃描停在 6,311 檔、`metadataCache` 永不初始化、畫面看起來「載入中卡住」。

**處置**：在 shim 的傳輸層（`fs-shim.js` 的 `api()`）加併發上限（48）。這是唯一擋得住所有呼叫端的位置，而且不是 patch renderer。修正後 19,280 個請求、0 失敗、全 vault 掃描約 1 秒。

> 這條同時解釋了為什麼「用一般 fs 語意去猜」會設計錯：桌面環境下這個 fan-out 是免費的，網路後端不是。

### 11.2 Mermaid / PDF / Prism / MathJax / Slides 走根絕對路徑

Obsidian 用 `yE("/lib/...")` 懶載入這些重函式庫，清單為：

`/lib/codemirror/modes.min.js`、`/lib/mermaid.min.js`、`/lib/prism.min.js`、`/lib/mathjax/obsidian-mathjax.js`、`/lib/reveal/reveal.js`、`/lib/pdfjs/pdf.min.mjs`、`/lib/pdfjs/pdf.viewer.min.mjs`、`/lib/pixi.min.js`

桌面版的 document base 是 `app://obsidian.md/`，所以 `/lib` 等於 app root。本專案的 app root 是 `/obsidian/`，**因此 `/lib/*` 必須註冊成 alias**。沒有它，這些函式庫全部 404，而且失敗形式是「lazy-load 的 promise 以一個裸 `Event` 被拒絕」—— 看起來像未處理例外，不像缺少資產。

（同類的還有 `new Worker("worker.js")` 與 `new Worker("/sim.js")`，已由 `boot-data.js` 重寫為 `/obsidian/` 前綴。）

### 11.3 `policy` 不可為空 —— 否則所有社群 plugin 靜默不載入

renderer 的 boot 流程：

```js
var Hx = { plugins:!0, themes:!0, snippets:!0, sync:!0, publish:!0, webViewer:!0, devTools:!0, insider:!0 }, zx=!1;
function (e) { zx || (Hx = Object.freeze(e), zx = !0) }(ipcRenderer.sendSync("policy"));
function Vx(e, t) { return !0 === e || Array.isArray(e) && e.includes(t) }
```

`Vx` 是 `policyAllows`，`PluginManager.enablePlugin()` 第一行就呼叫它。
送出 `{}` 會**無條件覆蓋**那份寬鬆預設，於是 `Hx.plugins` 是 `undefined` → `policyAllows(undefined, id)` 回 `false`
→ 社群 plugin、主題、snippet 全部不載入，**沒有任何錯誤或日誌**。

伺服器因此注入 `DEFAULT_POLICY`，其值逐欄等於桌面版 main process 的正常建置預設（`Bt`）。

> 這個 bug 是實作熱重載時發現的：測試用的 probe plugin 一直不載入，追下去才看到 `enablePlugin` 被 policy 擋掉。
> 它會讓「MVP 支援 plugin」這條需求完全失效，而且症狀是靜默的。

### 11.4 `util` 等 Node 內建模組的缺口（已修）

`require-shim.js` 原本的可提供清單是 `electron, fs, original-fs, path, os, url, crypto, btime, process`，
少了 `DESIGN.md` §7 白名單裡的 `util`、`buffer`、`querystring`。
實測 `templater-obsidian` 的 `onload` 會因 `require("util")` 失敗而中斷。

已補上 `node-globals-shim.js`（同時處理 §11.5）。可提供清單改為由 registry 推導，
錯誤訊息不再可能過時。

### 11.5 瀏覽器缺少 Node 全域 —— 文字路徑正常，二進位路徑全壞

`app.js` 本體直接引用裸 `Buffer` **184 次**，包含 `Buffer.from`（`toArrayBuffer`，所有二進位讀寫都會用到）、
`Buffer.concat`、`Buffer.alloc`、`Buffer.isView`。Electron 有這些全域，瀏覽器沒有：

```
Buffer: "undefined"   global: "undefined"   setImmediate: "undefined"
```

**症狀是靜默的**：文字編輯、metadata cache、plugin 載入全部正常，只有附件（圖片／PDF／音訊）的
讀寫路徑會拋 `Buffer is not defined`。第一次 spike 只驗文字往返，所以完全沒看到 ——
是後來在 `spike-check.mjs` 加入二進位往返斷言才暴露：

```
binaryRoundTrip: false   →   加入 node-globals-shim.js 後   →   binaryRoundTrip: true
```

> 教訓：驗收條件只覆蓋文字路徑，等於沒覆蓋附件。`spike-check.mjs` 現在把二進位往返列為必要條件。

### 11.6 L2 覆蓋率（實測基準）

對 `~/kywk/obsidian` 的 16 個已啟用 plugin：**載入 14 個**。
唯二未載入的是 `vault-feed-reader` 與 `geo-story-map`，兩者都 `require("node:child_process")` ——
這是 `DESIGN.md` §7 明定的 L2 邊界，不是缺陷。

