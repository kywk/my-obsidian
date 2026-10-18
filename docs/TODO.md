# TODO Tree

狀態：`[ ]` 未開始 `[~]` 進行中 `[x]` 完成 `[!]` 阻塞
每一項的驗收條件都要能自動或明確地檢查；無法檢查的不列進來。

---

## Phase 0 — 基礎（本次）

- [x] **設計訪談與決策固化** — `docs/DESIGN.md`
- [x] **介面契約** — `docs/CONTRACTS.md`
- [x] **專案規則** — `AGENTS.md`
- [x] **vendor 取得腳本** — `scripts/fetch-obsidian.mjs`
      驗收：368 檔解出、`app.js` 3,942,126 bytes、sha256 `958ce57f…a2df9`、二次執行輸出 `up to date`
- [x] **fs API 與 watcher** — `packages/server/**`（64/64 測試）
- [x] **瀏覽器 shim 層** — `packages/shim/**`、`packages/runtime/index.html`
- [x] **整合接線**
      `[x]` server 補 `GET /shim/*` 路由
      `[x]` `termsText` 注入鏈（`termsAccepted` 由 `termsText` 非空推導，修掉 `TERMS_ACK=1` 會卡死的陷阱）
      `[x]` `/obsidian/worker.js`、`/obsidian/sim.js`、`/lib/*`、`/favicon.ico` 可取得
- [x] **Spike 驗收 7/7 通過** — 冷啟 513 ms、10,034 篇 md、19,280 個 fs 請求 0 失敗
      詳見 `docs/DESIGN.md` §10、§11
- [x] **修正：傳輸層併發上限** — `fs-shim.js` 加 48 併發上限（原因見 `DESIGN.md` §11.1）
- [x] **修正：`/lib/*` alias** — Mermaid/PDF/Prism/MathJax/Slides（原因見 `DESIGN.md` §11.2）
- [x] **shim 缺口清單** — `packages/shim/GAPS.md`（8 節）＋ spike 與熱重載兩輪的發現
- [x] **契約歧義修正** — `termsText`、`policy`、`stat.realpath`、逐事件過濾都已回寫 `CONTRACTS.md`
- [x] **熱重載** — `watch-shim.js`（WS ↔ adapter `fs.watch`）、`plugin-watch.js`（plugin unload→load）
      驗收：`tools/hotreload-check.mjs` 4/4 通過（WS 連線、筆記外部變更、plugin 熱重載、回音過濾）
- [x] **修正：`policy: {}` 導致所有社群 plugin 靜默不載入** — 見 `DESIGN.md` §11.3
- [x] **修正：缺少 Node 全域 `Buffer`/`global`/`setImmediate`** — 見 `DESIGN.md` §11.5，
      `spike-check.mjs` 加入二進位往返為必要條件
- [x] **修正：`util`/`buffer`/`querystring` 未提供** — 見 `DESIGN.md` §11.4
- [x] **L2 覆蓋率基準** — 16 個已啟用 plugin 載入 14 個；`vault-feed-reader`、`geo-story-map`
      因 `node:child_process` 未載入（設計上的邊界，見 `DESIGN.md` §11.6）
- [x] **`terms` 同意畫面** — `GET /consent` + `POST /api/consent` + 原子寫入 config + **免重啟生效**
      驗收：未設定 → `/` 顯示同意頁且 `/obsidian/app.js` 403；POST 後（不重啟）→ 200 且可 boot
- [x] **附件路徑 `/v/*` 實測** — 59 個單元測試 + `tools/attachment-check.mjs`
- [x] **修正：`file-url` 回傳 `resourcesPath`** — 所有附件 URL 變成 `/obsidianprivate/var/…` → 404，
      `/v/*` 永遠 0 次請求。見 `DESIGN.md` §11.7
- [x] **修正：`/v/*` 路徑被解碼兩次** — 檔名含 `%XX` 時**靜默回傳錯誤檔案的位元組**（HTTP 200）
- [x] **修正：`/v/*` Range 語意** — 改成三態（忽略 / 416 / 206），並補 `.md` 的 Content-Type
- [x] **修正：回音過濾的跨批次破口** — token 改為 TTL 內保留；已用真 Chrome 重現舊語意的重載迴圈
- [x] **多視窗 popout** — 沿用 Obsidian 機制（同一 `app` 物件，非二次載入）；`tools/popout-check.mjs` 8/8。
      **機制與原假設不同，見 `DESIGN.md` §11.8**
- [x] **自繪選單列** — `menu.js` + `electron-shim` 選單 IPC；`Menu.popup()` HTML fallback。
      `Move to new window` 已可用（`DESIGN.md` §11.9、`tools/menu-check.mjs` 8/8）
- [x] **右鍵情境選單** — `context-menu` 回非 null 的 `editFlags`（回 null 時 renderer 直接放棄，這是原本完全沒選單的真因）
- [x] **列印／匯出 PDF** — `print.js`；必須搬進 `body > div.print`（`app.css` 的 `@media print` 會隱藏整個 app，
      只加 leaf CSS 會印出空白頁）。`tools/print-check.mjs` 19/19
- [x] **手機寬度降級** — `platform-bridge.js` 攔 webpack export getter 捕捉 `Platform`；
      < 768px 只改 `isPhone`/`isTablet`，>= 768px 完全不動
- [x] **PWA** — manifest + service worker（只快取靜態資產，vault 內容全排除）
- [x] **Plugin 安裝與更新** — `GET /api/proxy`（SSRF allowlist）+ `POST /api/plugins/install`
      （temp+rename、驗 digest、保留 data.json）+ `uninstall` → `.trash`
- [ ] **Obsidian 內建「Export to PDF」** — 仍被 `remote.dialog.showSaveDialog` 的 `{canceled:true}` 擋住，
      需另外包 dialog（`DESIGN.md` §11.10）
- [ ] **popout 的列印與選單列** — popout realm 沒載入 `print.js` / `menu.js`
- [ ] **`release-assets.githubusercontent.com`** — GitHub release 已改 redirect 到此 host，
      proxy allowlist 未含（installer 例外允許）；Obsidian Browse 直接抓時會 403
- [ ] **proxy DNS rebinding 防護** — 目前只驗 hostname，未在解析後檢查 IP
- [x] **後端斷線與重啟韌性** — `resilience.js` + `fs-shim` 的 `EOFFLINE`/`ECONNREFUSED` +
      重連後逐檔 reconcile（**不可用 `listAll()`**，會造成重複節點）。
      `tools/resilience-check.mjs` 8/8（`DESIGN.md` §11.13）
- [x] **修正：probe 單次逾時即判定離線** — 負載下會誤擋使用者存檔並謊報「沒有存到磁碟」。
      改為連續 2 次失敗、逾時 5 秒；離線偵測 1.88 秒（門檻 5 秒）。見 §11.13.1
- [x] **修正：fatal overlay 蓋掉 Obsidian 自己的存檔失敗訊息** — 症狀是「有訊息但被我們的錯誤畫面吃掉」
- [x] **使用者可見的失敗** — `notices.js`；一次 conflict 一張卡、boot 期外掛失敗用狀態差集、
      `tools/notices-check.mjs` 10/10（§11.14）
- [x] **修正：`workspace.openLinkText()` 會種出 0 byte 筆記** — conflict 副本尚未進索引時按「顯示舊版本」
      會 `createNewFile`。改用 `getAbstractFileByPath` + `leaf.openFile`
- [x] **popout realm 的 runtime 腳本** — 載入 notices/menu/print，排除 plugin-watch/watch-shim/
      platform-bridge/popout/resilience（各有理由）。`tools/parity-check.mjs` 8/8
- [x] **修正：從 popout 匯出會印到 host 的筆記** — Obsidian 用「建立該 function 的 realm」的
      `window.open`，PDF surface 落在 host；加 `installPdfSurfaceRouter()` 依 `window.activeDocument` 轉向
- [x] **proxy DNS rebinding 防護** — 每跳 `dns.lookup`、私有位址 403、不快取（TOCTOU-able，已記錄）
- [x] **PUT `/v/*` 串流化** — temp + rename 原子提升；64 MiB 上傳峰值 +34 MiB（原本整包 buffered）
- [ ] **`listAll()` 的損壞風險** — 目前只在 `resilience.js` 註解與文件記錄；若未來有程式碼呼叫它會壞樹
- [ ] **`templater` 類外掛的 boot 失敗偵測** — `onload` 在建構後拋錯者會留在 `plugins`，狀態差集看不到
- [ ] **`releases.obsidian.md` fallback** — 未加入 allowlist（決策點）
- [ ] **`GAPS.md` 內未實作項** — 逐條決策：補實作或標為永久限制

---

## Phase 1 — 可日常使用（編輯為主）

- [ ] **`terms` 同意畫面** — server 端 UI + config 持久化 + 未同意時的說明頁
      驗收：未設定 `TERMS_ACK` 時 `/` 顯示說明頁且 `/obsidian/app.js` 回 403；同意後可 boot
- [ ] **外部變更熱重載**
      `[ ]` plugin `main.js` / `manifest.json` → unload→load
      `[ ]` plugin `data.json` → 重載（設定頁編輯中則延後）
      `[ ]` `workspace.json` 隔離成 `workspace-server.json`（雙向驗證 Desktop 不受影響）
      驗收：`docs/DESIGN.md` §4 表格逐列成立
- [ ] **並行寫入保護** — `ifMtimeMs` + conflict copy + UI 提示
      驗收：模擬 Desktop 同時寫入 → 產生 conflict copy、原內容保留、UI 有提示
- [ ] **自繪選單列** — 接 `set-menu` / `update-menu-items` / `render-menu`
- [ ] **右鍵情境選單** — 接 `context-menu` IPC
- [ ] **列印／匯出 PDF** — `window.print()` + print CSS
- [ ] **附件 URL 與 Range** — `/v/*` 對圖片／影片／PDF 實測
- [ ] **手機寬度降級** — < 768px 走手機版面
- [ ] **Playwright smoke** — 對暫存 vault 複本自動跑 Phase 0 的五條驗收
- [ ] **Plugin 矩陣測試** — 對 20 個已安裝 plugin 斷言載入成功／拋錯，輸出覆蓋率數字

---

## Phase 2 — 對齊 Desktop 體驗

- [ ] **多視窗 popout** — `window.open()` + 二次載入 + 共用 WS session
      驗收：popout 視窗可獨立編輯同一檔並與主視窗同步
- [ ] **Plugin `require` 白名單完整化** — `path`/`os`/`util`/`url`/`crypto`/`buffer`、`fs` 讀寫分權、`electron` partial
      驗收：`kanban`、`auto-link-title`、`brat` 三個 plugin 完整功能可用
- [ ] **社群 plugin 安裝與更新** — server 端代理抓 GitHub release + checksum 驗證 + 第三方程式碼執行確認
- [ ] **`GAPS.md` 收斂** — 所有近似實作換成正確行為，或明確標為永久限制
- [ ] **效能** — `/api/bootstrap` 預載（冷啟優化，非必需）

---

## Phase 3 — 擴充保留項（架構已預留，不實作）

- [ ] 多 vault 路由 `/v/<vaultId>/`
- [ ] Per-session workspace（多使用者各自的版面狀態）
- [ ] 登入與權限（目前僅 `AUTH_TOKEN` 單一共用 token）
- [ ] 即時共編（變更序列、OT/CRDT）
- [ ] `templater` user scripts 的伺服器端受控執行（`child_process` capability bridge，需明確 allowlist）
- [ ] Server 跑在 vault 之外的機器（Maestral/Dropbox 在該端）

---

## 已知風險（定期回看）

| 風險 | 觸發條件 | 目前處置 |
|---|---|---|
| `terms` 閘的法律界線 | 服務開放給自己以外的人 | 同意畫面；文件明示需 Obsidian 明示同意 |
| Obsidian 版本升級破壞 shim | 官方發新版本 | 版本 sha256 記錄在 manifest；升級後重跑 Phase 0 驗收 |
| 非原子寫入撕裂 | Desktop 與瀏覽器同時寫同檔 | `awaitWriteFinish` + conflict copy |
| git index 衝突 | 服務寫入 + git 操作並行 | 服務不執行 git 指令；vault 已有 `dropbox-git-conflict-backup-*` 前例 |
| workspace.json 互踩 | Desktop 同時開 | fs 層路徑改寫隔離 |
| `app.js` 被意外修改 | 任何 patch | `AGENTS.md` 硬規則 1 + manifest sha256 比對 |
