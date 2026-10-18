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
                                            // ＝ ipcRenderer.sendSync("file-url") 必須回這個值
                                            //   （不是 resourcesPath！回錯會讓所有附件 URL 變成
                                            //    /obsidianprivate/var/… 被靜態路由吃掉，DESIGN.md §11.7）
  version: "1.14.4",
  build: "1.14.4",
  platform: "darwin",
  arch: "arm64",
  documentsDir: "/Users/kywk/Documents",
  desktopDir: "/Users/kywk/Desktop",
  policy: {
    plugins: true, themes: true, snippets: true, sync: true,
    publish: true, webViewer: true, devTools: true, insider: true
  },
  termsAccepted: true,
  termsText: "<操作者本人確認後提供的聲明字串；未提供時為空字串>",
  devMode: false
}</script>
```

`policy` **不可以是空物件**。renderer 會 `Object.freeze(sendSync("policy"))` 無條件覆蓋自己的寬鬆預設值，
之後每個社群 plugin／主題／snippet 都必須通過 `policyAllows(policy.plugins, id)`。
送 `{}` 的結果是**所有社群 plugin 靜默不載入**（沒有錯誤、沒有日誌）。上面的值是桌面版 main process
自己的正常建置預設，逐欄相同。詳見 `DESIGN.md` §11.3。

`termsAccepted` / `termsText` 的關係：`termsAccepted` 必須由「`termsText` 非空」推導，而不是由任何布林旗標推導。
若用 `TERMS_ACK=1` 這種「存在即同意」的值，renderer 的 `sendSync("terms")` 會拿到 `"1"`，
比對失敗後呼叫 `window.close()`，症狀是永遠停在載入畫面。

`termsAccepted` 為 false 時，server **不得提供 app.js**，且 `GET /` 改回同意頁
（與 `GET /consent` 同一頁）。

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
- `PUT` 供大檔上傳（無條件寫入）；可選帶 `X-Write-Token` 標頭，帶了就登記到與 `/api/fs`
  相同的 origin token 表，讓上傳者略過自己的回音事件。`GET`/`HEAD` 不登記（下載不是變更）。
- URL 形式為 `/v/` + 絕對路徑去掉開頭 `/`，例如
  `/v/Users/kywk/kywk/obsidian/assets/a.png?1730000000000`。
- 路徑由 `pathToFileURL` **逐段 percent-encode**；Fastify 的 wildcard 參數**已經解碼過一次**，
  伺服器端**不得再 `decodeURIComponent`**：多解一次會把 `a%20b.png` 當成 `a b.png`，
  在檔名含 `%XX` 時**靜默回傳錯誤檔案的位元組**（HTTP 200，內容是別人的）。
- `Range` 三態：未知 unit、多範圍 `a-b,c-d`、`end < start`、非數字 → **忽略並回 200 全文**
  （不實作 multipart/byteranges）；`start >= size`、`bytes=-0`、空檔案 → 416 +
  `Content-Range: bytes */<size>`。合法範圍超出 EOF 要夾到 `size-1`。
- `HEAD` 的 header 與 `GET` 逐欄相同且**無 body**（由 handler 明示，不依賴 Node 丟掉 body）。
- `.md` / `.markdown` → `text/markdown; charset=utf-8`（否則瀏覽器會下載而不是顯示）；
  所有 `text/*`、`application/json`、`image/svg+xml`、`application/xml` 一律帶 `; charset=utf-8`。

---

## 4. `GET /api/watch`（WebSocket）

Server → 客戶端：

```json
{ "type": "change", "events": [
  { "path": "notes/a.md", "kind": "create|change|delete", "mtimeMs": 1730000000000, "size": 1234,
    "originToken": "abc123" }
] }
```

- `originToken` 的語意是「**這條路徑最近由這個 token 寫過**」，不是「這個事件由這個 token 造成」。
  瀏覽器**逐事件**略過 token 等於自己 session token 的事件。這是**逐事件**過濾而非整批略過：
  伺服器把同一時間窗內所有寫入者的事件聚合成一個批次，整批略過會連外部編輯一起吃掉
  （實測會讓外部變更永遠不 reconcile）。
- token 在 **TTL（30 s）**內對該路徑的**每一個**事件都保留（不消費即刪除）；這是
  「自己存檔 → 觸發重載 → plugin 又存檔」迴圈能收斂的唯一條件。代價是 TTL 內同路徑的
  外部編輯也會被標成自己的（延後一次 reconcile，開檔時仍會回讀磁碟）。
- 同一路徑被多個 token 寫過時**保留最後一個寫入者**（覆蓋，不合併）：事件只能帶一個 token，
  且「磁碟現況來自誰的寫入」是唯一有用的答案；保留先寫者會讓後寫的分頁收到自己沒有 token
  的事件而進入重載迴圈。殘留限制：兩個分頁對同一路徑互相 ping-pong 時彼此都像外部寫入者，
  單 token 契約無法區分（見 `packages/shim/GAPS.md`）。
- 註冊表上限 2000 筆路徑，超過時逐出**最久未寫入**者。
- **事件不是 Node 的粒度**：同一路徑在同一個 150 ms 批次內會被去重（delete 優先）。
  依賴「先 create 再 change」兩個獨立事件的程式會看到合併後的單一事件。
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
