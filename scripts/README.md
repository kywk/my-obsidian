# scripts/

## `fetch-obsidian.mjs`

把官方 Obsidian desktop renderer bundle 從 `obsidian.asar` 解到 `vendor/obsidian/`。

```bash
node scripts/fetch-obsidian.mjs
node scripts/fetch-obsidian.mjs --from /path/to/obsidian.asar --out vendor/obsidian --force
```

- 零外部依賴、純 Node；ASAR reader 是自己實作的，離線與 CI 可跑。
- `--out` 預設是 **repo 相對** 的 `vendor/obsidian`；明確指定時則相對於 cwd。兩者都會以 realpath 檢查，必須嚴格位於 `<repo>/vendor/` 之下（`vendor/` 本身也不行，避免整個 vendor 被置換）。
- manifest 寫在輸出目錄**旁邊**：`vendor/obsidian.manifest.json`，不是目錄內。
- `vendor/` 已在 `.gitignore`；manifest 也不入版控。
- 只讀取來源 asar，不會修改 `/Applications/Obsidian.app`。

### ASAR 格式（實測 v1.14.4）

檔案開頭 16 bytes：

| offset | 值（1.14.4） | 意義 |
|---|---|---|
| 0x00 | `4` | pickle header size，固定值 |
| 0x04 | `95916` | header payload 大小（不含前 8 bytes） |
| 0x08 | `95912` | header string 大小（`JSON length + 4`） |
| 0x0c | `95908` | JSON 長度 |

JSON 從 offset 16 開始。**資料區起點是 `8 + u32@0x04`（此檔為 95924）**，不是 `16 + JSON length`。兩者在這份 archive 剛好相等（`16 + 95908 = 95924`），但格式上應以前者為準；若遇到 header padding，用後者會錯位。

JSON 樹的 leaf 形狀：

```json
{ "size": 3942126, "offset": "668223",
  "integrity": { "algorithm": "SHA256", "hash": "...", "blockSize": 4194304, "blocks": ["..."] } }
```

- `offset` 是**十進位字串**，相對於資料區起點。
- `app.css` 的 offset 是 `0`，`app.js` 接在 `668223`，可用這組相鄰關係快速判斷偏移是否正確。
- `integrity.hash` 是整檔 SHA-256（`blocks` 是分塊雜湊）。腳本對**每個檔案**都比對這個值，所以資料區偏移算錯會直接失敗，不會悄悄產出壞檔。
- header 內沒有 `node_modules`；`unpacked` 與 `link` 也都是 0。腳本仍保留 `unpacked`（讀 `<asar>.unpacked/`）與 `link`（解析到目標 entry）的處理。

### 驗證基準

- `app.js` = **3,942,126 bytes**
- `app.js` sha256 = `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`
- `app.css` = 668,223 bytes
- `worker.js` = 239,777 bytes
- 1.14.4 共 **368 個檔案 + 28 個目錄 = 396 個 ASAR entry**。manifest 的 `fileCount` 依規格採 entry 總數 **396**，另以 `fileCountFiles: 368`、`dirCount: 28` 標明實際檔案／目錄數，避免混淆。
- `lib/.DS_Store` 確實存在於 asar 內，會原樣解出；不影響靜態服務。

### 冪等與替換

- manifest 的 `sourceSha256` 與來源相同，且輸出 `app.js` 大小等於 asar header 記載的大小時，直接輸出 `up to date` 並結束（`--force` 可強制重解）。
- 解包先寫到 `vendor/.obsidian-tmp-*`，完成後才與舊目錄交換；失敗會清掉暫存目錄，不會留下半套檔案。
- `skipped` 固定記錄 `["node_modules"]`。目前 1.14.4 的 asar 內沒有這個目錄，所以 `fileCount` 不受影響。
