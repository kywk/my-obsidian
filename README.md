# my-obsidian

在瀏覽器裡執行**官方 Obsidian renderer（未修改）**，由自架 Node 服務提供 vault 檔案 API。

跑的是 Obsidian 自己的 `app.js`（1.14.4、3,942,126 bytes，與官方釋出檔位元組相同），
外面的 Electron／Node 依賴由 13 個 shim 取代。不是重寫的編輯器，也不是遠端桌面串流。

```
Obsidian 1.14.4 · Node 22 · 254 個單元測試 · 11 支端到端 harness（104 項斷言）
```

---

## 目錄

- [這是什麼／不是什麼](#這是什麼不是什麼)
- [快速開始](#快速開始)
- [第一次啟動會看到什麼](#第一次啟動會看到什麼)
- [日常使用](#日常使用)
- [安全性](#安全性)
- [能做什麼](#能做什麼)
- [做不到什麼](#做不到什麼)
- [疑難排解](#疑難排解)
- [授權聲明](#授權聲明)
- [專案結構](#專案結構)
- [驗收](#驗收)
- [延伸閱讀](#延伸閱讀)

---

## 這是什麼／不是什麼

| | |
|---|---|
| **是** | 一個 Node 服務，把指定 vault 變成可線上存取／編輯的網頁應用，UI 與外掛生態跟桌面版同一套 |
| **不是** | 重寫的 markdown 編輯器；用 UI 框架拼出來的「類 Obsidian」；VNC 遠端桌面 |

差別在於：你拿到的所有功能都是 Obsidian 自己的實作，我們只負責把宿主環境（檔案、選單、視窗、剪貼簿、列印、外掛載入）補起來。

---

## 快速開始

```bash
# 1. 安裝 server 依賴
npm --prefix packages/server ci

# 2. 取得 Obsidian renderer
#    預設從本機已安裝的 /Applications/Obsidian.app 解包（--from 可指定 .asar）
npm run vendor

# 3. 檢查環境（會逐項告訴你缺什麼、要跑哪個指令）
npm run doctor -- --vault ~/my-vault

# 4. 啟動
npm start -- --vault ~/my-vault

# 5. 開 http://127.0.0.1:3000/
```

### 常用參數

```bash
npm start -- --vault ~/my-vault --port 8080
npm start -- --vault ~/my-vault --host 0.0.0.0 --auth-token "$(openssl rand -hex 24)"
npm start -- --vault ~/my-vault --no-watch      # 關掉檔案監看（debug 用）
npm run dev -- --vault ~/my-vault               # 本地開發：跳過同意畫面（只允許 loopback）
npm start -- --vault ~/my-vault --dev           # 同上
```

### 前置需求

- Node.js **22+**
- 一個 Obsidian vault（或空目錄，Obsidian 會自己建 `.obsidian/`）
- 想跑 `npm run check:*` 的話需要本機 Chrome（harness 用它做端到端驗證）

---

## 第一次啟動會看到什麼

**同意畫面。** Obsidian 1.13 之後的 renderer 會在啟動時向宿主索取一段聲明字串，逐字比對，不符就中止。
本專案**不內建該字串**（詳見[授權聲明](#授權聲明)）。

畫面上會給你取出該字串的指令，由你貼上並確認，之後寫進
`~/.config/my-obsidian/config.json`（權限 0600）。在那之前 `/obsidian/app.js` 回 403。
確認後**立即生效，不需重啟**。

完成後就是完整的 Obsidian。vault 裡只會多一個檔案：`.obsidian/workspace-server.json`
（與桌面版的 `workspace.json` 分開存放，互不干擾）。

### 本地開發：`--dev`

```bash
npm run dev -- --vault ~/my-vault
# 或 npm start -- --vault ~/my-vault --dev
```

`--dev` 會**跳過同意畫面**：server 在啟動時從 `vendor/obsidian/app.js` 讀出字串，
只存在記憶體並注入 renderer，不寫入 config、也不輸出到 log。

限制：**只允許 loopback**（`127.0.0.1`、`::1`、`localhost`）。搭配
`--host 0.0.0.0` 或反向代理對外會直接拒絕啟動。這是方便本機開發，不是對外服務的模式。

---

## 日常使用

**外部變更會即時反映。** Maestral／Dropbox、另一台機器開著的 Obsidian、`git checkout`、
手動編輯 —— 服務啟動後就開始監看：

| 變更 | 行為 |
|---|---|
| 筆記／附件 | Obsidian 內建的 reconcile，直接更新畫面 |
| 外掛 `main.js`／`manifest.json` | 自動 unload → load（保留外掛資料） |
| 主題、片段、核心設定 | 內建 reloadConfig |
| `workspace.json` | **刻意忽略**（版面由瀏覽器這一份掌管） |

外掛熱重載可以用 `localStorage["myobs-plugin-watch"] = "off"` 關掉。

**同時寫入同一檔案時會產生衝突副本。** 例如桌面版 Obsidian 與瀏覽器同時存檔，
伺服器會把磁碟上的舊版本另存為 `<name>.conflict-<timestamp>.<ext>`，再寫入新版本，
並在右下角跳一則通知（可按「顯示保留的舊版本」開啟）。

**後端斷線時會明確失敗，不會假裝存好。** 服務重啟、筆電休眠、tunnel 斷線都會被偵測到：
通知區出現離線提示，此時所有寫入會被擋下並回報「本次修改沒有存到磁碟」。
服務回來後會自動重連，並把斷線期間的檔案變更加回畫面。

---

## 安全性

- **預設只綁 `127.0.0.1`。**
- 服務有 vault 的**完整讀寫權限**，而且會**執行 vault 裡的社群外掛程式碼**。
  `--host 0.0.0.0` 加上沒有 auth token，等於把整個 vault 交給任何能連到那個埠的人。
- `--auth-token` 是**單一共用 token**（cookie `myobs_token`），不是多使用者登入系統。
  它擋得住隨機掃描，擋不住已經拿到 token 的人。
- `--dev` 只適用於本機：它會跳過同意畫面，且拒絕非 loopback 的綁定位址。
  不要用反向代理把 dev mode 暴露出去。
- **TLS 由你負責**：把服務放在反向代理（Caddy / nginx / Cloudflare Tunnel）後面。
  直接暴露在公網上是不安全的。
- server 端的 `/api/proxy` 是給 Obsidian 的社群外掛 Browse 用的：deny by default、
  只允許固定的 GitHub／Obsidian 網域、拒絕私有 IP 與非 443 埠、逐跳驗證 redirect。
  它不是通用代理。

---

## 能做什麼

功能不是我們實作的，是 Obsidian 自己的：

- Markdown 編輯與預覽、檔案樹、分頁與分割、全域搜尋、標籤／反向連結、圖譜、Canvas、命令面板
- 核心外掛全數、主題與 CSS 片段
- **社群外掛**：載入、啟用、安裝、更新、卸載（含 Obsidian 自己的 Browse 介面）
- **多視窗 popout**（同一份 app 的第二個 DOM 表面，不是第二個實例）
- **選單列、右鍵選單、列印／Export to PDF**
- **外部變更熱重載**、**衝突副本提示**、**斷線偵測與重連補償**
- 手機寬度自動降級版面、PWA 可加到主畫面

實測基準（作者的本機 vault，10,150 檔 / 341 MB）：

| 項目 | 數字 |
|---|---|
| 冷啟 | **≈ 510 ms** |
| 全 vault 掃描 + metadata cache | ≈ 1 秒（19,000+ 次 fs 請求，0 失敗） |
| 重連後 reconcile | ≈ 4.2 秒（10,036 檔） |
| 社群外掛覆蓋率 | 16 個已啟用外掛載入 14 個 |

## 做不到什麼

誠實清單，不是待辦事項：

| 限制 | 原因 |
|---|---|
| 需要 `child_process` 的外掛（如 templater 的 user scripts） | 瀏覽器沒有伺服器端執行權限。這是刻意的邊界 |
| 系統匣、全域快捷鍵、`obsidian://`、CLI、自動更新 | 瀏覽器沒有對應能力 |
| Sync / Publish 登入 | 官方帳號機制，本專案不使用 |
| 開機自動還原 popout 視窗 | 瀏覽器要求使用者手勢，會顯示提示讓你點一下還原 |
| 儲存對話框的實際落地路徑 | 瀏覽器不揭露目錄；PDF 一律由列印對話框決定位置 |
| 多人同時編輯 | 目前是單一寫入者模型 + conflict copy，未實作 OT/CRDT |
| `onload` 在建構後才拋錯的外掛，不會出現在失敗通知裡 | 它仍留在 `app.plugins.plugins`，狀態差集看不到 |

---

## 疑難排解

先跑 `npm run doctor -- --vault <路徑>`，它會逐項指出缺少什麼。

| 症狀 | 原因 | 處理 |
|---|---|---|
| `/obsidian/app.js` 回 403、看不到 app | 尚未完成授權聲明確認 | 開 `/` 完成同意畫面 |
| 卡在載入畫面 | 聲明字串不符，或 vault 路徑不可讀 | 畫面上會有全螢幕錯誤與具體原因 |
| 伺服器啟動就退出 | 沒給 `VAULT_PATH`，或 `vendor/` 不存在 | `npm run doctor` |
| harness 說 `MYOBS_LIVE_VAULT is not set` | 這是 fail-closed 守門，不是錯誤 | 設成你的真實 vault，再指向複本 |
| 所有社群外掛都沒載入（無錯誤訊息） | `policy` 注入不完整 | 已修；若復發見 `DESIGN.md` §11.3 |
| 附件（圖片／PDF）全部 404 | `file-url` 回錯來源 | 已修；見 `DESIGN.md` §11.7 |
| 外掛熱重載沒反應 | 被關掉了 | 移除 `localStorage["myobs-plugin-watch"]` |
| 通知卡在畫面上不消失 | `error` 等級**刻意**不自動消失 | 手動關閉 |
| 存檔失敗並說「沒有存到磁碟」 | 後端離線 | 確認 server 是否在跑；恢復後會自動重連 |

---

## 授權聲明

Obsidian 不是開源軟體。1.13 之後的 renderer 會在啟動時比對一段聲明字串：

- **本專案不內建該字串**，也不代替你按下同意。它由你本人從 `vendor/obsidian/app.js` 取出、貼上、確認。
- **本專案不包含也不散布** Obsidian 的程式碼：`vendor/` 由 `npm run vendor` 在你的機器上
  從你已安裝的 Obsidian 取得，且不進版控。
- **界線**：把 renderer 送進他人的瀏覽器，在字面上就落在該聲明的射程內。
  私有自用（自己的機器、自己的 vault）與對外提供服務是兩件不同的事，
  後者需要 Obsidian team 的明示同意。這個判斷由操作者承擔。

> **與 Obsidian 無隸屬關係。** 本專案不是 Obsidian 的官方產品，也未獲其背書。
> Obsidian 是 Dynalist Inc. 的註冊商標；專案名稱僅作描述之用。

本專案的原始碼以 **MIT** 授權釋出（見 [`LICENSE`](LICENSE)，© 2026 Yu Zhi Chen）。
**MIT 只涵蓋本 repo 的程式碼**：Obsidian renderer 不在本 repo、也不隨本專案散布，
它由 `npm run vendor` 在你的機器上取得，仍受 Obsidian 自己的條款約束。
`vendor/` 底下的內容不適用 MIT。

---

## 專案結構

```
packages/server/     Fastify + WS：/api/fs、/v/*、/api/watch、/api/proxy、/api/plugins、PWA
packages/shim/       13 個 classic script：取代 Electron／Node 依賴（含 Buffer 等全域）
packages/runtime/    7 個在 app.js 之前載入的模組：
                     platform-bridge、plugin-watch、popout、menu、print、notices、resilience
tools/               11 支零依賴 CDP harness（驅動本機 Chrome，不需要 Playwright）
scripts/             fetch-obsidian.mjs（零依賴 ASAR 解包）、start.mjs（啟動器 + doctor）
docs/                DESIGN.md（決策與證據）、CONTRACTS.md（線路契約）、TODO.md
vendor/obsidian/     gitignore；由 scripts/fetch-obsidian.mjs 產生
```

## 驗收

```bash
npm --prefix packages/server ci # 第一次或 package-lock 變更後
npm test                        # 單元測試（254 項）

npm run check:spike           # boot / >5000 檔 / metadata cache / 文字與二進位往返 / 冷啟 / 良性錯誤不蓋畫面
npm run check:hotreload       # WS、筆記外部變更、plugin 熱重載、回音過濾
npm run check:attachment      # /v/*、Range、位元組一致、編碼檔名
npm run check:popout          # 多視窗、同一 app 物件、獨立寫入
npm run check:menu            # 選單列、右鍵選單、Move to new window
npm run check:print           # 列印、PWA、寬度切換
npm run check:dialog          # remote.dialog、Export to PDF 全鏈路
npm run check:notices         # 通知層、conflict 單卡、外掛失敗
npm run check:resilience      # 後端重啟、離線閘門、重連 reconcile
npm run check:parity          # popout realm、popout 匯出、proxy、上傳
npm run check:plugin-install  # 真實網路：Browse → Install → Enable
```

**全部只對 vault 複本執行**，不會碰你的真實 vault。harness 的守門是 fail-closed：
必須設定 `MYOBS_LIVE_VAULT` 指向真實 vault，否則直接拒絕執行。

```bash
export MYOBS_LIVE_VAULT="$HOME/my-vault"   # 換成你的真實 vault

BASE=/tmp/vault-copy && mkdir -p "$BASE"
rsync -a --exclude='.git/' --exclude='.docusaurus/' --exclude='node_modules/' \
  "$MYOBS_LIVE_VAULT/" "$BASE/"

# 每支 harness 一份乾淨複本：attachment 會留 fixture、menu/popout 會改
# workspace-server.json，共用同一份會讓後面的 harness 繼承前一支的狀態。
for name in spike hotreload attachment popout menu print dialog notices resilience parity plugin-install; do
  DEST=$(mktemp -d)
  rsync -a "$BASE/" "$DEST/"
  npm run "check:$name" -- --vault "$DEST"
done
```

---

## 延伸閱讀

- **`docs/DESIGN.md`** — 19 項決策與其 shipped-artifact 證據，以及 14 個實作期間發現的陷阱。
  最有價值的幾條：
  - `policy: {}` 會讓**所有社群外掛靜默不載入**（§11.3）
  - 附件 URL 全部 404 的真正原因（§11.7）
  - `Buffer` 未定義時文字正常、只有附件壞掉（§11.5）
  - 列印會變空白頁，因為 `app.css` 的 `@media print` 隱藏整個 app（§11.10）
  - `listAll()` 會弄壞檔案樹（§11.13）
  - 健康探測逾時會誤擋使用者存檔（§11.13.1）
  - `workspace.openLinkText()` 會種出 0 byte 筆記（§11.14）
- **`docs/CONTRACTS.md`** — server ↔ shim 的每一條線路契約，以及 client 端錯誤碼語意
- **`docs/TODO.md`** — 尚未完成的事與已知風險
- **`AGENTS.md`** — 改這個 repo 之前必須知道的 7 條硬規則
