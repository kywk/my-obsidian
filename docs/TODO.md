# TODO

狀態定義：`[x]` 完成且有驗收 `[ ]` 未完成 `[!]` 阻塞或需要決策

每一項的驗收都要能自動或明確檢查；無法檢查的不列進來。
「已完成」的細節與證據在 `DESIGN.md`，線路契約在 `CONTRACTS.md`。

---

## 接手順序

1. 讀 `AGENTS.md` 與 `docs/HANDOFF.md`，跑「5 分鐘最小接手」。
2. 從下面挑一個 `[ ]` 或 `[!]`；先確認它對應的 harness／驗收。
3. 改動前讀 `DESIGN.md` §11；動 fs/shim 前讀 `packages/shim/GAPS.md`。
4. 完成後同步：`DESIGN.md`（新陷阱）、`GAPS.md`（shim 落差）、本檔（狀態）、`HANDOFF.md`（數字）。

程式與驗收基準：`31891ec`（2026-10-24，外掛支援與版本化回音修正）——328 個單元測試、20 支 harness（229 項）。

---

## 現況

| 能力 | 狀態 | 驗收 |
|---|---|---|
| 官方 renderer boot（1.14.4） | `[x]` | `check:spike` 10/10 |
| 編輯／檔案樹／搜尋／圖譜／Canvas／命令面板 | `[x]` | 官方實作，隨 renderer 提供 |
| 社群外掛初始化（L2） | `[x]` | `audit:plugins`：15 個啟用，15 成功、0 失敗；完整功能未逐一驗收 |
| Kanban 卡片操作與子選單 | `[x]` | `check:kanban` 14/14；`check:menu` 多層關閉回歸 |
| Dataview 查詢與索引更新 | `[x]` | `check:dataview` 17/17；含瀏覽器寫入後立即外改同檔 |
| Tasks 更新與每日重複任務 | `[x]` | `check:tasks` 12/12 |
| QuickAdd Template／Capture 寫檔 | `[x]` | `check:quickadd` 14/14 |
| 外掛 lifecycle／L2 模組互通 | `[x]` | `check:plugin-support` 10/10；Node 對照與真 API 單測 |
| Templater 無 shell 模板／JS scripts | `[x]` | `check:templater` 12/12 |
| Geo Story Map 地圖／故事／筆記索引 | `[x]` | `check:geo-story-map` 12/12 |
| Vault Feed Reader 訂閱／閱讀／原文／持久化 | `[x]` | `check:vault-feed-reader` 13/13；冷啟限制見 `PLUGINS.md` |
| 社群外掛安裝／更新／卸載 | `[x]` | `check:plugin-install` 6/6（真實網路） |
| 外部變更熱重載 | `[x]` | `check:hotreload` 4/4 |
| 衝突副本 + 使用者可見通知 | `[x]` | `check:notices` 10/10 |
| 斷線偵測與重連補償 | `[x]` | `check:resilience` 8/8 |
| 多視窗 popout | `[x]` | `check:popout` 10/10（含重新載入後還原）、`check:parity` 8/8 |
| 選單列／右鍵選單 | `[x]` | `check:menu` 11/11 |
| 列印／Export to PDF | `[x]` | `check:print` 21/21、`check:dialog` 14/14 |
| 附件（圖片／PDF／Range／編碼檔名） | `[x]` | `check:attachment` 10/10 |
| PWA manifest + 靜態資產 SW | `[x]` | `check:print` |
| 桌面／平板版面 | `[x]` | `check:print`（1280 / 820 / 480px；>=600px 不降級） |
| 啟動器 + 環境檢查 | `[x]` | `npm run doctor` |
| 本地 dev mode（跳過同意畫面） | `[x]` | `--dev`／`DEV_MODE=1`；只允許 loopback；不寫 config |
| harness vault 守門與隔離 | `[x]` | fail-closed `MYOBS_LIVE_VAULT`；每支一份複本 |

---

## 需要決策

- [!] **`releases.obsidian.md` 要不要加入 proxy allowlist**
  Obsidian 在 github／raw 失敗時會改打 `https://releases.obsidian.md/proxy?url=…`（fallback）。
  目前不在 allowlist：成功路徑不會用到，但 proxy 失敗時 fallback 會變成瀏覽器直連並可能 CORS 失敗。
  加入的話要考慮「代理一個會再代理的端點」的 SSRF 風險。

- [!] **`child_process` 要不要開一條受控通道（L3）**
  目前允許匯入但拒絕程序執行。Templater 模板／JS user scripts、Geo 地圖、Feed 閱讀可用；
  system commands 與本機 AI CLI 仍不可用。
  開放等於把伺服器 shell 曝露給外掛，是這個專案最大的安全邊界變動。

- [!] **多 vault**
  路由 `/v/<vaultId>/` 已預留，但目前一次只服務一個 vault。
  要支援多 vault 需要先決定：隔離模型（同一 process 還是每 vault 一個）、設定來源、UI 入口。

- [!] **多使用者／登入**
  目前只有單一共用 token。真正的登入會牽動 session、per-user workspace、權限模型。
  在沒有共編需求前不建議做。

---

## 建議下一步

1. **逐外掛相容性**：以 `audit:plugins` 重跑初始化盤點，按 `PLUGINS.md` 的功能情境補驗收。
2. **真實 vault 的 dogfooding**：用複本實際使用一週，重點看社群外掛、附件、桌面版並寫 conflict。
3. **再決定 4 個決策**：目前建議維持 `child_process` 程序執行拒絕、多使用者暫緩；proxy fallback 與多 vault 等有明確需求再開。
4. **文件缺口**：`DESIGN.md` §11 與 `GAPS.md` 已同步到 baseline；下一輪有新陷阱就補，不要讓它們再次過期。

---

## 已知缺陷與限制

### 功能缺口（有明確觸發條件）

- [x] **popout 開機自動還原** —— 瀏覽器要求使用者手勢，無法全自動。
      已改為把上次成功的 popout 路徑存進 localStorage，重新載入後提供
      「還原上個視窗 (N)」提示條；一次點擊開一個（`check:popout` 10/10）。
- [ ] **popout 沒有頂部選單列** —— 右鍵選單可用（走主 realm 的 fallback），但 menubar 只在主視窗。
- [ ] **Export to PDF 的 modal 設定不套用** —— pageSize／landscape／margins／includeName／scale
      由瀏覽器列印分頁決定。
- [ ] **Service worker 不快取 `/`** —— 離線可以載入靜態資產，但不能離線開 app（刻意：boot 注入每次要重算）。
- [x] **平板／桌面寬度策略** —— >=600px 維持 Obsidian 原生桌面／平板版面（820px 已驗收）；
      <600px 才是手機 fallback（非支援目標）。跨門檻仍只改平台旗標，不重建既有的 workspace layout。

- [ ] **Feed Reader 0.6.1 不完整 root 冷啟唯讀** —— 資料夾存在但訂閱 YAML 缺失時，
      在原設定的 Subscriptions YAML 保留路徑按 Apply 可恢復；不改宿主全域啟動順序。
      外掛端應等索引或以 adapter 判斷父層，詳見 `DESIGN.md` §11.27。

### 偵測盲區

- [x] **`onload` 建構後失敗的通知盲區** —— runtime 觀察 enablePlugin 結果；
      真 renderer 驗收證明殘留實例可偵測，成功重載後通知清除。
- [x] **外掛功能級驗收首批** —— Kanban 卡片、Dataview 查詢、Tasks 更新、QuickAdd 寫檔；見 `PLUGINS.md`。
- [ ] **外掛進階與互通** —— Kanban 拖曳、Tasks 自訂狀態、QuickAdd 互動／Macro、跨外掛情境。
- [x] **短時間同檔外部更新** —— originToken 綁定成功寫入版本，TTL 僅限制保存；
      Dataview 同檔更新與 origin-echo 13 項驗證外改即時生效、重載後存檔收斂。

### 安全與韌性的已知邊界（已記錄，暫不修）

- [ ] **proxy 的 DNS 檢查是 TOCTOU-able 的緩解** —— 檢查後 `fetch` 會再解析一次。
      真正的修法是位址 pinning（自訂 dispatcher），目前沒有這個 hook。
- [ ] **PUT 未知長度且超限時只能截斷連線** —— headers 已送出，無法再回 502。
- [x] **程式化 plugin install/uninstall 併行鎖** —— 同一 id 的磁碟修改序列化，
      更新保留一般 data.json，復原失敗保留備份並回 EROLLBACK。
- [ ] **崩潰後備份回復** —— `.myobs-tmp-*` / `.myobs-backup-*` 尚無 startup 自動修復；
      API 鎖不涵蓋 UI `/api/fs`、其他程序或外部同步。
- [ ] **UI 安裝路徑非原子、無 digest** —— 那是 Obsidian 自己的行為（逐檔 `adapter.write`），
      我們沒有 patch；server 端 `/api/plugins/install` 才有原子替換與 digest 驗證。

- [ ] **watcher 啟動錯誤傳播** —— 原生 watcher EMFILE 時 server 等 ready、harness readiness timeout；應回報原因並清理啟動中的 child。

### 平台覆蓋

- [ ] **只實測 darwin / arm64 + Chrome** —— Windows 的 UNC 路徑分支、Safari／Firefox 未測。

---

## 未来（架構已預留，不實作）

- [ ] 即時共編（變更序列、OT/CRDT）
- [ ] per-user workspace（多使用者各自的版面狀態）
- [ ] `/api/bootstrap` 預載（冷啟已 510ms，屬優化而非必需）
- [ ] `MYOBS_LIVE_VAULT` 之外的真實 vault 保護（目前是 harness 層的守門）

---

## 已知風險（定期回看）

| 風險 | 觸發條件 | 目前處置 |
|---|---|---|
| `terms` 閘的法律界線 | 服務開放給自己以外的人 | 同意畫面；文件明示需 Obsidian 明示同意 |
| Obsidian 版本升級破壞 shim | 官方發新版本 | 版本 sha256 記錄在 `vendor/obsidian.manifest.json`；升級後重跑全部 harness |
| 非原子寫入撕裂 | 桌面版與瀏覽器同時寫同檔 | `awaitWriteFinish` + conflict copy（但 adapter 不傳 `ifMtimeMs`，正常編輯路徑不會觸發） |
| git index 衝突 | 服務寫入 + git 操作並行 | 服務不執行 git 指令 |
| `workspace.json` 互踩 | 桌面版同時開 | fs 層路徑改寫隔離成 `workspace-server.json` |
| `app.js` 被意外修改 | 任何 patch | `AGENTS.md` 硬規則 1 + `npm run vendor` 的大小／sha256 驗證 |
| 外掛在瀏覽器執行第三方程式碼 | 任何社群外掛 | L2 白名單 + `child_process` 程序執行明確拒絕；安裝時告知 |

---

## 怎麼驗

```bash
npm --prefix packages/server ci # 第一次或 package-lock 變更後
npm test                        # 328 個單元測試
npm run check:spike             # 其餘 19 支見 README「驗收」
```

全部只對 vault **複本**執行。harness 的守門是 fail-closed：必須設定
`MYOBS_LIVE_VAULT` 指向真實 vault，否則直接拒絕。**每支 harness 用一份乾淨複本**；
`attachment` 會留 fixture、`menu`/`popout` 會改 `workspace-server.json`，共用同一份
會讓後面的 harness 繼承前一支的狀態。

```bash
export MYOBS_LIVE_VAULT="$HOME/my-vault"   # 你的真實 vault
BASE=/tmp/vault-copy && mkdir -p "$BASE"
rsync -a --exclude='.git/' --exclude='.docusaurus/' --exclude='node_modules/' \
  "$MYOBS_LIVE_VAULT/" "$BASE/"

DEST=$(mktemp -d) && rsync -a "$BASE/" "$DEST/"
npm run check:spike -- --vault "$DEST"
```
