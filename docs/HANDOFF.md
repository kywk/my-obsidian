# 接手 my-obsidian

> 這份是給**下一個 agent** 的開場指令。貼上整份即可。
> 人類讀者要的是 `README.md`。

---

## 你的任務

接手這個 repo，先確認自己拿到的是可用狀態，再依人類指定的方向開發。

**先驗證，再動手。** 動任何一行程式碼之前，跑完下面「驗證接手狀態」那一節。
基準不成立就先修它 —— 一個壞掉的基準會讓後面每一個判斷都失去意義。

---

## 先讀這四份（依序，讀完再開工）

1. **`README.md`** —— 這個專案是什麼、怎麼跑、能做與不能做什麼、疑難排解。
2. **`AGENTS.md`** —— 7 條硬規則。這是護欄，違反它的改動一律不接受。
3. **`docs/DESIGN.md` §11** —— **14 個陷阱**。這是全 repo 最省時間的一份：
   每一個都是花了好幾小時、用 shipped artifact 或實測挖出來的，
   不知道就會重踩（例如「附件 URL 全部 404 的真正原因」、「`listAll()` 會弄壞檔案樹」）。
4. **`docs/TODO.md`** —— 現況表（哪個能力由哪支 harness 驗收）、需要決策的 4 件事、
   已知缺陷與風險。

需要線路細節時再查 **`docs/CONTRACTS.md`**（server ↔ shim 的每一條契約與錯誤碼語意）。

---

## 現況（釘在 `ce36d2a`，不要重新探索）

- 9 個 commit、73 個追蹤檔案、working tree clean
- Node 22；server 與 shim 都是 **plain JavaScript，沒有 build step**
- 251 個單元測試 + **11 支零依賴 CDP harness**（驅動本機 Chrome，不需要 Playwright）
- renderer 是**未修改**的官方 Obsidian 1.14.4（`app.js` 3,942,126 bytes），
  由 `npm run vendor` 在操作者機器上解包，`vendor/` 不進版控

實測數字（作者的本機 vault，10,150 檔 / 341 MB）：

| 項目 | 數字 |
|---|---|
| 冷啟 | ≈ 510 ms |
| 全 vault 掃描 + metadata cache | ≈ 1 秒（19,000+ 次 fs 請求，0 失敗） |
| 重連後 reconcile | ≈ 4.2 秒（10,036 檔） |
| 社群外掛覆蓋率 | 16 個已啟用載入 14 個 |

---

## 驗證接手狀態

**所有 harness 都只對 vault 複本執行。** 它們有守門（`MYOBS_LIVE_VAULT`，見 `tools/`），
指向真實 vault 會被拒絕 —— 那是輔助，不是保證，複本請自己建。

```bash
DEST=/tmp/vault-copy && mkdir -p "$DEST"
rsync -a --exclude='.git/' --exclude='.docusaurus/' --exclude='node_modules/' ~/my-vault/ "$DEST/"

npm test                                  # 251/251
npm run check:spike      -- --vault "$DEST"   # 8
npm run check:hotreload  -- --vault "$DEST"   # 4
npm run check:menu       -- --vault "$DEST"   # 8
npm run check:print      -- --vault "$DEST"   # 19
npm run check:popout     -- --vault "$DEST"   # 8
npm run check:dialog     -- --vault "$DEST"   # 14
npm run check:notices    -- --vault "$DEST"   # 10
npm run check:resilience -- --vault "$DEST"   # 8
npm run check:parity     -- --vault "$DEST"   # 8
npm run check:attachment -- --vault "$DEST"   # 10
npm run check:plugin-install -- --vault "$DEST"  # 6，需連外網
```

**完成判準**：每一支都回報 `passed: true`（`plugin-install` 需要真實網路，離線時如實說明）。
任何一支失敗 → 先修到全綠，再談新功能。

harness 的慣例：`--port <n>`（Chrome 用 `n + 1000`）、`--json <path>` 保留完整輸出、
每項都有 `criteria` 與失敗診斷的 `facts`。新增 harness 請沿用這個形狀。

---

## 已經踩過的陷阱（會再咬你一次）

只列最貴的六個，完整版在 `DESIGN.md` §11。

1. **`policy` 不可為空物件** —— renderer 會無條件覆蓋自己的寬鬆預設，
   結果是**所有社群外掛靜默不載入**，沒有任何錯誤訊息（§11.3）。
2. **附件路徑的兩段坑** —— `file-url` 必須回 `resourcePrefix`（不是 `resourcesPath`）；
   而 `/v/*` 的路徑**不能再解碼一次**，多解一次會讓檔名含 `%XX` 的檔案回傳錯誤位元組（§11.7）。
3. **瀏覽器缺 `Buffer`** —— `app.js` 有 184 處裸引用。症狀是文字編輯全正常、只有附件壞掉。
   `spike-check` 因此把二進位往返列為**必要**條件（§11.5）。
4. **fs 併發無上限** —— Obsidian 的 `listRecursive` 繞過 adapter 的序列化佇列，
   對網路後端會 2 秒內爆出 7,000 個請求打爆瀏覽器。上限在 shim 的傳輸層（§11.1）。
5. **`listAll()` 會弄壞檔案樹** —— 它先清空 `this.files` 再重走，每個既有檔案都變
   `file-created`，`Vault.onChange` 不檢查既有節點 → 重複節點。用 `reconcileFile`（§11.13）。
6. **列印會是空白頁** —— `app.css` 的 `@media print` 隱藏整個 `.app-container`，
   必須把 active view 搬進 `body > div.print`（§11.10）。

---

## 工作方式：平行 agent

這個 repo 是靠**多個 agent 平行推進**長出來的，方法是**檔案所有權不重疊**：

- 每個工作流在指令裡明列「你擁有的檔案」與「其他一律不要動」。
- 共用的接縫（`packages/runtime/index.html` 的載入順序、`tools/lib/cdp.mjs`）
  由主導者先做好或標為凍結，再派工。
- `packages/shim/src/electron-shim.js` 與 `packages/runtime/*` 是熱點，
  一次只給一個工作流碰。
- 每個工作流都要有自己的 vault 複本與 port 區段。
- 派工時一併交代：讀哪幾份文件、硬限制、驗收指令、回報格式。

主導者自己保留：`docs/**` 的更新（工作流只列「需要更新的內容」）與最終的整合驗證。

---

## 回報格式

每個工作流交回這五項：

1. **每個驗收指令的原始輸出**（不是摘要；失敗就貼失敗）
2. **每個檔案的實際行數**
3. **你改了什麼、為什麼** —— 特別是「原本錯在哪、證據是什麼、怎麼修」
4. **`docs/**` 需要更新的內容**（工作流不改文件，列出來由主導者套用）
5. **無法驗證或明知不完整的地方**

主導者整合後要跑**全部** harness，不是只跑受影響的那幾支 ——
`electron-shim.js` 或 `fs-shim.js` 的改動會影響所有 harness。

---

## 動手前的三條底線

- 官方 renderer 保持位元組一致；平台行為在 runtime 以 shim 調整（`AGENTS.md` 規則 1）。
- 測試與回歸**只對 vault 複本**執行；真實 vault 是操作者的資料（規則 4）。
- 交付前跑 `npm test` 與全部 harness，並把真正跑到的數字寫進報告。

## 完成後

在 `DESIGN.md` §11 補上這一輪發現的陷阱（如果有），更新 `docs/TODO.md` 的現況表與待決策，
然後回報給人類。下一輪的接手說明就是這一份 —— 請順手讓它保持正確。
