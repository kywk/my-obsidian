# Shim 缺口清單

本檔案記錄 `packages/shim/src/**` 與 `packages/runtime/index.html` 中所有
**近似實作 / 尚未實作 / 明知不正確** 的行為。

最後同步：2026-10-23（baseline 修正：ResizeObserver fatal、harness 守門、dev mode；updater IPC 修正）。

維護規則（`AGENTS.md`）：遇到不確定的行為就寫在這裡，不要猜一個看起來合理的實作。
每一條都要寫出：位置、目前行為、正確行為應該是什麼。

---

## 1. Boot 與 terms

| 位置 | 目前行為 | 正確行為 |
|---|---|---|
| `boot-data.js`（`validate`） | `termsAccepted === true` 但 `termsText` 為空時直接 boot fatal 並丟 `MYOBS_BOOT_DATA_INVALID`。shim 本身不含任何授權字串。 | Server 必須依 `DESIGN.md` §8 注入操作者已同意的字串；此檢查只是在避免 Obsidian 靜默 `window.close()` 的白畫面。 |
| `boot-data.js`（`resourcePrefix`） | 若結尾不是 `/` 會**自動補上**。 | CONTRACTS §1 已規定 `/v/`；server 應直接提供正確值，shim 的寬容處理只是防禦。 |
| `index.html`（inline script） | `window.close` 被覆寫：`window.app` 尚未建立時呼叫 `close()` 會改顯示 fatal 畫面。 | 正確的宿主會提供正確 terms 字串讓 renderer 不呼叫 `close()`。此覆寫是 `DESIGN.md` §8 要求的可觀測化。 |
| `index.html`（inline script） | `unhandledrejection` 仍會顯示全螢幕錯誤（可關閉）；`ResizeObserver loop ...` 這類良性 `error` 已在 2026-10-23 過濾（§11.15）。 | 外掛的良性 rejection 不應蓋住 UI；長期應改為只在前台記錄 + 狀態列提示。 |

## 2. `process` / `electron` / IPC

| 位置 | 目前行為 | 正確行為 |
|---|---|---|
| `process-shim.js` | `versions.electron/node/chrome` 固定為 `35.0.0 / 22.0.0 / 128.0.0`。 | 應反映實際瀏覽器版本（`navigator.userAgent`）；依 chrome 版本分支的行為可能誤判。 |
| `process-shim.js` | `env` 為空物件，`argv`/`pid`/`execPath` 為假值，`nextTick` 用 microtask。 | Node 的 nextTick queue 早於 promise microtask；實際順序會有些微差異。 |
| `process-shim.js` | `on/once/removeListener/emit` 全部 no-op。 | 依賴 signal/exit 事件的外掛永遠不會收到事件。 |
| `electron-shim.js`（`sendSync`） | 未知頻道回 `undefined` 並在 console 警告一次。`frame → "native"`、`trash → false`、`update → ""`（無 installer；`disable-update → true`）都是策略選擇。About 頁仍會顯示沒有作用的「Check for updates」按鈕（renderer 的桌面 UI，未 patch）。 | 應逐一由 server 提供真實值；`trash` 的正確行為是作業系統垃圾桶（目前退回 vault 內 `.trash/`）。瀏覽器 runtime 沒有 installer，`update` 應維持桌面 main process 的預設空狀態，不可回 `"update-manual-required"`（會顯示假更新視窗，見 `DESIGN.md` §11.20）。 |
| `electron-shim.js`（`request-url`） | 以 `fetch` 實作；`https://github.com` 等 allowlist 主機會被 `net-rewrite.js` 改寫成 `/api/proxy?url=…`（server 端 SSRF allowlist 是唯一強制點）。body 一律包成 `ArrayBuffer`。 | proxy 未做 DNS 解析後 IP 檢查（DNS rebinding）；`release-assets.githubusercontent.com` 不在 proxy allowlist（installer 例外允許）；未知長度的 body 超限時只能截斷連線。 |
| `electron-shim.js`（`print-to-pdf`） | 由 `packages/runtime/print.js` 接管，改走瀏覽器列印；IPC 回 `{ ok:true, reason:"browser-print-dialog", printed:true, fileWritten:false }`。`filepath` 永遠不會被寫入；popout 的 `print-to-pdf` 沿 `host` 委派回宿主頁（上限 4 層）。 | 瀏覽器列印對話框是唯一落地點；Export modal 的 pageSize／landscape／margins 不套用（由瀏覽器列印分頁取代）。見 `DESIGN.md` §11.10。 |
| `electron-shim.js`（選單） | `set-menu` / `update-menu-items` / `render-menu` 轉給 `runtime/menu.js`（自繪選單列＋`Menu.popup()` HTML fallback）；`context-menu` 回非 null 的 `editFlags`。 | 選單列缺 main-process 預設項目（About/Quit/undo/redo/cut/copy/paste/select all）；accelerator 只顯示不綁定；popout 沒有頂部 menubar。見 `DESIGN.md` §11.9。 |
| `electron-shim.js` | `remote.app.getPath()` 是近似對應：`userData → <vault>/.obsidian/myobs-userdata`、`temp → /tmp`、`downloads` 等由 `documentsDir` 推導。 | Electron 回傳作業系統真實路徑；目前 tmp/home 等路徑不在 vault 內，經 fs shim 會得到 `ENOENT`。 |
| `electron-shim.js`（`safeStorage`） | `isEncryptionAvailable()` 固定 `false`；`encrypt/decryptString` 只是 base64 來回。 | 應使用作業系統 keychain；目前 Obsidian 會走未加密分支。 |
| `electron-shim.js`（`nativeTheme`） | `shouldUseDarkColors` 讀 `matchMedia`；`on/removeAllListeners` 是 no-op，所以系統主題變化不會通知 renderer。 | 應用 `matchMedia` 的 `change` 事件轉發 `"updated"`。 |
| `electron-shim.js`（`webFrame`） | 縮放用 `document.documentElement.style.zoom` 近似，`getZoomLevel()` 用 `log(zoom)/log(1.2)`。 | Electron 的 zoom 會影響 `devicePixelRatio` 與 popout；CSS zoom 不完全等價。 |
| `electron-shim.js`（`remote.dialog`） | `showSaveDialog` 只對 PDF 匯出繼續：支援 File System Access API 時用 `showSaveFilePicker`，否則回合成路徑 `<browser-print-dialog>`；非 PDF 一律 `canceled:true`。`showOpenDialog` 與 `showMessageBox` 仍回 `null`／取消。 | 需要 `<input type="file">` 或 server 端檔案瀏覽器；目前「自訂 icon」、「選擇翻譯檔」功能不可用。見 `DESIGN.md` §11.10。 |
| `electron-shim.js`（`clipboard` / `capturePage`） | clipboard 轉發 `navigator.clipboard`（非 HTTPS 會 reject）；`capturePage` 回空白圖。 | 需 secure context；截圖功能（dev:screenshot）不可用。 |
| `electron-shim.js`（`relaunch`） | `location.reload()`。 | Electron 是重啟整個 app process；僅影響「重新啟動」選項。 |
| `electron-shim.js`（`open-url` / `open-file`） | `http(s)/mailto` 以 `window.open` 開啟；`file:` 與 `open-file` 直接丟棄。 | 應將 `file:` 轉成 `/v/<abs>` 下載或 `obsidian://` web URL（`DESIGN.md` §3 第 5 項）。 |
| `electron-shim.js`（`get-icon`） | 永遠回 `null`（無自訂 icon）；`set-icon` no-op。 | 需 server 端儲存 icon 並由 `userData` 提供。 |
| `electron-shim.js`（`app.getPreferredSystemLanguages`） | 只回 `navigator.language`。 | 應列出系統語言清單。 |
| `electron-shim.js`（`frame`） | 回 `"native"`，讓 Obsidian 不建立自繪 title bar。 | 與 Desktop 的 frameless UI 不同；若要對齊 Desktop 需回 `"hidden"` 並實作 traffic-light/視窗控制。 |

## 3. `fs` shim

| 位置 | 目前行為 | 正確行為 |
|---|---|---|
| `fs-shim.js`（`existsSync`） | 只查由非同步 `/api/fs` `list/stat/...` 填出的快取；未快取的一律 `false`。 | 真正的同步檔案系統呼叫。目前 `FileSystemAdapter` 只在 `testInsensitive()` 探針與少數外掛路徑使用它。 |
| `fs-shim.js`（探針） | 檔名 `.OBSIDIANTEST`（不分大小寫）完全被吸收：`writeFileSync`/`unlinkSync` no-op，`existsSync` 在 darwin/win32 回 `true`、其他平台回 `false`。 | 真的寫入再以小寫查詢；目前假設 darwin/win32 都是 case-insensitive，case-sensitive APFS 會誤判。 |
| `fs-shim.js`（`writeFileSync` / `unlinkSync`） | 佇列化 fire-and-forget，立即回傳；錯誤只寫 console。 | 真正的同步 API；目前在後續非同步操作前不保證已完成，且不會丟錯。 |
| `fs-shim.js`（`statSync` / `lstatSync`） | 只讀快取，回傳 size 0、mtime = now 的假 stats；未快取丟 `ENOENT`。 | 真正的同步 stat。外掛（如 externalfile manager）會因此看不到檔案。 |
| `fs-shim.js`（`readFileSync`） | 只支援 `__MYOBS.resourcesPath`（`/obsidian/*`）的靜態資源，且用 sync XHR；vault 路徑丟 `ENOTSUP`。 | Node 可同步讀任何路徑；目前 i18n dev 檔、自訂 icon 等同步讀取會失敗。 |
| `fs-shim.js`（`watch`） | 委派 `window.__MYOBS_WATCH.watch()`（watch-shim）——**呼叫時**才判斷，因為 fs-shim 先載入；watch-shim 不存在時維持 no-op watcher。 | Node 的 `fs.watch` 在程序內直接產生事件；這裡的事件來自 server 的 `/api/watch`（單一來源、150ms 批次、`awaitWriteFinish` 300ms），延遲與粒度都不同。見 §3b。 |
| `fs-shim.js`（`lstat` / symlink） | 直接轉呼 `stat`；server 的 `stat` 會 follow symlink，`isSymbolicLink()` 永遠 `false`。 | 需要 server 端 lstat op；目前 symlink 會被當成檔案/資料夾，且不會走 Obsidian 的 `reconcileSymbolicLinkCreation`。 |
| `fs-shim.js`（`stat.realpath`） | 直接透傳 server `stat` 回的 `realpath`；目前 `packages/server/src/fs-api.js` 回的是**絕對、已解析 symlink** 路徑。adapter 不讀此欄位。 | Node 的 stat 沒有 `realpath` 欄位；契約 §2 對此描述模糊。外掛若要一致請改讀 `fs.promises.realpath()`。 |
| `fs-shim.js`（`readFile`） | 未指定 encoding 時回 `Uint8Array`（不是 Node `Buffer`）。 | Node 回 `Buffer`；外掛若直接呼叫 `.toString("utf8")` 等方法會失敗，需傳 encoding。 |
| `fs-shim.js`（`writeFile`） | `ifMtimeMs` 仍只有呼叫端自己放在 options 才會轉發（Obsidian adapter 並不傳）；`token` 由傳輸層 `api()` 依 `TOKEN_OPS` 自動補上（見 §3b）。conflict copy 由 `fs-shim` 發 `fs:conflict:<path>` 通知，`notices.js` 顯示單卡，並可從卡片開啟保留的舊版本。 | `conflictSavedAs` 仍不會傳回 Obsidian adapter 的 UI，但使用者已可見；見 `DESIGN.md` §11.14。 |
| `fs-shim.js`（`access`） | 忽略 mode（R_OK/W_OK/X_OK 都視為存在性檢查）。 | 需尊重 mode；唯讀資源也應區分 `EACCES`。 |
| `fs-shim.js`（`mkdir`） | 一律走 server 的遞迴 mkdir；`recursive: false` 不生效。 | 非遞迴時 parent 不存在應丟 `ENOENT`。 |
| `fs-shim.js`（`rm` / `rmdir`） | `rm` 在 `recursive:true` 時送 `rmdir {recursive:true}`，否則送 `remove`（server 對資料夾回 `EISDIR`，與 Node 一致）；`maxRetries`/`retryDelay` 忽略。 | `maxRetries` 等重試語意仍未實作；`force` 只吞 `ENOENT`。 |
| `fs-shim.js`（`copyFile`） | `COPYFILE_EXCL` 以「先 access 再 copy」兩個請求檢查，有 TOCTOU 競態；`COPYFILE_FICLONE*` 忽略。 | 應由 server copy op 帶 flags 原子處理。 |
| `fs-shim.js`（`readdir`） | 回傳 `files` 再接 `folders`（非檔案系統順序）；`recursive` 與 `encoding: "buffer"` 不支援；`withFileTypes` 的 `parentPath` 是絕對路徑。 | 完整 Node `readdir` 語意。單層名稱清單本身正確。 |
| `fs-shim.js`（`utimes`） | 只送 `mtimeMs`，忽略 atime，也不會設定 ctime。 | Node `utimes` 設定 atime+mtime；`btime` 無法設定。 |
| `fs-shim.js`（`workspace.json`） | 只改寫 vault 根目錄的 `.obsidian/workspace.json` → `.obsidian/workspace-server.json`；`workspace-mobile.json` 與自訂 config dir 不處理。rename/copy 的目的地也會被改寫。 | 若 Obsidian 允許自訂 config dir，需同步隔離；目前符合 `DESIGN.md` §4 的預設情況。 |
| `fs-shim.js`（路徑大小寫） | darwin/win32 對 vault/resources 前綴一律 case-insensitive 比對。 | 應以 `testInsensitive()` 的實際結果為準；case-sensitive APFS 可能誤把 `/Vault/...` 當成 vault 內。 |
| `fs-shim.js`（resources） | `/obsidian/*` 只能 read/stat/access（HTTP GET/HEAD）；`existsSync` 一律 `false`，`readdir` 丟 `EPERM`，寫入丟 `EPERM`。 | Electron 的 `resourcesPath` 是磁碟路徑。這裡沒有「絕對磁碟路徑 → 靜態 URL」的映射，只接受 URL 前綴本身。若 renderer 用 `original-fs` 讀 `/Applications/Obsidian.app/...` 會得到 `ENOENT`。 |
| `fs-shim.js`（resource `stat`） | 由 `Content-Length` / `Last-Modified` 拼出 stats；HEAD 405 時退回 GET。 | 與磁碟 stat 的 ino/mode/mtime 精度不同。 |
| `fs-shim.js`（callback API） | 只提供 `promises.*`、`existsSync`、`exists` 與少數 sync；沒有 callback 版 `readFile/writeFile/...` 與 `readFileSync(vault)`。 | L2 外掛若使用 callback fs 會直接失敗。 |
| `fs-shim.js`（缺的 promises） | 沒有 `opendir`、`readlink`、`symlink`、`link`、`chmod`、`chown`、`mkdtemp`、`cp`、`statfs`、`watch`。 | 完整 Node fs.promises 介面。 |
| `fs-shim.js`（`constants`） | 只提供 `COPYFILE_*`、`O_*`、`S_IF*` 等基本常數。 | 完整 `fs.constants`。目前 adapter 只用到 `COPYFILE_EXCL`。 |
| `fs-shim.js`（`realpath`） | vault 路徑回 `vaultRoot + 相對路徑` 的絕對字串；server 端 op 本身回相對路徑。 | Node 語意是解析 symlink 後的絕對路徑；目前不解析 symlink。 |

## 3b. `watch-shim.js` / `plugin-watch.js`（外部變更與熱重載）

`fs.watch` 由 `watch-shim.js` 接上 server 的 `/api/watch` WebSocket，`plugin-watch.js`
再依原始事件重載 `.obsidian/plugins/*`。下列都是與 Node `fs.watch` 或 desktop Obsidian 的已知落差。

`__MYOBS_WATCH.state` 的計數語意（測試斷言用）：`received` 收到的事件總數；
`dispatched` 實際派發出去的次數（事件 × 命中的 watcher 數）；`filtered` 被回音過濾略過的事件數；
`reconnects` 第二次以後的成功連線次數（首次連線不計）。

| 位置 | 目前行為 | 正確行為 |
|---|---|---|
| `fs-shim.js`（`api()` 的 `TOKEN_OPS`） | 所有變更類 op（`write`/`writeBinary`/`append`/`appendBinary`/`mkdir`/`rmdir`/`remove`/`rename`/`copy`/`utimes`）在傳輸層自動補 `token: __MYOBS.sessionToken`，呼叫端不需知道。讀取類 op 不補。 | 契約 §2 的 `token` 本來就是給回音過濾用的；這一層是唯一能涵蓋所有呼叫端（adapter、外掛、`writeFileSync` 佇列）的位置。 |
| `boot-data.js`（`sessionToken`） | 每個 document 一組 token（`crypto.randomUUID()`，退回 `getRandomValues` 十六進位，最後才用 `Math.random`）；**不覆蓋** server 已注入的值。 | 多分頁各自一組是正確的：**同一分頁**的寫入才會被自己過濾掉。分頁 A 的寫入在分頁 B 仍會派發（B 需要 reconcile）。 |
| `watch-shim.js`（事件過濾） | 以**事件**為單位略過 `originToken === sessionToken` 者，並略過同批同路徑的兄弟事件。 | 一開始是「整批略過」，但 server 會把**所有寫入者**聚合成同一個 150ms 批次，整批略過連同批的外部編輯一起吃掉（`tools/hotreload-check.mjs` 的筆記測試就是這樣失敗的）。逐事件過濾同樣能阻斷迴圈，且不會犧牲外部變更。 |
| `watch-shim.js`（token 覆蓋範圍） | **已修**：server 端改為 TTL（30 s）內對該路徑的每個事件都帶 token（`watch.js` 的 `createOriginTokenStore`），跨批次破口關閉。 | 殘留限制兩條：(1) 同一路徑被兩個分頁互相 ping-pong 時彼此都像外部寫入者，單 token 契約無法區分；(2) TTL 窗口內同路徑的**外部**編輯會被視為自己的而延後一次 reconcile。 |
| `watch-shim.js`（事件粒度與順序） | 只保證第 N 批在 O(150ms)；同一路徑在同一批只會有一個事件（server 的 `pending` Map 去重，`delete` 優先），同一批內的多個路徑**沒有先後語意**。 | Node 的 `fs.watch` 依序回報每一次變更。依賴「先 create 再 change」的外掛會看到合併後的事件。 |
| `watch-shim.js`（`error` 事件） | 永不派發 `error`。Node 的 FSWatcher 失效時會丟 `error`，adapter 收到後會 `onFileChange(realpath)` 全庫 rescan。這裡若在每次 WS 斷線都派發，會變成反覆全庫掃描。 | 需要「重連後補償」的策略（見下一列）。 |
| `watch-shim.js`（重連） | 指數退避 1s → 上限 15s；`state.reconnects` 只在第二次以後的連線累加。**不重播**錯過的批次。斷線期間的外部變更若之後沒有再次變動，永遠不會傳到瀏覽器。 | 應在重連後對 `.obsidian/plugins/*` 與開檔中的檔案補一次 mtime 掃描，或由 server 保存最近 N 秒的事件重播。 |
| `watch-shim.js`（watcher 根） | 只服務落在 `__MYOBS.vaultPath` 內的 watcher 根；其他根會警告一次且永不派發。 | Obsidian 目前只註冊 vault root 與 `.obsidian` 子樹，都在 vault 內。 |
| `watch-shim.js`（目錄本身的事件） | `event.path === watcher.rel`（watched 目錄自己改變）時略過。 | Node 會回目錄的 basename，adapter 會把它當成「watcher 根下的項目」；略過可避免對 vault root 做無意義的 `reconcileFile("")`。 |
| `plugin-watch.js`（路徑） | 只認 `.obsidian/plugins/<id>/{main.js,manifest.json,styles.css,data.json}`。自訂 config dir、plugin 子目錄、其他檔案（例如 plugin 自帶的 `.css`）不觸發。 | Obsidian 支援自訂 configDir；`DESIGN.md` §4 只列出這四種檔案。 |
| `plugin-watch.js`（data.json 延後） | 設定頁開著時用 `document.querySelector(".mod-settings") !== null` 判斷，500ms 輪詢、30 秒後放棄並記錄 `deferred-abandoned`。 | 沒有公開 API 可查「目前開啟的 settings tab」；DOM class 是唯一可行訊號，Obsidian 改版可能失效。 |
| `plugin-watch.js`（重載失敗） | `enablePlugin(id)` 回 `false`（例如 `policy.plugins` 不允許社群外掛）時，外掛會停在 unloaded，只有 `__MYOBS_PLUGIN_WATCH.events` 記錄失敗。 | 依 `DESIGN.md` §4 應該重載；失敗時應有 UI 提示。目前刻意不吞例外、完整記錄。 |
| `plugin-watch.js`（開關） | `enabled` 預設 true，可由 `localStorage.getItem("myobs-plugin-watch") === "off"` 關閉（只在載入時讀一次）。`reloadAll()` 存在但尚無 UI。 | `DESIGN.md` §4 要求 UI 開關與手動「重新載入所有 plugin」；設定介面尚未實作。 |
| `plugin-watch.js`（時序） | 重載鏈為 WS(≤150ms) → watch-shim → per-plugin debounce 400ms → unload/load。外部 `main.js` 變更到外掛重新 `onload` 約 1 秒。 | 桌面版是 OS 事件（毫秒級）。這是取樣與聚合的成本，屬可接受的近似。 |

## 4. `path` / `os` / `url`

| 位置 | 目前行為 | 正確行為 |
|---|---|---|
| `path-shim.js` | 不是 Node 的完整移植：`parse` 對結尾斜線/`.` 目錄、win32 drive-relative、UNC 細節、`toNamespacedPath`、`matchesGlob` 都不同。 | 有需要時改用 `path-browserify` 或補齊；目前涵蓋 Obsidian adapter 與常見外掛用法。 |
| `path-shim.js`（`resolve`） | 相對路徑以 `process.cwd()` 為基準，而 shim 的 cwd 固定 `/`（win32 為 `C:\`）。 | Node 在桌面是 process cwd；此差異不影響 Obsidian（它只用絕對路徑）。 |
| `os-shim.js` | `version()`/`release()` 用 `navigator.userAgentData.platform` 或固定字串，不是 kernel 版本。 | 只能由 server 注入或接受此近似；只影響 About 視窗顯示。 |
| `os-shim.js` | `hostname()` 依序用 `__MYOBS.deviceName`（非 CONTRACTS 欄位）、`location.hostname`、`"my-obsidian"`。 | 應由 server 注入作業系統主機名。 |
| `os-shim.js` | `tmpdir`/`homedir` 由 `documentsDir` 推導；兩者可能落在 vault 外，經 fs shim 會 `ENOENT`。 | 應由 server 提供可讀寫的 tmp/home 或映射進 vault。 |
| `os-shim.js` | `cpus/totalmem/freemem/networkInterfaces` 回空值。 | 瀏覽器無法取得；外掛若用於診斷會顯示 0。 |
| `url-shim.js` | `pathToFileURL` 的 percent-encoding 與 Node 略有差異（例如 `~` 保持字面、Node 會編成 `%7E`）；回傳的是 plain object，不是 WHATWG `URL`。 | 需要位元級 URL 輸出的程式會不同；`FileSystemAdapter.getResourcePath` 只做字串處理，實測等價。 |
| `url-shim.js` | `parse`/`format` 是簡化版 legacy API。 | 完整 Node `url.parse` 欄位語意（auth/port/host 組合等）。 |

## 5. `crypto` / `btime`

| 位置 | 目前行為 | 正確行為 |
|---|---|---|
| `crypto-shim.js`（`scrypt`） | 明確丟 `Error("crypto.scrypt is not available in the browser shim")`；`scryptSync` 同理。 | 需要 scrypt 的外掛（Templater user scripts 等）在瀏覽器 runtime 無法執行；若要做，需 WASM 或 server 端 API。 |
| `crypto-shim.js` | `createHash`、`createHmac`、`pbkdf2`、`createCipheriv`/`createDecipheriv` 全部丟 `MODULE_NOT_SUPPORTED`。 | 可改用 `crypto.subtle` 的非同步版本，但會改變同步 API 語意。 |
| `crypto-shim.js`（`timingSafeEqual`） | 自行以迴圈比較，不是真正的 constant-time。 | 應用 `crypto.subtle` 實作；目前只用於非安全關鍵路徑。 |
| `crypto-shim.js`（`randomBytes`） | 回 `Uint8Array`（非 `Buffer`）；callback 版用 microtask 呼叫。 | Node 回 `Buffer` 並在 I/O 之後呼叫；外掛若檢查 `Buffer.isBuffer` 會失敗。 |
| `crypto-shim.js`（`subtle`） | 直接轉發 `window.crypto.subtle`；非 secure context 會是 `undefined`。 | 需要 HTTPS 或 localhost；server 部署時要注意（`DESIGN.md` §3 第 7 項）。 |
| `btime-shim.js` | `btime()` no-op 回 `true`；creation time 不會被還原。 | 瀏覽器無法設定伺服器檔案的 birth time；`stat.birthtimeMs` 目前來自 server 的 ctime。 |

## 6. `require` 白名單

| 位置 | 目前行為 | 正確行為 |
|---|---|---|
| `require-shim.js` | 提供 `electron`、`fs`、`original-fs`、`path`、`os`、`url`、`crypto`、`btime`、`process`，以及 `node-globals-shim.js` 註冊的 `util`、`buffer`、`querystring`；清單由 registry 推導。 | 已對齊 `DESIGN.md` §7；新增模組時改 registry 即可，錯誤訊息不會過時。 |
| `require-shim.js` | `obsidian`、`@codemirror/*`、`@lezer/*` 不在此 shim 內；預期由 Obsidian 的外掛載入器轉發。 | 若外掛直接呼叫 `window.require("obsidian")`，目前會丟 `MODULE_NOT_SUPPORTED`。 |
| `require-shim.js` | 子路徑（`fs/promises`、`stream/web`）不支援。 | Node 支援子路徑；有外掛使用時需補。 |
| `require-shim.js` | 錯誤有 `code = "MODULE_NOT_SUPPORTED"` 與 `moduleName`，但只在 console。 | `DESIGN.md` §7 要求 UI 提示「此 plugin 需要伺服器端執行權限，已被拒絕」；目前尚未接上。 |

## 7. `index.html` / 資產路徑

| 位置 | 目前行為 | 正確行為 |
|---|---|---|
| `index.html` | Shim 以 `/shim/*` 載入、Obsidian 資產以 `/obsidian/*` 載入、runtime 層（`plugin-watch.js`、`popout.js`）以 `/runtime/*` 載入；三者都由 `packages/server/src/static.js` 的 `assetTree()` 提供（`no-store`，改檔立即生效）。 | 已對齊；若改路徑需同步修改 `index.html` 與 boot-data 的 worker resolver。`/runtime/*` 的 root 由 `runtimeIndexPath` 的 dirname 推導，避免與 `/` 的注入來源分岔。 |
| `boot-data.js`（Worker resolver） | 只改寫 `worker.js`、`/worker.js`、`sim.js`、`/sim.js` 四種寫法到 `resourcesPath`。 | 外掛以相對 URL 建立的 worker 仍以 document URL 為基準；若 runtime 頁面不在 `/obsidian/`，外掛需自己用絕對路徑。 |
| `index.html` | PWA manifest 與 service worker 由 server 注入／提供：`/manifest.webmanifest`、`/sw.js` 只 precache 靜態資產，**不快取** `/api/fs`、`/api/watch`、`/v/*`、`/obsidian/app.js`；`/` 也不快取（boot 注入每次重算）。 | 已對齊 `DESIGN.md` §3 第 13 項；離線只保證靜態資產可載入，不保證可離線開 app。 |
| `index.html` | fatal overlay 以 inline style/script 實作，CSP 只限制 `style-src`。 | 若 server 之後加上 `script-src` CSP，inline script 會被擋掉，需改為外部檔案或 nonce。 |

## 8. 與 server 的假設（不在此 repo 內，但會影響正確性）

| 假設 | 目前行為 | 備註 |
|---|---|---|
| `termsText` 注入 | `boot-data.js` 在 `termsAccepted === true` 時要求非空字串；CONTRACTS §1 範例沒有此欄位。 | Server 必須補上；否則會 boot fatal（這是刻意的，避免白畫面）。 |
| `resourcesPath` 是 URL 前綴 | fs shim 只認字串前綴 `/obsidian`，不認磁碟上的 `Contents/Resources`。 | 若 renderer 以 `original-fs` 讀真正的 Electron 資源磁碟路徑，會 `ENOENT`。 |
| `stat.realpath` | Server `stat` 回絕對、已解析 symlink 的 `realpath`；shim 直接透傳。`fs.promises.realpath()` 走獨立的 `realpath` op（server 回 vault 相對路徑，shim 再接成絕對）。 | 契約 §2 對 `stat.realpath` 的相對/絕對沒有明說；server 與 shim 目前一致，但需要寫進契約。 |
| `write.conflictSavedAs` | shim 有轉發，且 `fs-shim` 會發 `fs:conflict:<path>` 通知；`notices.js` 顯示單卡，adapter 仍不讀回傳值。 | UI 已可見並可開啟保留的舊版本；若要讓 adapter 也拿到結果，需改寫入路徑的回傳鏈。 |
| `/api/watch` WebSocket | shim 已接上：`watch-shim.js` 把 WS 事件轉成 adapter 的 `fs.watch` 事件（見 §3b），`plugin-watch.js` 負責 plugin 熱重載。 | 事件粒度、回音過濾與重連補償的落差都列在 §3b。 |
| `__MYOBS.policy` 注入 | Server 的 `buildBootInfo()` 已注入 `DEFAULT_POLICY`（`plugins`/`themes`/`snippets`/`sync`/`publish`/`webViewer`/`devTools`/`insider` 全為 `true`）；空物件會讓所有社群外掛靜默不載入。 | 已對齊 `DESIGN.md` §11.3；若升級 renderer 需重跑 `check:hotreload` 與外掛載入驗收。 |

## 9. 多視窗 popout（`packages/runtime/popout.js`）

桌機版的「Open in new window」在 renderer 內只有一個宿主呼叫：`p0()` 以
`window.open("about:blank", "_blank", "popup,parented=1,width=…,height=…,x=…,y=…,background=…")`
開一個新視窗，接著**同步**往該 document 寫入（`<base href>`、eval enhance.js、`h0()`）；
`x3`（Workspace 的 `"window"` 節點）再 `c.app = t.app`，所以 popout 用的是**同一個 app 物件**。
因為 `about:blank` 的初始文件與 opener 同源、同瀏覽器行程，這個機制在瀏覽器裡同樣成立——
**狀態是共享的，不是複本**。這一節記錄的是「桌機有、瀏覽器沒有」的那些部分。

| 位置 | 目前行為 | 正確行為 |
|---|---|---|
| `electron-shim.js`（popout realm） | popout 視窗沒有 nodeIntegration，因此 `h0()` 的 `require("electron")` 拿不到東西。`popout.js` 在 `window.open` 返回後**同步**把 `/shim/*`（11 個，見下一列）eval 進 popout realm，並給它一份 `__MYOBS` 複本。 | Electron 直接給新 renderer nodeIntegration；`window.electron` / `window.electronWindow` / `window.require` 都是真的。 |
| `popout.js`（child shim 集合） | 注入 `boot-data`、`node-globals`、`process`、`electron`、`fs`、`path`、`os`、`url`、`crypto`、`btime`、`require`；**不含 `watch-shim`**。 | 桌機的 popout renderer 有完整 Node。不含 watch-shim 是刻意的：popout realm 沒有 vault adapter，`fs.watch` 落回 fs-shim 的 no-op watcher（§3），因此不需要為它多開一條 `/api/watch` WS（每個 popout 一條）。若某個外掛真的在 popout realm 內 `fs.watch`，它會靜默不觸發。 |
| `popout.js`（`sessionToken`） | popout realm 有自己的 token（per-document 正確，CONTRACTS §4）。主視窗的寫入仍由主 document 的 token 過濾；popout realm 自己的寫入在主視窗看是**外部變更**（會 reconcile）。 | 桌機只有一個 renderer 在寫，沒有「兩個 document 各自過濾」的情形。 |
| `popout.js`（features 翻譯） | Obsidian 送的 feature 字串是給它自己的 main process 解析的（`setWindowOpenHandler`）：`background=`、`parented=1`。**Chromium 收到 `background=…` 會讓整個 `window.open()` 回 `null`**（實測：`popup,background=#202020` → null、`popup,width=700,height=500` → Window，且與 `--disable-popup-blocking` 無關）。因此 popout.js 先解析再以 `popup,width=…,height=…[,left=…,top=…]` 重送。 | Electron：main process 解析並套用（`background` → `BrowserWindow.backgroundColor`、`parented` → 視窗父子關係）。 |
| `popout.js`（`background`） | 以 `position:fixed;z-index:-1` 的覆蓋層模擬「視窗底色」，Obsidian 的 `.app-container` 出現後移除。 | Electron 的 `BrowserWindow.backgroundColor` 在 web content 之前就先畫好，沒有閃白。覆蓋層只能在 document 內著色，第一次 paint 的空窗仍可能有極短的閃爍。 |
| `popout.js`（預設尺寸） | 未指定尺寸時補 `width=800,height=600`（Electron `BrowserWindow` 預設值）。Chrome 仍會自行調整（實測 800×600 要求 → `innerHeight` 533），位置也可能被 clamp。 | Electron 完全依 features / 預設值決定，且在 `screen.getAllDisplays()` 的重疊判定通過時精確還原座標。 |
| `popout.js`（彈窗阻擋） | 沒有手勢的 popout 請求（最常見：boot 時還原 `workspace-server.json` 裡的 `"window"` 節點）會被瀏覽器擋掉，`window.open` 回 `null`。Obsidian 自己只會 `console.error("Failed to restore popout window")` 後丟棄該節點；popout.js 另外顯示提示條與「在新視窗開啟目前筆記」重試按鈕（點擊＝手勢）。 | 桌機不需要手勢，開機即還原全部視窗。 |
| `popout.js`（`#popout=<vault path>`） | URL hash/query 只能當「請求」：Obsidian 的 popout document 是 `about:blank`（無法用 URL 指定），而 `window.open` 需要手勢。因此這個通道顯示提示條，由使用者點擊後以 `app.workspace.openLinkText(path, "", "window")` 開啟。 | 桌機沒有對應功能（`obsidian://` deep link 是另一項）。 |
| `popout.js`（觸發路徑） | 分頁右鍵選單（「Move to new window」）可用：`nativeMenus:false` 時由 Obsidian 自己畫 HTML 選單；未設定時（macOS 預設 true）由 `runtime/menu.js` 的 `Menu.popup()` fallback 接手。命令面板「Open current tab in new window」與拖曳分頁也可用。 | 已對齊 `DESIGN.md` §11.9；popout 沒有頂部 menubar，仍是已知缺口。 |
| `electron-shim.js`（`remote.screen`） | 以 `window.screen` 近似出單一 display：`bounds` 用 `width/height`，`workArea` 用 `availWidth/availHeight`（拿不到 macOS 選單列／Dock 的 inset）。Obsidian 只用它做 popout 座標還原的重疊判定。 | Electron 回真實 display 清單與 work area；多螢幕環境下只能看到「目前這一個」。 |
| `electron-shim.js`（`webContents.zoomLevel`） | 由固定的 `0` 改為 getter/setter，反映 `webFrame` 的 CSS zoom 近似值。 | Electron 的 `zoomLevel` 會影響 devicePixelRatio 與 popout 還原；CSS zoom 不完全等價（§2 `webFrame` 列）。 |
| `popout.js`（子視窗寫入） | popout realm 的 `fs` shim 走同一組 `/api/fs`（有自己的 token）；`app.vault.modify()` 之類的呼叫其實是主 realm 的 adapter，因此寫入路徑與主視窗完全相同。 | 桌機完全相同（同一 process 共用 adapter）。 |

