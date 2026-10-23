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

目前 baseline：`b87612b`（2026-10-23）——254 個單元測試、11 支 harness、dev mode。

---

## 現況

| 能力 | 狀態 | 驗收 |
|---|---|---|
| 官方 renderer boot（1.14.4） | `[x]` | `check:spike` 10/10 |
| 編輯／檔案樹／搜尋／圖譜／Canvas／命令面板 | `[x]` | 官方實作，隨 renderer 提供 |
| 社群外掛載入（L2） | `[x]` | 16 個已啟用載入 14 個（另 2 個需 `child_process`） |
| 社群外掛安裝／更新／卸載 | `[x]` | `check:plugin-install` 6/6（真實網路） |
| 外部變更熱重載 | `[x]` | `check:hotreload` 4/4 |
| 衝突副本 + 使用者可見通知 | `[x]` | `check:notices` 10/10 |
| 斷線偵測與重連補償 | `[x]` | `check:resilience` 8/8 |
| 多視窗 popout | `[x]` | `check:popout` 8/8、`check:parity` 8/8 |
| 選單列／右鍵選單 | `[x]` | `check:menu` 8/8 |
| 列印／Export to PDF | `[x]` | `check:print` 19/19、`check:dialog` 14/14 |
| 附件（圖片／PDF／Range／編碼檔名） | `[x]` | `check:attachment` 10/10 |
| PWA manifest + 靜態資產 SW | `[x]` | `check:print` |
| 手機寬度降級 | `[x]` | `check:print`（1280 / 600px） |
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
  目前明確拒絕，代價是 `templater` 的 user scripts、`vault-feed-reader`、`geo-story-map` 不能用。
  開放等於把伺服器 shell 曝露給外掛，是這個專案最大的安全邊界變動。

- [!] **多 vault**
  路由 `/v/<vaultId>/` 已預留，但目前一次只服務一個 vault。
  要支援多 vault 需要先決定：隔離模型（同一 process 還是每 vault 一個）、設定來源、UI 入口。

- [!] **多使用者／登入**
  目前只有單一共用 token。真正的登入會牽動 session、per-user workspace、權限模型。
  在沒有共編需求前不建議做。

---

## 建議下一步

1. **真實 vault 的 dogfooding**：用複本實際使用一週，重點看社群外掛、附件、桌面版並寫 conflict。
2. **再決定 4 個決策**：目前建議維持 `child_process` 拒絕、多使用者暫緩；proxy fallback 與多 vault 等有明確需求再開。
3. **文件缺口**：`DESIGN.md` §11 與 `GAPS.md` 已同步到 baseline；下一輪有新陷阱就補，不要讓它們再次過期。

---

## 已知缺陷與限制

### 功能缺口（有明確觸發條件）

- [ ] **popout 開機自動還原** —— 瀏覽器要求使用者手勢，會被擋。
      目前顯示提示條讓使用者點一下。要更順的話需要「上次工作區」的明確 UI 入口。
- [ ] **popout 沒有頂部選單列** —— 右鍵選單可用（走主 realm 的 fallback），但 menubar 只在主視窗。
- [ ] **Export to PDF 的 modal 設定不套用** —— pageSize／landscape／margins／includeName／scale
      由瀏覽器列印分頁決定。
- [ ] **Service worker 不快取 `/`** —— 離線可以載入靜態資產，但不能離線開 app（刻意：boot 注入每次要重算）。
- [ ] **寬度跨 768 只改旗標** —— 已建立的桌面 workspace 不會長出 mobile toolbar；600px 開機才是完整路徑。

### 偵測盲區

- [ ] **`onload` 在建構後才拋錯的外掛不會出現在失敗通知裡**
      它仍留在 `app.plugins.plugins`，`enabledPlugins − plugins` 的差集看不到（例如 `templater`）。
      要覆蓋得改攔 `enablePlugin` 的回傳值，屬設計變更。

### 安全與韌性的已知邊界（已記錄，暫不修）

- [ ] **proxy 的 DNS 檢查是 TOCTOU-able 的緩解** —— 檢查後 `fetch` 會再解析一次。
      真正的修法是位址 pinning（自訂 dispatcher），目前沒有這個 hook。
- [ ] **PUT 未知長度且超限時只能截斷連線** —— headers 已送出，無法再回 502。
- [ ] **plugin install 沒有並行鎖** —— 同一 id 同時安裝是 last-writer；崩潰可能殘留
      `.myobs-tmp-*` / `.myobs-backup-*`（無 startup 自動修復）。
- [ ] **UI 安裝路徑非原子、無 digest** —— 那是 Obsidian 自己的行為（逐檔 `adapter.write`），
      我們沒有 patch；server 端 `/api/plugins/install` 才有原子替換與 digest 驗證。

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
| 外掛在瀏覽器執行第三方程式碼 | 任何社群外掛 | L2 白名單 + `child_process` 明確拒絕；安裝時告知 |

---

## 怎麼驗

```bash
npm --prefix packages/server ci # 第一次或 package-lock 變更後
npm test                        # 254 個單元測試
npm run check:spike             # 其餘 10 支見 README「驗收」
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
