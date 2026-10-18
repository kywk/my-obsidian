# AGENTS.md — my-obsidian

瀏覽器端執行官方 Obsidian renderer，由自架 Node 服務提供 vault 檔案 API。
所有設計決策與其證據在 `docs/DESIGN.md`；介面契約在 `docs/CONTRACTS.md`。**動手前先讀這兩份。**

---

## 硬規則（違反即為錯誤）

1. **`vendor/` 底下的檔案永不修改、永不入版控。**
   `vendor/obsidian/app.js` 必須與官方釋出檔位元一致。所有平台行為調整都在 runtime 以 shim 完成。
   若真的必須 patch，先開 issue 討論並在 `docs/DESIGN.md` 記錄理由。

2. **不重寫 Obsidian 的 UI。** 我們的工作是提供宿主環境，不是重做編輯器。

3. **`terms` 字串不得出現在本 repo 的任何檔案中**（含測試 fixture、註解、commit message）。
   它由操作者在同意畫面輸入後存進 server config。詳見 `docs/DESIGN.md` §8。

4. **絕對不對 `~/kywk/obsidian` 做寫入。** 那是真實 vault（5,124 篇筆記、1.6 GB、同時是
   `kywk.github.io` 的 working tree）。測試與回歸一律用複本或暫存目錄。

5. **不在 server 執行任何 git 指令。** 該 vault 同時被 Maestral（Dropbox，sync root `/Users/kywk/kywk`）
   與 git 同步；服務不得成為第三個競爭者。

6. **不上前端 bundler。** shim 必須在 Obsidian 的 `app.js` 之前以 classic script 生效。
   引入 bundler 會製造載入順序問題。

7. **不引入 Markport 的程式碼。** 它的架構結論可以參考（見 `docs/DESIGN.md` §3 第 10 項），
   但它是 GPL-3.0，引入會綁住本專案的產品方向。

---

## 環境

- Node 22；server 與 shim 都是 **plain JavaScript，無 build step**
- `vendor/` 由 `node scripts/fetch-obsidian.mjs` 產生（讀 `/Applications/Obsidian.app`）
- 本機位置：`/Users/kywk/kywk/project/obsidian/my-obsidian`

## 常用指令

```bash
node scripts/fetch-obsidian.mjs              # 取得/更新 renderer bundle
cd packages/server && npm test               # fs API 與 conflict 邏輯測試
cd packages/server && VAULT_PATH=... npm start
```

## 驗證要求

任何改動至少要通過：

1. `cd packages/server && npm test` 全綠（測試只使用暫存目錄）
2. Spike 驗收五條（`docs/DESIGN.md` §10）在改動後仍成立
3. 若改動涉及 fs 語意或 shim，更新 `packages/shim/GAPS.md`

## 撰寫風格

- 註解寫「為什麼」，不寫「做什麼」
- 遇到不確定的行為，寫進 `GAPS.md` 而不是猜一個看起來合理的實作
- 錯誤訊息要能直接指出下一步（哪個檔案、哪個指令、哪個設定）
