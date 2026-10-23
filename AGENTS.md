# AGENTS.md — my-obsidian

在瀏覽器裡執行**未修改的官方 Obsidian renderer**，由自架 Fastify 服務提供 vault 檔案 API。
宿主環境（檔案、選單、視窗、剪貼簿、列印、外掛載入）由 shim 與 runtime 補齊；我們不重寫編輯器。

**新對話先做**：讀 `docs/HANDOFF.md` 的〈現況〉與〈驗證接手狀態〉，跑一次最小驗證，再依任務查文件。
文件路由見下方；不要先改 code 再回頭補驗證。

---

## 30 秒概貌

```
瀏覽器
  /obsidian/*   vendor bundle（官方 1.14.4，未修改，gitignored）
  /shim/*       13 個 classic script：process/electron/fs/path/os/url/crypto/Buffer/require…
  /runtime/*    7 個模組，在 app.js 之前載入：
                platform-bridge、plugin-watch、popout、menu、print、notices、resilience
  /api/fs       單一 POST 端點（read/write/stat/list…）
  /v/*          附件直取（Range、percent-encoded 路徑）
  /api/watch    WebSocket：外部變更、plugin 熱重載
Node（Fastify）
  vault 監看、conflict copy、plugin 安裝代理、proxy allowlist、PWA
```

| 事實 | 值 |
|---|---|
| 功能 baseline | `b87612b`（2026-10-23，dev mode + 驗收基準修正） |
| 單元測試 | **254/254** |
| 端到端 harness | **11 支 / 105 項斷言**（`check:spike` 10 項） |
| Node | 22；server 與 shim 都是 **plain JavaScript，無 build step** |
| renderer | Obsidian 1.14.4，`app.js` 3,942,126 bytes，由 `npm run vendor` 產生 |
| 目前不做 | 多使用者／登入、即時共編、多 vault、`child_process` L3 |

---

## 第一個 10 分鐘

```bash
npm --prefix packages/server ci          # 1. 安裝 server 依賴
npm run doctor -- --vault <vault-copy>  # 2. 環境檢查
npm test                                # 3. 254/254
npm run dev -- --vault <vault-copy>     # 4. http://127.0.0.1:3000/（跳過同意畫面）
```

**完成判準**：上述指令都成功、`npm test` 254/254、app 能 boot 且沒有全螢幕 fatal。
完整 11 支 harness 與乾淨複本規則見 `docs/HANDOFF.md`〈驗證接手狀態〉。

> `--dev` 只允許 loopback；它從 `vendor/obsidian/app.js` 讀出字串注入 renderer，
> 不寫 config、不輸出字串。正常模式請去掉 `--dev` 並完成同意畫面。

---

## 文件路由

| 你要做的事 | 先讀 |
|---|---|
| 了解專案是什麼、怎麼跑、限制 | `README.md` |
| 接手、跑全部驗收、看目前數字 | `docs/HANDOFF.md` |
| 改 server ↔ shim 的接縫、錯誤碼、header | `docs/CONTRACTS.md` |
| 改 `fs` 語意或查 shim 已知落差 | `packages/shim/GAPS.md` |
| 做設計決策、查歷史證據 | `docs/DESIGN.md`（**先讀 §11 陷阱**） |
| 看還缺什麼、待決策、下一步 | `docs/TODO.md` |
| 只想看人類版介紹 | `README.md` |

**任何改動前先讀 `docs/DESIGN.md` §11。** 那裡是實際踩過的陷阱與證據；
`docs/HANDOFF.md` 另有最貴的八個摘要。

---

## 硬規則（違反即為錯誤）

1. **`vendor/` 底下的檔案永不修改、永不入版控。**
   `vendor/obsidian/app.js` 必須與官方釋出檔位元一致。所有平台行為調整都在 runtime 以 shim 完成。
   若真的必須 patch，先開 issue 討論並在 `docs/DESIGN.md` 記錄理由。

2. **不重寫 Obsidian 的 UI。** 我們的工作是提供宿主環境，不是重做編輯器。

3. **`terms` 字串不得出現在本 repo 的任何檔案中**（含測試 fixture、註解、commit message）。
   正常模式由操作者在同意畫面輸入後存進 server config；`--dev` 只在啟動時從
   `vendor/obsidian/app.js` 讀進記憶體，不落盤、不輸出。詳見 `docs/DESIGN.md` §8。

4. **不對操作者的真實 vault 做寫入。** 測試與回歸一律用複本或暫存目錄。
   harness 的 `MYOBS_LIVE_VAULT` 守門是 **fail-closed**，但那是輔助；每支 harness
   請用獨立複本，`attachment` 會留 fixture、`menu`/`popout` 會改 workspace。

5. **不在 server 執行任何 git 指令。** vault 可能同時被 Dropbox／Maestral 之類的同步工具
   與 git 管理；服務不得成為第三個競爭者。

6. **不上前端 bundler。** shim 必須在 Obsidian 的 `app.js` 之前以 classic script 生效。
   引入 bundler 會製造載入順序問題。

7. **不引入 Markport 的程式碼。** 它的架構結論可以參考（見 `docs/DESIGN.md` §3 第 10 項），
   但它是 GPL-3.0，引入會綁住本專案的產品方向。

---

## 專案地圖

| 路徑 | 內容 |
|---|---|
| `packages/server/` | Fastify + WS：`/api/fs`、`/v/*`、`/api/watch`、`/api/proxy`、`/api/plugins`、consent、PWA |
| `packages/shim/src/` | 13 個 classic script，取代 Electron／Node 依賴（含 `Buffer` 等全域） |
| `packages/runtime/` | `index.html`、同意頁，以及 7 個在 `app.js` 前載入的模組 |
| `tools/` | 11 支零依賴 CDP harness；`tools/lib/cdp.mjs` 是共用 driver 與 vault 守門 |
| `scripts/` | `fetch-obsidian.mjs`（零依賴 ASAR 解包）、`start.mjs`（啟動器 + doctor） |
| `docs/` | `DESIGN.md`、`CONTRACTS.md`、`HANDOFF.md`、`TODO.md` |
| `packages/shim/GAPS.md` | shim 的近似實作與已知落差；改 fs 語意必更新 |
| `vendor/obsidian/` | gitignored；由 `npm run vendor` 在操作者機器上產生 |
| `.github/workflows/` | CI：單元測試 + 語法檢查（harness 需要本機 Chrome／vault） |

---

## 常用指令

```bash
npm --prefix packages/server ci          # 第一次或 package-lock 變更後
npm run doctor -- --vault <copy>         # 環境檢查
npm run dev -- --vault <copy>            # 本地開發；loopback、跳過同意畫面
npm start -- --vault <copy>              # 正常模式；第一次需完成同意畫面
npm test                                 # 254 個單元測試
```

Harness（全部只對複本；先設 `MYOBS_LIVE_VAULT`）：

```bash
export MYOBS_LIVE_VAULT=/path/to/real-vault
npm run check:spike -- --vault <copy>    # 10 項
npm run check:popout -- --vault <copy>   # 8 項
# 其餘 9 支與「每支一份乾淨複本」的迴圈見 docs/HANDOFF.md
```

---

## 驗證要求

任何程式碼改動至少要通過：

1. `npm test` **254/254** 全綠（測試只使用暫存目錄）
2. 若改動涉及 renderer boot、shim、runtime 或 server 接縫：`npm run check:spike` **10/10**
3. 交付前跑**全部 11 支 harness**，每支回報 `passed: true`；`plugin-install` 需要真實網路
4. 每支 harness 用一份**乾淨 vault 複本**；`MYOBS_LIVE_VAULT` 必須指向真實 vault
5. 若改動涉及 fs 語意或 shim：更新 `packages/shim/GAPS.md`
6. 若發現新陷阱：補進 `docs/DESIGN.md` §11，並同步 `docs/HANDOFF.md` / `docs/TODO.md`

**完成定義**：數字與上面一致、working tree 沒有意外檔案、沒有 terms 字串、
沒有 vendor diff、沒有對真實 vault 寫入。

---

## 平行 agent 工作方式

- **檔案所有權不重疊**：指令裡明列你擁有的檔案，其他一律不要動。
- `packages/shim/src/electron-shim.js` 與 `packages/runtime/*` 是熱點，一次只給一個工作流碰。
- 每個工作流一份 vault 複本與 port 區段；主導者保留 `docs/**` 與最終整合驗證。
- 完整派工方式與五項回報格式見 `docs/HANDOFF.md`〈工作方式：平行 agent〉。

---

## 撰寫風格

- 註解寫「為什麼」，不寫「做什麼」
- 遇到不確定的行為，寫進 `GAPS.md` 而不是猜一個看起來合理的實作
- 錯誤訊息要能直接指出下一步（哪個檔案、哪個指令、哪個設定）
