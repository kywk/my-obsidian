# my-obsidian

在瀏覽器裡執行**官方 Obsidian renderer**（未修改），由自架 Node 服務提供 vault 檔案 API。

不是重寫的編輯器，也不是遠端桌面串流 —— 跑的是 Obsidian 自己的 `app.js`（1.14.4，3,942,126 bytes，
與官方釋出檔位元組相同），外面的 Electron／Node 依賴由一層 shim 取代。

---

## 快速開始

```bash
# 1. 取得 Obsidian renderer（從本機已安裝的 Obsidian.app，或 --from 指定 asar）
npm run vendor

# 2. 檢查環境
npm run doctor -- --vault ~/my-vault

# 3. 啟動（第一次會被導到同意畫面，見下方「授權聲明」）
npm start -- --vault ~/my-vault

# 4. 開 http://127.0.0.1:3000/
```

`npm run doctor` 會逐項檢查 vendor bundle、同意設定、vault 路徑、server 依賴與 Chrome，
並直接告訴你缺哪一項、要跑什麼指令。

### 常用參數

```bash
npm start -- --vault ~/my-vault --port 8080
npm start -- --vault ~/my-vault --host 0.0.0.0 --auth-token "$(openssl rand -hex 24)"
npm start -- --vault ~/my-vault --no-watch      # 關掉檔案監看（debug 用）
```

---

## 安全性：請先讀完再對外開放

- **預設只綁 `127.0.0.1`。**
- 服務有 vault 的**完整讀寫權限**，而且會**執行 vault 裡的社群外掛程式碼**。
  `--host 0.0.0.0` 加上沒有 auth token，等於把整個 vault 交給任何能連到那個埠的人。
- `--auth-token` 是**單一共用 token**（cookie `myobs_token`），不是多使用者登入系統。
  它擋得住隨機掃描，擋不住已經拿到 token 的人。
- **TLS 由你負責**：把服務放在反向代理（Caddy / nginx / Cloudflare Tunnel）後面。
  直接暴露在公網上是不安全的。
- server 端有一個 GitHub 代理（`/api/proxy`），deny by default、只允許固定的 GitHub／Obsidian 網域、
  拒絕私有 IP 與非 443 埠 —— 這是為了讓 Obsidian 的社群外掛 Browse 能用，不是通用代理。

---

## 它能做什麼

用官方 renderer，所以**功能不是我們實作的，是 Obsidian 自己的**：

- Markdown 編輯與預覽、檔案樹、分頁與分割、全域搜尋、標籤／反向連結、圖譜、Canvas、命令面板
- 核心外掛全數、主題與 CSS 片段
- **社群外掛**：載入、啟用、安裝、更新、卸載（含 Obsidian 自己的 Browse 介面）
- **多視窗 popout**（同一份 app 的第二個 DOM 表面）
- **選單列與右鍵選單**、**列印／Export to PDF**
- **外部變更熱重載**：Maestral／Dropbox、另一台機器的 Obsidian、手動編輯都能即時反映
- 手機寬度自動降級版面、PWA 可加到主畫面

實測基準（`~/kywk/obsidian`，10,150 檔 / 341 MB）：

| 項目 | 數字 |
|---|---|
| 冷啟 | **≈ 510 ms** |
| 全 vault 掃描 + metadata cache | ≈ 1 秒（19,000+ 次 fs 請求，0 失敗） |
| 社群外掛覆蓋率 | 16 個已啟用外掛載入 14 個 |

## 它做不到什麼

誠實清單，不是待辦事項：

| 限制 | 原因 |
|---|---|
| 需要 `child_process` 的外掛（如 templater 的 user scripts） | 瀏覽器沒有伺服器端執行權限。這是刻意的邊界 |
| 系統匣、全域快捷鍵、`obsidian://`、CLI、自動更新 | 瀏覽器沒有對應能力 |
| Sync / Publish 登入 | 官方帳號機制，本專案不使用 |
| 開機自動還原 popout 視窗 | 瀏覽器要求使用者手勢，會顯示提示讓你點一下還原 |
| 儲存對話框的實際落地路徑 | 瀏覽器不揭露目錄；PDF 一律由列印對話框決定位置 |
| 多人同時編輯 | 目前是單一寫入者模型 + conflict copy，未實作 OT/CRDT |

---

## 授權聲明（首次啟動會看到同意畫面）

Obsidian 1.13 之後的 renderer 會在啟動時向宿主索取一段聲明字串，逐字比對，不符就中止啟動。
**本專案不內建該字串，也不代替你按下同意。**

第一次啟動時 `/` 會顯示同意畫面，說明如何從 `vendor/obsidian/app.js` 取出該字串（畫面上有可複製的指令），
由**你本人**貼上並確認，之後寫進 `~/.config/my-obsidian/config.json`（權限 0600）。
在那之前，`/obsidian/app.js` 會回 403。

**這件事的界線**：把 renderer 送進他人的瀏覽器，在字面上就落在該聲明的射程內。
私有自用（自己的機器、自己的 vault）與對外提供服務是兩件不同的事，後者需要 Obsidian team 的明示同意。
這個判斷由操作者承擔。

本專案的程式碼**不包含也不散布** Obsidian 的任何程式碼：`vendor/` 由 `npm run vendor` 在你的機器上
從你已安裝的 Obsidian 取得，且不進版控。

---

## 專案結構

```
packages/server/     Fastify + WS：/api/fs、/v/*、/api/watch、/api/proxy、/api/plugins、PWA
packages/shim/       classic script：取代 Electron／Node 依賴（12 個模組 + Node 全域）
packages/runtime/    在 app.js 之前載入：platform-bridge、plugin-watch、popout、menu、print
tools/               零依賴的 CDP 驗收脚本（驅動本機 Chrome，不需要 Playwright）
scripts/             fetch-obsidian.mjs（零依賴 ASAR 解包）、start.mjs（啟動器 + doctor）
docs/                DESIGN.md（決策與證據）、CONTRACTS.md（線路契約）、TODO.md
vendor/obsidian/     gitignore；由 scripts/fetch-obsidian.mjs 產生
```

## 驗收

```bash
npm test                      # 單元測試（219 項）
npm run check:spike           # boot / >5000 檔 / metadata cache / 文字與二進位往返 / 冷啟
npm run check:hotreload       # WS、筆記外部變更、plugin 熱重載、回音過濾
npm run check:menu            # 選單列、右鍵選單、Move to new window
npm run check:print           # 列印、PWA、寬度切換
npm run check:dialog          # remote.dialog、Export to PDF 全鏈路
npm run check:popout          # 多視窗
npm run check:attachment      # /v/*、Range、編碼檔名
npm run check:plugin-install  # 真實網路：Browse → Install → Enable（需連外網）
```

**全部只對 vault 複本執行。** 真實驗收方式：

```bash
DEST=/tmp/vault-copy && mkdir -p "$DEST"
rsync -a --exclude='.git/' --exclude='.docusaurus/' --exclude='node_modules/' ~/my-vault/ "$DEST/"
npm run check:spike -- --vault "$DEST"
```

## 延伸閱讀

- `docs/DESIGN.md` — 17 項決策與其 shipped-artifact 證據，以及 12 個實作期間發現的陷阱
  （為什麼附件 URL 會全部 404、為什麼 `policy: {}` 會讓所有外掛靜默不載入、
  為什麼列印會是空白頁、為什麼 fs 併發會打爆瀏覽器）
- `docs/CONTRACTS.md` — server ↔ shim 的每一條線路契約
- `AGENTS.md` — 改這個 repo 之前必須知道的 7 條硬規則
