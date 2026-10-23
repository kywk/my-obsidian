# my-obsidian — 設計文件

在瀏覽器裡執行 **Obsidian 官方 renderer（未修改）**，由自架 Node 服務提供 vault 檔案 API。
目標：self-host 一個可線上存取／編輯指定 vault 的服務，功能與 plugin 支援對齊 Desktop 版體驗。

> 本文件是 2026-10-18 設計訪談的結論固化。所有決策都有對應的觀察證據；
> 標記 **[證據]** 者是直接從 shipped artifact 讀出，**[推論]** 者是尚未驗證的設計假設。

**Agent 閱讀順序**：§11（陷阱）→ §3（已定案決策）→ §8（terms 閘）→ §9（驗收）。
線路細節查 `CONTRACTS.md`；shim 已知落差查 `packages/shim/GAPS.md`。

| 想知道 | 看 |
|---|---|
| 為什麼這件事可行、renderer 的注入點 | §1 |
| 系統架構與目錄 | §2 |
| 19 項已定案決策 | §3 |
| 外部變更／熱重載 | §4 |
| `/api/fs` 與 `/v/*` 契約 | §5、`CONTRACTS.md` |
| terms 閘與 dev mode | §8 |
| 測試層次與 harness | §9 |
| 實作期間的 20 個陷阱 | **§11** |

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
| 1 | 交付架構 | 網頁原生客戶端，重用**官方 desktop bundle**（非 mobile bundle）；目標是 Desktop 版 UI 語意 || 2 | Renderer 來源與版本 | 本機 `/Applications/Obsidian.app/Contents/Resources/obsidian.asar`，版本跟隨安裝版（1.14.4）；`scripts/fetch-obsidian.mjs` 取得 |
| 3 | `terms` 閘 | **首啟同意畫面**：使用者本人按下同意 → 存 server config → 注入 `sendSync("terms")`。**程式碼不內建該字串**。未同意則拒絕啟動並顯示明確錯誤（不可停在白色載入動畫） |
| 4 | MVP 驗收邊界 | 編輯／預覽、檔案樹、分頁與分割、搜尋、標籤／反向連結、圖譜、Canvas、命令面板、核心 plugin 全數、社群 plugin 可安裝啟用、主題／片段 |
| 5 | 桌面專屬功能 | **MVP 要，已實作**：多視窗 popout（§11.8）、自繪選單列＋右鍵選單（§11.9）、列印 PDF（§11.10）、平板／桌面版面（§11.11）。**降級**：外部 App 開啟（檔案→下載）、`obsidian://`→ web URL。**不做**：全域快捷鍵、系統匣、CLI、Sync/Publish |
| 6 | Plugin 支援深度 | **L2**：瀏覽器端 Node polyfill + `fs`→RPC。L3（server 端執行）僅保留架構空間，不實作 |
| 7 | 部署與存取控制 | 預設 bind `127.0.0.1`；`--host 0.0.0.0 --auth-token` 才對外；TLS 交給 reverse proxy。單一 vault，路由 `/v/<vaultId>/` 預留多 vault |
| 8 | 資料一致性 | **server 為單一寫入者**為原則；外部寫入者存在時採條件寫入 + conflict copy（見 §6） |
| 9 | 專案落點 | 本 repo，獨立 git repo |
| 10 | 與 Markport 的關係 | **不 fork、不引入程式碼**（GPL-3.0 會綁住產品方向）。僅閱讀其 `archive/desktop-runtime` tag 作為參考，結論寫進本文件並標註出處 |
| 11 | Plugin 安裝流程 | **已實作**：`GET /api/proxy`（server 端 allowlist + SSRF 防護）、`POST /api/plugins/install`（temp+rename 原子替換、驗 digest、保留 `data.json`）、`POST /api/plugins/uninstall`（移到 `.trash`，不覆蓋）。詳見 §11.12 |
| 12 | 同步拓撲 | MVP 預設與 vault 同機（Maestral 已在跑）；server 不主動執行任何 git 指令 |
| 13 | 目標 UI 形態 | 桌機與平板為預設；>= 600px 維持桌面／平板版面，< 600px 才降級手機版面（§11.11，手機非支援目標）；PWA manifest 有，service worker **只快取靜態資產，絕不快取 vault 內容**（`/api/fs`、`/api/watch`、`/v/*`、`/obsidian/app.js` 全排除） |
| 14 | 外部變更監控 | **服務啟動即監控（來源不限）**：Maestral/Dropbox、Desktop Obsidian、git、手動編輯 |
| 15 | `/api/fs` 契約 | 單一 `POST /api/fs`（`{op, path, args}`）+ `ifMtimeMs` 條件寫入；大檔走 `GET/PUT /v/<id>/<path>` |
| 16 | WS 推播 | `awaitWriteFinish` + 150ms 批次聚合 + write-token 回音過濾 + `WATCH_DISABLED` 開關 |
| 17 | Plugin `require` 白名單 | 見 §7 |
| 18 | 後端斷線與重啟 | 前端主動偵測（`HEAD /` 輪詢 + fetch 失敗訊號 + WS 狀態）；**連續 2 次探測失敗**才離線（單次逾時不算，見 §11.13.1）；已知離線時變更類 op 直接 `EOFFLINE`、**不排隊不重試**；讀取僅在網路層失敗時重試一次；重連後以 `FileSystemAdapter.reconcileFile` 逐檔 reconcile（**不可用 `listAll()`**，見 §11.13）。驗收 `tools/resilience-check.mjs` 8/8 |
| 19 | 使用者可見的失敗 | 全部經 `window.__MYOBS_NOTICES`；同 `dedupeKey` 合併累加；一次 conflict 一張卡；boot 期外掛失敗用狀態差集；fatal overlay 只抑制寫入類離線 rejection。驗收 `tools/notices-check.mjs` 10/10，見 §11.14 |

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
| `path`、`os`、`util`、`url`、`crypto`、`buffer`、`querystring`、`events` | 瀏覽器 polyfill 子集，實際邊界見 `packages/shim/GAPS.md` |
| `fs` / `original-fs` / `fs/promises` | → `/api/fs`，僅 vault 內讀寫；Promise 與 callback 共用路徑限制和離線閘門。原設計的 `PLUGIN_FS_WRITE` 開關未實作，不可當成保護機制 |
| `electron` | partial：`remote.app.getVersion`、`shell.openExternal`→`window.open`、`clipboard` |
| `child_process` / `node:child_process` | 可匯入 refusal facade；exec／spawn 等全部同步拋 `MODULE_NOT_SUPPORTED`，附操作名稱與通知；沒有 server RPC |
| `net`、`worker_threads` 等特權模組 | 匯入即明確拋錯，不提供伺服器執行權限 |

### 對照本人 vault（20 個已安裝 plugin）

需要 Node／Electron 的只有 5 個：`kanban`(path, electron)、`auto-link-title`(electron)、
`brat`(os)、`templater`(child_process, util)。這是初期盤點；2026-10-24 新盤點見 `PLUGINS.md`。
Templater 純 JavaScript user scripts 已驗收；system commands 仍拒絕，不能將兩者混為一談。
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

**已實作介面**：`GET /consent`（未同意時 `GET /` 是同一頁，`packages/runtime/consent.html`）
→ `POST /api/consent` → 原子寫入 server config（`MYOBS_CONFIG`，預設
`~/.config/my-obsidian/config.json`，目錄 0700／檔案 0600）→ **立即生效，不需重啟**
（`termsAccepted` 每次請求由「`termsText` 非空」重新推導；config 被刪除時閘門自動關上）。
`TERMS_ACK` 環境變數保留為 fallback 且優先於 config 檔。

未同意時服務**照常啟動**，只是 `/` 回同意頁、`/obsidian/app.js` 回 403，並在 log 輸出警告與 config 路徑。

**本地開發模式（`--dev` / `DEV_MODE=1`）**：在啟動時從 `vendor/obsidian/app.js`
讀出同一段字串，只存在記憶體並注入 renderer，不寫入 config、不輸出到 log。
它**只允許 loopback**（`127.0.0.1`、`::1`、`localhost`）；非 loopback 直接拒絕啟動。
這是為了本機反覆開發，不是對外服務的替代方案；對外服務仍須完成同意畫面。

**必須理解的界線**：把 bundle 送進他人的瀏覽器，在字面上就落在該聲明的射程內。
私有自用（自己機器、自己 vault）與對外提供服務是兩件不同的事，後者需要 Obsidian team 的
明示同意。此判斷由操作者承擔。

**實作要求**：`terms` 不符時的失敗模式在瀏覽器是「卡在載入畫面」（`window.close()` 關不掉
非 script 開啟的分頁），因此必須自行攔截並顯示明確錯誤畫面。

---

## 9. 驗收層次與測試

11 支零依賴的 CDP harness（驅動本機 Chrome，不需要 Playwright）＋一套 `node:test`：

| 層 | 指令 | 項目數 | 涵蓋 |
|---|---|---|---|
| 單元 | `cd packages/server && npm test` | 254 | fs API、conflict、auth、consent、files/`/v/*`、watch token、proxy（含 DNS 硬化）、plugins、static、PUT 串流 |
| 1 | `node tools/spike-check.mjs --vault <複本>` | 10 | boot、無 installer 更新對話框、完整載入（檔案數與磁碟可見數相符）、metadata cache、文字往返、二進位往返、冷啟、workspace 隔離、零例外、良性錯誤不蓋畫面 |
| 2 | `node tools/hotreload-check.mjs` | 4 | WS 連線、筆記外部變更、plugin 熱重載、回音過濾 |
| 3 | `node tools/attachment-check.mjs` | 全部 | `/v/*` URL 形狀、位元組一致、瀏覽器實際解碼、Range、pdfjs、編碼檔名 |
| 4 | `node tools/popout-check.mjs` | 10 | popout 開啟、同一 app 物件、指定筆記、獨立寫入、真實鍵盤輸入、deep link、**重新載入後還原** |
| 5 | `node tools/menu-check.mjs` | 8 | 選單列、render-menu、子選單、狀態同步、appCommand 執行、右鍵選單、Move to new window |
| 6 | `node tools/print-check.mjs` | 21 | 只印筆記、PDF bytes、狀態還原、manifest、service worker、桌面／平板／手機寬度、平板開機版面 |
| 7 | `node tools/dialog-check.mjs` | 14 | `remote.dialog`、FSA／合成路徑、Export to PDF 全鏈路、二次匯出狀態還原 |
| 8 | `node tools/plugin-install-check.mjs` | 6 | **真實網路**：Browse（popout）→ 搜尋 → Install → Enable → Disable → Uninstall，含完整 proxy/fs 請求清單 |
| 9 | `node tools/notices-check.mjs` | 10 | 三等級樣式、dedupe、自動消失、conflict（兩條路徑、單卡、點擊真的開副本）、外掛失敗合併 |
| 10 | `node tools/resilience-check.mjs` | 8 | 後端重啟：離線偵測（<5s）、寫入明確失敗、離線期間新增檔案、重連（<15s）、reconcile、恢復儲存 |
| 11 | `node tools/parity-check.mjs` | 8 | popout realm 的 runtime 腳本、避開雙實例、popout 匯出印自己的筆記、host 不受影響、popout 右鍵選單 |

**全部只對 實測 vault 的複本執行**，真實 vault 從未被寫入。

效能門檻（實測）：10,150 檔 / 341 MB，冷啟 **≈ 510 ms**；全 vault 掃描 + metadata cache ≈ 1 秒。

> 教訓（已修）：`spike-check` 的 workspace 檢查原本在 boot 後 ~2 秒取樣，而 Obsidian 的
> layout 存檔 debounce 到 ~4.4 秒才落盤，造成三個工作流各自踩到偶發的 7/8。現在改成
> 等待檔案出現（上限 15 秒）再判定。

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

驗收對象是 實測 vault 的複本（10,150 檔、341 MB），**不是真實 vault**。
執行方式：`node tools/spike-check.mjs --vault <複本路徑>`（零依賴，用 Node 內建 WebSocket 驅動本機 Chrome 的 CDP）。

> 上表的 `> 5000` 是 2026-10-18 對大型 vault 的歷史紀錄。現行 harness 已改為
> 與「磁碟可見檔案數」對照，不依賴 vault 規模，見 §11.18。

---

## 11. 實作期間發現的設計知識（必須保留）

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

對實測 vault 的 16 個已啟用 plugin：**載入 14 個**。
唯二未載入的是 `vault-feed-reader` 與 `geo-story-map`，兩者都 `require("node:child_process")` ——
這是早期「匯入即拒絕」規則的結果；2026-10-24 已細分匯入與執行（§11.25）。
舊盤點只計實例，還會漏掉 Templater 保留實例的 onload 失敗（§11.21）；新結果見 `PLUGINS.md`。

### 11.7 附件路徑 `/v/*` 的首次實測 —— 兩個原因疊在一起

兩輪 spike 的 `/v/*` 請求數都是 0。第一個原因是測試從沒渲染過含附件的筆記
（`spike-check.mjs` 只驗文字與 `writeBinary`，走 `/api/fs`）。**第二個才是決定性的**：

`FileSystemAdapter` 的 `resourcePathPrefix` 來自 `sendSync("file-url")`，
而 shim 的 handler 回傳 `resourcesPath`（`/obsidian`）。於是每個附件 URL 都長成
`/obsidianprivate/var/…/image.png`，被 `/obsidian/*` 靜態路由接走 → 404。
**請求永遠到不了 `/v/*`。** 修掉那一行（`boot.resourcePrefix || "/v/"`）之後，
`tools/attachment-check.mjs` 從 1/10 變成全數通過，`/v/` 請求從 5（全 404）變成 39（全 200）。

同一輪實測確認的三件事：

- URL 是**逐段 percent-encode**（由 shim 的 `url.pathToFileURL` 決定）；
  server 端**不得再解碼一次** —— 多解一次會讓檔名含 `%XX` 的檔案回傳錯誤的位元組（HTTP 200）。
- `Range` 必須三態：看不懂的 range set 要忽略回 200，只有落在檔案外才 416。
- `.md` 必須給 `text/markdown; charset=utf-8`，否則瀏覽器會下載而不是顯示。

### 11.8 多視窗 popout：不是第二個 app，是同一個 app 的第二個 DOM 表面

我原先的假設（「popout = 二次載入 `/`，跨視窗只能靠檔案 + watch 同步」）**是錯的**。
REA 顯示 Obsidian 的做法是：

```js
const s = window.open("about:blank", "_blank", "popup,width=…,height=…,background=…");
s.document.head.appendChild(createEl("base", {href: location.href}));
c.app = t.app;                    // ← 同一個 app 物件，同一個 renderer heap
```

同源的初始 `about:blank` document 由母視窗的 renderer 直接寫入，新視窗拿到的是
**母視窗的 `app` 物件本體**，不是複本。狀態共享是物件共享，不是 IPC、也不是檔案輪詢。

因此「二次載入 `/`」在架構上是錯的：那會產生第二個 app 實例（第二次 vault 掃描、
第二個 metadata worker、兩份 plugin onload、兩個 `workspace-server.json` 寫入者），
與 §2 的單一寫入者原則直接衝突。正確做法是沿用 Obsidian 自己的機制，只補 popout realm 缺的 shim。

**還有一個 Chromium 專屬陷阱**：Electron 的 feature 字串不能直接轉發。
`window.open(…, "popup,background=#202020")` 在 Chromium 回 `null`（即使允許彈窗），
必須由宿主扮演 Obsidian `main.js` 的 roles 解析，翻譯成 `popup,width,height[,left,top]`。

實測能力邊界：popout 可用時間 3–42 ms、顯示指定筆記 31–153 ms；樣式同步（同一份 `app.css`）。
**開機自動還原仍受瀏覽器手勢限制**：`loadLayout()` 在 boot 時呼叫 `window.open`，一定被擋。
runtime 現在會把上次成功開啟的 popout 路徑存進 localStorage（每個 vault 一組），
重新載入後提供一個明確的「還原上個視窗 (N)」提示條；一次點擊開一個，
因為 Chrome 會把同一手勢的第二個 `window.open()` 當成 unsolicited popup。
`check:popout` 10/10 覆蓋這條路徑。分頁右鍵的
`Move to new window` 已可用：`nativeMenus: false` 時由 Obsidian 自己畫 HTML 選單；
未設定時（macOS 預設 true）由 runtime 的 `Menu.popup()` fallback 接手（§11.9）。

### 11.9 選單：三件不同的事，不要混在一起

1. **應用選單列**（File / Edit / View…）由 renderer 的 `AppMenuBarManager` 建 template，
   用 `ipcRenderer.send("set-menu", { template })` 送到 main。瀏覽器沒有原生 menubar，
   所以由 `packages/runtime/menu.js` 自繪。template 的 `before` 是給 desktop main process
   合併預設選單用的標記，自繪時忽略；`&` 是 mnemonic，`&&` 是字面 `&`。
2. **右鍵選單**由 renderer 自己建，顯示層有兩條路：`Menu.useNativeMenu === false` 時
   renderer 直接畫 HTML；`true` 時呼叫 `remote.Menu.buildFromTemplate(t).popup()`，
   由 runtime 畫成 HTML。`useNativeMenu` 來自 `getConfig("nativeMenus")`，macOS 且值為
   `null` 時視為 `true`。
   **1.14.4 的 `nativeMenus` 存在 `.obsidian/appearance.json`**（寫在 `app.json` 會被遷移），
   設 `false` 可讓所有 context menu 回到 Obsidian 自己的 HTML 版本，是建議設定。
3. **`context-menu` 是 request/reply，不是選單本身。** 編輯區右鍵時 renderer 先送空請求，
   等宿主回 `{ editFlags, misspelledWord, dictionarySuggestions, webContentsId }`。
   **回 `null` 時 renderer 直接放棄整個選單** —— 這才是「右鍵完全沒選單」的真正原因，
   與 `nativeMenus` 無關。

**實作邊界**

- `set-menu` / `update-menu-items` / `render-menu` 在 Electron 是 renderer → main 的單向頻道，
  **沒有回覆**；runtime 不能用 `ipcRenderer.on()` 等它們，必須由 shim 直接呼叫。
- `appCommand` 項目在 desktop main.js 會被改寫成 `id = appCommand` + `click()` 內執行
  `app.commands.executeCommandById(...)`；瀏覽器直接呼叫後者。
- accelerator 只顯示、不綁定（Obsidian 的 keymap 仍是唯一來源）。
- 選單列缺少 main-process 預設項目（About / Quit / undo / redo / cut / copy / paste / select all），
  因為它們不在 renderer 送出的 template 裡。右鍵選單的剪貼簿項目不受影響。

### 11.10 列印：`app.css` 的 `@media print` 會把整個 app 隱藏

`vendor/obsidian/app.css` 內建：

```css
@media print {
  .app-container { display: none !important; }
  body > :not(.print) { display: none !important; }
}
```

所以「只加一段顯示 active leaf 的 print CSS」會印出**空白頁**。
實測：leaf-only CSS 產生的 PDF 只有 **1,087 bytes**；把 active view 搬進 body 層級的
`div.print`（Obsidian 自己的 Export-to-PDF 也是這個結構）後，同一份筆記是
**54,411 bytes / 1 page**。

因此 `print.js` 的 `beginPrintView()` 會移動 view、`endPrintView()` 搬回原位，
並處理瀏覽器的 `beforeprint` / `afterprint`。

**兩個已知限制**：Obsidian 內建的「Export to PDF」命令仍走 `remote.dialog.showSaveDialog`，
shim 回 `{canceled:true}`，所以那條路徑到不了列印；popout 視窗沒有載入 `print.js`。

**Export to PDF 已接通（2026-10-18）**：`showSaveDialog` 在支援 File System Access API 且是
PDF 儲存時使用 `showSaveFilePicker`（`filePath` 只有 `handle.name`，該 API 不揭露目錄），
否則回 `"<browser-print-dialog>"` 合成路徑讓流程繼續；**非 PDF 存檔一律回 `canceled:true`**
（回合成相對路徑會讓呼叫端把垃圾檔寫進 vault root）。
Obsidian 用來預覽的 `window.open("about:blank", "_blank", "popup,hide=true")` 由 `print.js`
換成**畫面外的同源 iframe**，因此不會多一個空白彈窗，也不會被彈窗阻擋。

實測：`File → Export to PDF` 全鏈路完成，`Page.printToPDF` 產出 768,366 bytes / 12 頁的
真 PDF；連續匯出兩次狀態都正確還原。`tools/dialog-check.mjs` 14/14。

**仍有限制**：(1) app 永遠不寫入 `filepath`，PDF 只能靠列印對話框落地；(2) 無法分辨使用者
是取消或列印，`printed:true` 只代表流程已開啟；(3) Export modal 的 pageSize／landscape／
margins 不套用（由瀏覽器列印分頁取代）；(4) popout realm 未載入 `print.js`，
其 `print-to-pdf` 由 shim 沿 `__MYOBS_POPOUT_WINDOW.host` 委派回宿主頁（上限 4 層），
但會印宿主頁的 active view。

### 11.11 `Platform` 不在 `window` 上

`typeof Platform` 在原始 bundle 是 `undefined`；`app.js` 沒有 `window.Platform = …`。
唯一入口是 webpack 的 export getter `Platform: () => Qy`，而且 getter 定義時 `Qy` 尚未賦值
（實測在 `Object.defineProperty` 當下呼叫 getter 得到 `undefined`）。

`platform-bridge.js` 因此用三層：`Object.defineProperty(window, "Platform", …)` 攔截、
包住 `Object.defineProperty` 觀察 export getter、`queueMicrotask` 後重讀。

**只改 `isPhone` / `isTablet`**，不改 `canDisplayRibbon` / `canSplit` / `canStackTabs` ——
那三個在 bundle 裡是 `!isPhone` 的 getter，直接改寫等於複製一份 bundle 邏輯，版本一改就漂移。

**版面門檻是 600px，不是 768px。** 桌機與平板是支援目標，手機不是：
`>= 600px` 完全不覆寫（Obsidian 自己決定桌面或平板版面），
`< 600px` 才套 `isPhone` fallback，讓極窄視窗仍可用。
實測 820×1180 時 `isPhone=false`、`canDisplayRibbon/canSplit/canStackTabs` 都是 `true`；
480×900 才是 phone fallback。`check:print` 以 1280／820／480 三段驗收。

還原時用「套用前快照」而不是重新用 media query 計算：實測 1280×900 時
`Platform.isTablet` 是 `false`，而 Obsidian 自己的 600×600 query 是 `matches: true`，
重算會多套一個原本不存在的 `is-tablet`。

### 11.12 社群外掛的 Browse：CORS 只是部分原因，真正的路徑不是我們想的

**修正一個我先前的錯誤結論。** 實測（2026-10-18）：

- `raw.githubusercontent.com` **有**送 `access-control-allow-origin: *`。
- `github.com` 的 release 下載**沒有**。

所以清單抓取其實不會被 CORS 擋；會被擋的是 release 資產下載。我們仍然統一走 `/api/proxy`，
避免依賴上游的 CORS 政策變動。

**真實使用者路徑（完整觀測，不是推論）**

```
Settings → Community plugins → Browse
  → window.open(...) 開 popout（CommunityPluginModal.getPopoutOptions）
  → GET /api/proxy?url=…/community-plugins.json        200（9,097 筆）
  → GET /api/proxy?url=…/community-plugin-stats.json   200
按 Install
  → GET /api/proxy?url=https://github.com/<repo>/releases/download/<tag>/manifest.json   200
  → GET /api/proxy?url=…/main.js                                                        200
  → GET /api/proxy?url=…/styles.css                                                     200
     （proxy 在 server 端逐跳跟隨 302 → release-assets.githubusercontent.com）
  → POST /api/fs { op:"access" }  .obsidian/plugins
  → POST /api/fs { op:"mkdir" }   .obsidian/plugins/<id>
  → POST /api/fs { op:"write" }   manifest.json / main.js / styles.css   ← adapter.write，不是 writeBinary
Enable → app.plugins.enablePluginAndSave → 寫 community-plugins.json → require(main.js)
Uninstall → adapter.rmdir(dir, true) → /api/fs { op:"rmdir" }   ← 直接刪除，不進 .trash
```

**三個必須記住的結論**

1. **UI 完全不呼叫 `/api/plugins/*`。** 實測 `serverPluginCalls: []`。
   `POST /api/plugins/install`（含 digest 驗證與 temp+rename）是**程式化路徑**，保留給自動化與庫存，
   兩條路徑不要混用。
2. **Browse 開在 popout 裡**，所以 popout（§11.8）是外掛安裝的**必要條件**，不是加分項。
   任何自動化測試都必須 attach 到 popout target，主視窗只是空殼。
3. **UI 路徑的安全性是 Obsidian 自己的**：逐檔寫入、**無 digest 驗證、非原子**；
   卸載直接 `rmdir`、**不進 `.trash`**。這些是它的行為，我們沒有 patch。
   server 端點是我們能提供較強保證的那條（原子替換、digest、`.trash` 可復原）。

**已知 fallback**：Obsidian 的 `QS()` 在 github/raw 失敗時會改打
`https://releases.obsidian.md/proxy?url=…`。該 host 不在 allowlist，成功路徑不會用到；
但 proxy 失敗時 fallback 會變瀏覽器直連並可能 CORS 失敗。列為決策點，尚未處理。

### 11.13 後端重啟：先觀察，才發現症狀與我原本的假設相反

我原本的假設是「斷線時 Obsidian 的 UI 看不出來，所以要自己做提示」。**實測推翻了一半：**

- **編輯器打字後存檔失敗**：Obsidian **自己會**跳 notice
  （`Failed to save file "…". … Make a backup of the contents of this file now to avoid losing data.`），
  而且 dirty 狀態正確保留（`view.lastSavedData !== editor.getValue()`）。
  **但同一個 rejection 沒有 handler，被 `index.html` 的 `unhandledrejection` 攔截器變成全螢幕
  fatal overlay，把整個 app 蓋住。** 真正的症狀不是「沒有訊息」，是「有訊息但被我們自己的錯誤畫面吃掉」。
- **直接呼叫 `app.vault.modify()`**：完全靜默 —— Promise reject `EIO`，
  零 UI 訊息、零 console、零 unhandled rejection，磁碟不變。

**重連後不會自動補狀態**：WS 由 watch-shim 退避重連（實測第 4.1 秒），
但**檔案列表不會更新** —— 離線期間從磁碟新增的檔案，重連 +4 秒後在 `app.vault.getFiles()` 仍然是 0。

**選用 `FileSystemAdapter.reconcileFile`，不用 `listAll()`**（bundle offset 565222）：

```js
listAll() { this.files = {}; return this.listRecursive(""); }   // ← 先清空
```

`listAll()` 會把 `files` 清空再重走一次目錄樹，於是每個既有檔案都變成 `file-created`；
`Vault.onChange` 對 `file-created` 不檢查既有節點，會把第二個 abstract file 塞進同一資料夾 →
**重複節點、樹狀結構損壞**。`adapter.watch()` 內部也是 `listAll()`，同樣不可用。

因此實作改為自己走訪目錄、以 mtime/size 比對 `adapter.files`，
只對新增／變更的路徑呼叫 `reconcileFile`，刪除在完整走訪成功後才處理
（走訪失敗絕不誤判為刪除），hidden 路徑依 bundle 的 `Al()` 規則跳過。
成本：10,036 檔 / **4.2 秒** / 併發 8。

**離線閘門**：已知離線時所有變更類 op 在 shim 直接以 `EOFFLINE` 拒絕，**不排隊、不重試**
（寫入帶 `ifMtimeMs`，盲目重試會產生假衝突或覆蓋）。讀取只在網路層失敗時重試一次。
錯誤訊息固定含「後端中斷，這次修改沒有存到磁碟」。

**fatal overlay 抑制**：只針對寫入類的 `EOFFLINE` / `ECONNREFUSED` unhandled rejection，
記錄為 `fatal-suppressed`。讀取與啟動錯誤仍然顯示 fatal。

#### 11.13.1 probe 逾時不可直接判定離線（實作後才發現的產品缺陷）

第一版的健康探測是 `HEAD /?myobs-probe=…`，2.5 秒 `AbortController` 逾時，
**一次失敗就 `markOffline`**。這在負載下會誤判：冷啟要發 19,000+ 個 fs 請求、
匯出要渲染 700 KB 的 PDF，探測就會逾時 —— 於是使用者的存檔被 `EOFFLINE` 擋掉，
並被告知「這次修改沒有存到磁碟」，而伺服器從頭到尾都是健康的。

實際觀測到：`attachment-check` 在負載下看到 **4 次被 abort 的 probe**。

修正：**連續 2 次探測失敗**才關閘門，逾時放寬到 5 秒。實測離線偵測從 0.86 秒變成 **1.88 秒**
（驗收門檻 5 秒，仍有餘裕），而負載下的誤判消失。

> 三個獨立工作流各自踩到這件事：`attachment-check` 把它算成網路失敗（已排除 probe URL，
> 並順手修掉「用 lastRequestUrl 歸因失敗請求」的錯誤 —— 要用 `requestId` 對應）。

### 11.14 通知層：一次失敗一張卡，而且按鈕不能製造垃圾

- 三個等級各有相異的 computed border；`info` 8 秒、`warn` 20 秒、`error` 不自動消失。
- **同 `dedupeKey` 合併累加 count**，不疊卡。一次 conflict 只產生一張卡（count 1）：
  `fs-shim` 是主要 producer，`notices.js` 的 `__MYOBS_LAST_CONFLICT` bridge 只在其缺席時補卡
  （同 key 已存在則記 `conflict-delegated`）。
- **boot 期外掛失敗用狀態差集偵測**（`enabledPlugins − plugins`），**不 patch `console.error`**
  —— 那太脆弱且會把除錯訊息變成 UI 噪音。
  當時的盲區是 `onload` 失敗仍留實例；2026-10-24 已以 enablePlugin outcome observer 補齊（§11.21）。
- **`workspace.openLinkText()` 不可用來開檔案**：連結目標尚未進入 vault index 時
  （conflict 副本只有約 1 秒大），它會 fall through 到 `fileManager.createNewFile()`，
  在 vault 裡種出 **0 byte 筆記** —— 按下「顯示保留的舊版本」反而製造垃圾檔。
  必須用 `getAbstractFileByPath` / `getFirstLinkpathDest` 解析後 `leaf.openFile()`，
  找不到就誠實說找不到。這個 bug 在 stress 中被 `copiesOnDisk` 掃描抓到。

### 11.15 良性 `ResizeObserver` 錯誤會變成全螢幕 fatal

`index.html` 的 global `error` handler 原本把所有 `error` 事件都當成 boot 失敗。
Chrome 156 在 layout 時會送出：

```
ResizeObserver loop completed with undelivered notifications.
```

這是良性警告，但 handler 會開全螢幕 fatal overlay，後續點擊（例如 `#popout=` 的
「開啟」按鈕）全部被蓋住。`tools/popout-check.mjs` 在乾淨 workspace 下重現 3/4 次失敗，
fatal detail 就是這一句。

修正：`isBenignError()` 過濾 `ResizeObserver loop limit exceeded` 與
`ResizeObserver loop completed with undelivered notifications`；`spike-check`
新增第 9 項斷言，主動 dispatch 這個 `ErrorEvent` 並要求 fatal 不可出現。
原則是：**boot 期的錯誤才全螢幕；layout 噪音只進 console。**

### 11.16 harness 的 vault 守門與隔離

兩個獨立的問題在同一天一起爆開：

1. **守門預設路徑是錯的。** 所有 harness 原本預設一個不存在的
   `$HOME/vault`，但實際 vault 可能在 `$HOME/Sync/vault`，而 `$HOME/Sync`
   本身也可以是 vault。預設值不存在，等於沒有守門；而且各 harness 有些只比對等值、
   有些比對前綴。
2. **共用一份複本會交叉汙染。** `attachment-check` 留下 `_attach*` fixture，
   `menu-check` 改 `appearance.json`，每支都留 `.obsidian/workspace-server.json`。
   照 `HANDOFF.md` 的單一 `$DEST` 連跑，`menu` 會變 7/8（筆記停在閱讀模式）、
   `popout` 鍵盤輸入失敗、`parity` 會選到同名 fixture 而開錯筆記。

修正：

- `tools/lib/cdp.mjs` 的 `liveVaultPath()` **fail-closed**：`MYOBS_LIVE_VAULT`
  未設定就拒絕執行；`assertNotLiveVault()` 同時拒絕 live vault 的父目錄與子目錄，
  並用 `realpath` 比對。
- `startServer()` 對每個 vault 的第一次啟動清除 `workspace-server.json` /
  `workspace-mobile.json`；resilience 的第二次啟動不清，保留它要測的 client state。
- 驗收流程改為**每支 harness 一份乾淨複本**（README §驗收、HANDOFF）。

### 11.17 Chrome 的 `chrome://settings/help` 會搶走 about:blank popout

`window.open("about:blank", …)` 開出的 popout 在 Chrome 156 上偶爾會被 Chrome
自己的 About 頁導航，target 仍然是同一個 targetId，但文件已不是 Obsidian。
`parity-check` 的右鍵選單因此找不到 `.myobs-menu-panel`。這是瀏覽器環境行為，
不是 renderer 導航。

修正：`launchChrome()` 加 `--disable-component-update`、
`--disable-background-networking`、`--disable-features=ChromeWhatsNewUI,…`；
`listPageTargets()` 過濾 `chrome://` / `devtools://` / `edge://` target。
若未來 Chrome 改行為，先檢查 harness 的 target 清單，不要先懷疑 popout 實作。

### 11.18 驗收門檻不能綁死 vault 規模

`spike-check` 原本用 `app.vault.getFiles().length > 5000` 當「完整掃描」的證據。
那是 2026-10-18 對 10,034 篇 markdown 的實測 vault 寫下的數字，不是需求。
換到只有 3,096 個 md（3,396 個可見檔案）的 vault 後，其餘 8 項全綠、只有這一項失敗：
看起來像 renderer 壞了，實際上是測試資料比門檻小。

修正：Node 端遞迴數「任何路徑段不以 `.` 開頭」的檔案（Obsidian 的 hidden 規則，§11.13），
與 `app.vault.getFiles().length` 對照，斷言前者 `>=` 磁碟可見數。
facts 同時保留 `diskFileCount`、`fileCountAtBoot`、`fileCountAfterCacheWait`，
失敗時可以直接分辨「掃描沒完成」與「vault 本來就比較小」。

> 教訓：驗收條件要描述「行為正確」，不是「我當時的 vault 有多大」。
> 固定門檻會隨測試資料漂移，失敗訊息還會誤導下一個 agent 去修一個沒壞的 renderer。

### 11.19 popout 的 `leaf.openFile()` 完成早於 view 置換

`parity-check` 原本在 `await leaf.openFile(...)` 後固定等 600ms，再掃 popout leaf 的
`view.file.path`。冷啟動或第一次載入該筆記時，600ms 不夠：leaf 仍顯示 host 的筆記，
`paths` 只有 `scripts/README.md`。同一支 harness 第一次通過、第二次失敗（3,396 檔的 vault），
很容易被誤判成 popout 壞了。

`openFile()` 的 promise 只代表 workspace 接受請求；view 置換是之後的事件。
修正：Node 端每 250ms 輪詢 popout leaves，直到目標路徑出現（上限 20 秒），
失敗才回報最後的 `paths` 與 `activePath`。

> 教訓：對 Obsidian workspace 的斷言要等「狀態成立」，不要等「大概夠久」。
> 固定 sleep 在快機器上透過、在冷 cache 上失敗，是最難重現的那種 flaky。

### 11.20 `update` IPC 回傳桌面版的 installer 狀態會跳出假更新視窗

桌面版 main process 的 `update` 預設是空字串，只有 updater 真的判定需要重裝 installer 時
才設 `"update-manual-required"`。shim 原本無條件回這個值，於是 Obsidian 在 boot 後
（以及每小時的 interval）顯示「Update Available / manually download and reinstall Obsidian」。
瀏覽器 runtime 根本沒有 installer，這個視窗對使用者是純噪音，也會讓人以為服務壞了。

修正：`update` 回 `""`，並補上 `disable-update → true`；後者同時關掉 boot 時的
`ex(hw, moe)` 版本分支與 About 頁的 updater 開關，讓兩條路徑都不會再提示更新。

> 教訓：shim 的 stub 不要借用「會改變 UI 狀態」的桌面值；選 main process 的預設值
> （沒有副作用的那個），而不是選一個看起來「有處理」的狀態。


### 11.21 外掛實例存在，不代表 onload 成功

官方 1.14.4 在 await `instance.load()` 前就寫入 `plugins[id]`；`_loaded` 也早於
`onload` 完成。`enablePlugin` 捕捉失敗後回 `false`，因此須觀察其結果，不能只計算
`enabledPlugins − plugins`。runtime 在 app 與 plugin manager 建立時接入 observer，
保留回傳結果與例外；成功重載會清除舊失敗。真正的首輪 boot 必須用 renderer 驗證，
VM 模擬若預先建立 manager 會漏掉官方的非同步初始化時序。

同 id 的外部事件與手動重載也必須共用佇列；debounce 無法防止慢 onload 期間的第二次 reload。
執行中事件合併為一次尾隨重載，開始前重新檢查 watch 開關與設定頁。
`disablePlugin(id, true)` 的 true 代表使用者停用（傳給 `_userDisabled`）；
熱重載應用 `disablePlugin(id)`，enabled 集合僅由 `disablePluginAndSave` 修改。
若官方吞掉 onunload 例外後仍留著實例，停止後續 enable 並通知使用者。

### 11.22 L2 相容性要測資料語意

Kanban 實際依賴 `fs/promises`；只提供 `fs.promises` 物件不足，require 也要解析子路徑。
`require.resolve` 與 `require` 共用別名及拒絕規則，否則外掛的 feature detection 會失真。
`fs.readFile` 未指定 encoding 必須回 Buffer；Uint8Array 的 `.toString()` 會回逗號數字，
造成外掛解析失敗。原 Buffer UInt16／UInt32 LE/BE 讀取端序相反，僅測檔案位元組往返不足以辨識；
測試以 Node 的已知值對照。callback fs 與 Promise 共用同一傳輸層，維持 vault 限制與離線拒寫。

### 11.23 安裝替換與回滾需要共同序列化

兩次 rename 不是完整交易；同 id 的 install/install 或 install/uninstall 可以踩到彼此的目錄。
程式化端點以 id 排序磁碟修改，下載仍並行；不同 id 不互阻。此鎖不涵蓋 `/api/fs` 或外部程序。
復原舊目錄失敗不能吞掉，須回 `EROLLBACK` 並留下備份位置。
`data.json` 若非一般檔案應拒絕更新，不能略過複製後刪掉唯一資料。

### 11.24 本機 watcher 上限會擋住 server 就緒

2026-10-24 複本初始掃描碰到 `EMFILE`，server 等 `watcher.ready` 而未 listen，
harness 只看到 readiness timeout。驗收改用 `CHOKIDAR_USEPOLLING=1`，複本排除網站產物 `build/`；
真實 vault 未改動。polling 有額外掃描成本，應只在原生 watcher 額度不足時設定。
server readiness 的錯誤傳播與 harness 啟動失敗清理仍列入 TODO。

### 11.25 匯入子程序模組不等於需要執行 shell

Templater 2.26.0 在建構時 require 並 promisify(exec)；Geo Story Map 0.5.1、
Vault Feed Reader 0.6.1 在 bundle 頂層 require，真正呼叫只在可選的系統命令／本機 AI 功能。
若 require 就拒絕，與 shell 無關的功能也無法初始化。

`child_process` facade 因此只允許匯入；所有程序入口立即拋具名錯誤，不讀取命令或環境參數、
不呼叫 callback、不回傳假的 ChildProcess 或成功輸出，也沒有 server 執行端點。
一般呼叫與 util.promisify 的拒絕都要驗收；UI 通知失敗不得改變拒絕結果。
Templater 用真模板驗證 system command 被拒絕且沒有磁碟副作用；Geo／Feed 用真外掛功能驗收，
本機 AI 可能先被執行檔探測拒絕，不可把該錯誤宣稱為已測到 spawn。

### 11.26 外掛初始化完成不代表筆記索引完成

`boot-scan` 記錄的是外掛載入結果，不代表 metadata cache 或特定筆記已備妥。
Templater 的 fileManager.renameFile 在索引前可能等待不結束；Geo 的 noteFolder 在目標筆記
frontmatter 尚未可讀時會顯示 no slides。harness 必須等對應資料就緒，再驗功能。
Geo 的 full 模式會刻意移除筆記標題，應驗完整內文，不以 h2 是否存在判定成敗。

### 11.27 Feed Reader 的缺訂閱檔狀態不能用全域啟動延遲修補

官方順序是 await plugins.initialize（逐個 await enablePlugin）→ vault.load →
metadataCache.initialize → workspace.loadLayout。因此 enablePlugin 等待 metadata 會 deadlock。
Feed Reader 0.6.1 在 onload 的 persistIdentities 以 getAbstractFileByPath 查父層，
尚未索引時嘗試 createFolder；若資料夾磁碟已存在，adapter.exists 正確回 true 並拒絕建立，
外掛因此切成唯讀。不是 fs.exists 的布林語意錯誤，不應吞掉 EEXIST 或提前重掃整個 vault。

全新 root 可正常初始化；既有有效訂閱 YAML 可由初掃 create 事件觸發 reload 恢復。
「root 已存在、訂閱 YAML 缺失」沒有該事件，須在索引後從原設定的 Subscriptions YAML 按 Apply。
這條 UI 恢復路徑已實測，正式 harness 則使用全新 root，驗新建與既有訂閱重載兩條路徑。
尚未在原生 Obsidian 重現，不把同 renderer 的靜態推論寫成桌面版實測。

### 11.28 子選單關閉不能沿父子雙向引用遞迴

Kanban 2.0.51 的 Move to list 在真 UI 觸發 RangeError：closePanel(child) 呼叫
closeSubmenu(parentRow)，而 parentRow._myobsSubmenu 仍指向 child，形成無限遞迴。
menu guard 以 console.warn 捕捉錯誤，沒有 fatal，卻使關閉後才執行的移卡動作永遠到不了。

修正先切斷父列回指，再關閉子樹；移除父面板的失效 child 引用，取消所有列的 pending hover
（包含已隱藏的列），避免關閉後再長出子選單。callback 保持 close hook → action 的順序。
`check:menu` 用真 DOM 驗多層選取、ArrowLeft／Escape、切換兄弟選單與延遲 hover 清理；
`check:kanban` 再驗真卡片移動與磁碟 Markdown。驗收須收 menu warning，不能只查未捕捉例外。

### 11.29 功能驗收要等正確視圖與外掛索引

Tasks query 與 Kanban 看板開啟須等 workspace.layoutReady，否則 boot 的 loadLayout 可能在後面覆寫測試分頁。
Dataview 除 metadata cache 外還有自己的背景索引；只等 onload 不足。
Obsidian 可能保留編輯與閱讀兩份 DOM，查詢與 checkbox 應限定目標 leaf 的
.markdown-preview-view；Kanban 也只操作指定看板 view，不能全 document 計數。
選單在 popout 可能屬於另一個 document；以 popup 回傳面板的 ownerDocument 操作，
不要在主視窗搜尋實際顯示於子視窗的列。修改後等實際查詢結果，不以固定 sleep 當成功。

QuickAdd 2.32.1 的 fixture 必須遵循原設定語意：legacy prepend:true 對應 Bottom of file，
保留既有檔案使用 {kind:"apply",mode:"doNothing"}。錯誤設定會開互動 prompt，
不能把 CDP 等待逾時當成宿主寫檔失敗。

本機測試也要避開 fetch 的受限埠：server 4061 會讓 Chrome 使用 5061，/json/version
請求被 Node fetch 以 bad port 拒絕，即使 Chrome 已啟動。使用 4051／5051 等允許的組合；
啟動失敗仍須清理測試留下的程序，不能只等 readiness timeout。


### 11.30 路徑的近期寫入者不能代表下一個事件的來源

舊 registry 在 30 秒內替同路徑的每個事件附上最後寫入者 token。Dataview checkbox
寫回 Alpha 後，外部再改 Alpha，磁碟已更新但索引與畫面停在舊值；重新載入才恢復。
另有 browser 的同批同路徑推測，會連未標記事件與其他分頁事件一起略過。

只縮短 TTL 或消費第一個 token 都不安全：一次寫入可能產生跨批次 create/change；
外掛 onload 又寫 data.json 時，未標記的回音會造成無限重載。
修正保留同版本跨批次標記，以預期內容 SHA256 加寫後 metadata 判斷磁碟版本。
預期 hash 必須來自請求／來源；直接雜湊寫後讀回的內容，可能把搶先完成的外部寫入認作自己。
讀取採固定 descriptor、前後 stat 與路徑檢查；版本不符撤銷紀錄。
API 修改與 PUT commit 共用路徑佇列，watcher 等 commit 完成；串流上傳不長時間持鎖。
瀏覽器只能依每個事件的 token 過濾，不能再以相同路徑擴大範圍。

只對檔名使用 O_NOFOLLOW 不能擋住祖先目錄的 symlink；版本取樣須先經 vault
resolver，寫穿 symlink 時則同時記錄別名與實際目標，避免自己的回音漏標。
PUT 新增 commit 排隊後，也必須在出隊時重查連線；只在入隊前檢查會讓已中斷的
上傳仍覆蓋目的檔。獨立探針驗證既有越界路徑不開啟 hash descriptor，以及中斷保留舊內容。

提交前 review 再發現 resolver 完成後仍可替換祖先目錄：舊流程曾讀到 vault 外測試檔
21 bytes。現在 open 後先比對原 lstat 與 fstat，重新驗 canonical containment，再比對
路徑與 descriptor 身分，全部通過才讀內容；所有呼叫端強制傳 vault。三個測試涵蓋
resolver→lstat、lstat→open 與開啟外部檔後還原祖先的 ABA 情境，修正後越界讀取為 0。
這不是 openat/openat2 的原子目錄隔離，仍不把多步重驗宣稱為完整防禦惡意本機命名空間競態。

`check:dataview` 加入 checkbox 後十秒內外改同檔，要求 API 與實際查詢畫面更新。
`check:origin-echo` 用 onload 會 saveData 的測試外掛，驗跨批次自寫、外部 data/main
更新、重新登記 token 後再外改，以及重載／寫入次數停止增加。單元測試另涵蓋
等長內容並還原 mtime、無 token 與失敗請求、寫入競態；不同分頁事件由 shim 測試驗收。
兩個 renderer 持續互寫同檔仍屬多寫入者問題，不能把單一 writer 的回音收斂宣稱為協作支援。


### 11.31 vault 信任決定須在外掛初始化前提供

官方 PluginManager 在 initialize 時讀 `enable-plugin-<appId>`；null 顯示首次信任彈窗，
false 留在限制模式。等 app 建立後才設定會錯過首輪載入，刪掉 modal 也不代表外掛已載入。
本宿主的 vault IPC 以 boot.vaultId 建 appId，因此由 boot-data 在 app.js 前設定目前 key=true。
這是使用者要求的預設，每次 boot 覆寫 false；個別停用清單、policy 與程序拒絕仍保留。
`check:plugin-trust` 在全新 origin 監看 modal，驗首次 onload、false 後重載與停用外掛不載入。

### 11.32 宿主功能選單不能沿用全域 button 尺寸或占滿首列

舊 toolbar 高 28px，按鈕卻高 30px；一般主題還會加入 font／padding／shadow，讓它膨脹。
只限制父列高度不能隔離 button 樣式；改為限定宿主 selector 並重設控制項尺寸，
同時用 hidden＋fixed 浮層讓 app-container 保持完整視窗，不再覆寫 body 的 flex 排版。
窄寬度若只 display:none 會讓功能入口消失；保留 primary ribbon 按鈕與浮動 fallback。
官方實際使用 mod-primary／mod-secondary，不能假設 mod-left；觀察限於 shell，不監看編輯器子樹。

只檢查 bounds 也會漏掉互相覆蓋：最初 480px 浮層與入口疊在一起，Help 看得到卻點不到。
空間不足時向下展開，驗收同時檢查 elementFromPoint 與真點擊。Alt 單鍵判定須被其他鍵或
pointer/mousedown 取消，避免 Alt+click 後誤開。Escape 要回原本 editor 焦點，不能回已隱藏的 top item。
`check:menu` 用三寬度、全域 button 樣式、ribbon hide/show、鍵盤／焦點與 resize 驗上述行為。

本輪選單驗收也遇到 CDP 平台鍵碼陷阱：將 Windows keyCode 原樣複製到
nativeVirtualKeyCode，會讓 macOS Chrome 後續滑鼠回應延遲、resize 事件不再派送；
單獨 resize 正常，完整鍵盤序列卻失敗。保留 key／code／windowsVirtualKeyCode、
省略不正確的 native 欄位後，同順序四項檢查通過。驗收應等實際收合與 viewport 復原，
不能只等固定 sleep；Alt+click 的 DOM 取消判定另外重播，避免引入無關的瀏覽器原生手勢。
