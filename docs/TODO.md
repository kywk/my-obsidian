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
- [ ] **shim 缺口清單** — 彙整 `packages/shim/GAPS.md`（8 節）與兩個實作 agent 回報的未知
- [x] **契約歧義修正** — `termsText` 已補進 `CONTRACTS.md` §1；`stat.realpath` 已註明絕對路徑
- [ ] **未走到的路徑待補測** — `resourcePathPrefix` 產生的 `/v/*` 在 spike 中 0 次請求
      （沒有渲染任何含圖片的筆記）。圖片／影片／PDF 的 Range 與 URL 對應仍未實測。
- [ ] **`GAPS.md` 內 17 條未實作項** — 逐條決策：補實作或標為永久限制

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
