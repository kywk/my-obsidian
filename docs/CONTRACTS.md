# 介面契約（server ↔ shim）

實作前必讀。兩邊都照這份寫，不得各自發明欄位。

---

## 1. Boot 注入（server → 瀏覽器）

Server 在 HTML 中注入一段同步可用的 JSON，**必須早於任何 shim 與 Obsidian 的 script**：

```html
<script>window.__MYOBS = {
  vaultId: "kywk",
  vaultName: "kywk",
  vaultPath: "/Users/kywk/kywk/obsidian",   // 絕對路徑，結尾不加斜線
  resourcesPath: "/obsidian",               // app 資源的 URL 前綴（對應 Electron resourcesPath）
  resourcePrefix: "/v/",                    // 供 adapter.getResourcePath 使用
  version: "1.14.4",
  build: "1.14.4",
  platform: "darwin",
  arch: "arm64",
  documentsDir: "/Users/kywk/Documents",
  desktopDir: "/Users/kywk/Desktop",
  policy: {},
  termsAccepted: true,
  termsText: "<操作者本人確認後提供的聲明字串；未提供時為空字串>",
  devMode: false
}</script>
```

`termsAccepted` / `termsText` 的關係：`termsAccepted` 必須由「`termsText` 非空」推導，而不是由任何布林旗標推導。
若用 `TERMS_ACK=1` 這種「存在即同意」的值，renderer 的 `sendSync("terms")` 會拿到 `"1"`，
比對失敗後呼叫 `window.close()`，症狀是永遠停在載入畫面。

`termsAccepted` 為 false 時，server **不得提供 app.js**，改回一個說明頁。

---

## 2. `POST /api/fs`

請求：`{ op, path, args? }`。`path` 是**相對 vault root** 的 posix 路徑，允許空字串代表 root。

回應成功：`{ ok: true, result: <op-specific> }`
回應失敗：`{ ok: false, error: { code, message } }`，`code` 用 Node errno 字串（`ENOENT`、`EISDIR`、`EEXIST`、`ENOTDIR`、`EPERM`、`ECONFLICT`）。

| op | args | result |
|---|---|---|
| `read` | — | `string`（utf8） |
| `readBinary` | — | `{ base64: string }` |
| `write` | `{ data: string, ifMtimeMs?: number, token?: string }` | `{ mtimeMs, size, conflictSavedAs?: string }` |
| `writeBinary` | `{ base64: string, ifMtimeMs?: number, token?: string }` | 同上 |
| `append` / `appendBinary` | 同 write | 同上 |
| `exists` | — | `boolean` |
| `stat` | — | `{ type:"file"\|"folder", mtimeMs, ctimeMs, size, realpath } \| null` |
| `list` | — | `{ files: string[], folders: string[] }`（單層，名稱不含路徑） |
| `mkdir` | — | `null`（遞迴建立，已存在視為成功） |
| `rmdir` | — | `null`（預設非遞迴；`args.recursive` 可遞迴） |
| `remove` | — | `null`（目錄回 `EISDIR`，不代為遞迴） |
| `rename` | `{ to: string }`（相對路徑） | `null` |
| `copy` | `{ to: string }` | `null` |
| `utimes` | `{ mtimeMs, ctimeMs? }` | `null`（`ctimeMs` 為 inode change time，不可設定，伺服器刻意忽略） |
| `access` | — | `null` 或 `ENOENT` |
| `realpath` | — | `string`（**相對** vault root 的真實路徑） |

`stat` 缺檔時回 `{ ok:true, result:null }`，由 shim 轉成 `ENOENT`；`stat.realpath` 為**絕對**路徑。
指向 vault 外的符號連結：`stat` 回 `EPERM`；指向 vault 外而斷裂的連結回 `null`。

**規則**

- 任何解析後落在 vault root 之外的路徑 → `EPERM`。
- `write` 帶 `ifMtimeMs` 且與磁碟現值不符 → 先另存 `<name>.conflict-<epochms>.<ext>`，
  再寫入，回傳 `conflictSavedAs`。若 `ifMtimeMs` 省略則直接覆寫。
- `stat` 對符號連結回傳 `realpath` 為解析後路徑（adapter 依賴此欄位）。

---

## 3. `GET|PUT|HEAD /v/<absolute-path-without-leading-slash>`

供 `resourcePathPrefix` 產生附件 URL（`<img>`、`<video>`、PDF）。

- 僅允許 vault root 內的路徑，否則 403。
- 支援 `Range`（回 206 + `Content-Range` + `Accept-Ranges`）、`Last-Modified`、
  `Cache-Control: no-cache`（mtime 已在 query string 上）。
- `PUT` 供大檔上傳（無條件寫入）。
- URL 形式為 `/v/` + 絕對路徑去掉開頭 `/`，例如
  `/v/Users/kywk/kywk/obsidian/assets/a.png?1730000000000`。

---

## 4. `GET /api/watch`（WebSocket）

Server → 客戶端：

```json
{ "type": "change", "events": [
  { "path": "notes/a.md", "kind": "create|change|delete", "mtimeMs": 1730000000000, "size": 1234,
    "originToken": "abc123" }
] }
```

- `originToken` 只在事件由本服務的寫入造成時出現；瀏覽器略過 token 等於自己最後送出者的事件。
- 批次聚合視窗 150 ms。
- chokidar 設定：`ignoreInitial: true`、`awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }`。
- 忽略清單：`.git/`、`.docusaurus/`、`node_modules/`，以及 `.obsidian/workspace.json`。
- 環境變數 `WATCH_DISABLED=1` 時不啟動 watcher。

客戶端 → server：目前只有 `{ "type": "ping" }`。

---

## 5. fs shim 的路徑規則

shim 收到絕對路徑時：

| 落在 | 對應 |
|---|---|
| `vaultPath` 之下 | → `/api/fs`，`path` 取相對部分 |
| `resourcesPath` 之下 | → 靜態資產 `/obsidian/*` |
| `.obsidian/workspace.json`（vault 內） | **改寫**為 `.obsidian/workspace-server.json` 再送出 |
| 其他 | throw `ENOENT` |

`testInsensitive()` 的探針（`.OBSIDIANTEST`）由 shim 直接吸收：`writeFileSync`/`unlinkSync` 為
no-op，`existsSync` 依 `__MYOBS.platform` 判斷（darwin/win32 → true）。

---

## 6. 我要的 shim 模組介面

每個 shim 都是 classic script，掛在 `window.__MYOBS_MODULES[name]`，
最後由 `require-shim.js` 建立 `window.require`：

```js
window.require = (name) => window.__MYOBS_MODULES[name]
  ?? (throw new Error("..."))
```

必要模組名：`electron`、`fs`、`original-fs`、`path`、`os`、`url`、`crypto`、`btime`、`process`。
`process` 同時要是 `window.process`（renderer 直接讀 `process.platform`）。

不可用模組（明確拋錯並附 `code: "MODULE_NOT_SUPPORTED"`）：
`child_process`、`net`、`worker_threads`。
