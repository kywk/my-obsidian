# 外掛支援與驗收

本專案提供 L2 瀏覽器宿主：使用未修改的官方 Obsidian renderer，補齊外掛所需的 Node／Electron 子集。
支援進度分為「宿主能力可用」、「外掛初始化成功」與「功能情境已驗收」，三者分開記錄。

## 能力範圍

| 能力 | 本輪結果 | 驗收 |
|---|---|---|
| 模組解析 | bare／`node:`、`fs/promises`、`path/posix`、`path/win32`，require 與 resolve 一致 | `plugin-modules.test.mjs` |
| EventEmitter | 常用同步事件、once/prepend/off、meta events 與 error 語意 | Node 對照單測＋真外掛 probe |
| util／Buffer | 標準 promisify custom hook；UInt16／32 讀取端序修正 | Node 對照單測 |
| fs | 既有 Promise 方法的 callback 版本；無 encoding 的非同步 readFile 回 Buffer；exists 查磁碟 | 真 server API 單測＋外掛 probe |
| 初始化診斷 | 觀察 enablePlugin 結果，涵蓋留下實例的 onload 失敗；成功重載清通知 | `check:plugin-support` |
| 熱重載 | 同 id 的 runtime reload 序列化、合併尾隨事件、檢查卸載結果 | `check:plugin-support`、`check:hotreload` |
| 程式化安裝 | 同 id install/uninstall 互斥；保留 data.json；回滾失敗保留備份 | `plugins.test.mjs` |
| 可選 shell 依賴 | `child_process` 可匯入，程序入口全數拒絕；不提供 server shell | `plugin-process.test.mjs`、真模板拒絕驗收 |
| 官方 Browse | 維持原 renderer 安裝／啟用路徑 | `check:plugin-install` |

精確 API 落差見 `packages/shim/GAPS.md`。沒有新增 bundler、修改 vendor 或開放 shell。
`child_process` 允許匯入，exec／spawn 等執行呼叫仍明確拒絕；原生模組與伺服器網路 socket 仍拒絕。
官方 Settings 直接 enable/disable 不受 runtime reload 佇列控制；UI 安裝走 `/api/fs`，
不受程式化 `/api/plugins` 鎖保護。外部同步工具也不在鎖的範圍內。

## 2026-10-24 實際外掛盤點

以操作者 vault 的獨立複本、Obsidian 1.14.4 與 Chrome 驗證：
**15 個啟用，15 個初始化成功、0 個失敗、0 個未觀測**。
這是啟動相容性結果，尚未逐一驗收每個外掛的完整功能。
歷史的「16 個啟用／14 個實例」使用不同清單與判準，不可當成本輪成功率。

| 外掛 | 版本 | 結果 |
|---|---|---|
| `calendar` | 1.5.10 | 初始化成功 |
| `cm-editor-syntax-highlight-obsidian` | 0.1.3 | 初始化成功 |
| `dataview` | 0.5.68 | 初始化成功 |
| `geo-story-map` | 0.5.1 | 初始化成功；功能見下表 |
| `obsidian-auto-link-title` | 1.5.5 | 初始化成功 |
| `obsidian-kanban` | 2.0.51 | 初始化成功 |
| `obsidian-outliner` | 4.10.2 | 初始化成功 |
| `obsidian-style-settings` | 1.0.9 | 初始化成功 |
| `obsidian-tasks-plugin` | 8.6.0 | 初始化成功 |
| `obsidian-tracker` | 1.19.0 | 初始化成功 |
| `quickadd` | 2.32.1 | 初始化成功 |
| `recent-files-obsidian` | 1.7.10 | 初始化成功 |
| `tag-wrangler` | 0.6.5 | 初始化成功 |
| `templater-obsidian` | 2.26.0 | 初始化成功；功能見下表 |
| `vault-feed-reader` | 0.6.1 | 初始化成功；功能見下表 |

修正前這三個外掛皆因提前匯入 `child_process` 失敗；Templater 還會保留 `_loaded=true`
實例，不能只數實例。修正後匯入可用，只有真正執行程序時拒絕；未開放 L3。
原始例外仍由官方 renderer 的 console 提供；診斷結果不擅自改寫啟用偏好。

## 三個外掛的無 shell 功能

所有驗收使用已安裝的原始外掛與正常 boot，不注入替代模組、不修改外掛 bundle；
完成後比對來源檔 SHA256。初始化成功仍不代表外掛內部資料已就緒。

| 外掛 | 已驗收功能 | 維持限制 |
|---|---|---|
| Templater 2.26.0 | 日期、字串／JS 模板、筆記標題／路徑、建立／重新命名筆記、純 JavaScript user scripts（包含 fs/promises 讀取） | system commands 明確拒絕且不產生檔案；任意使用者腳本仍受 L2 API 範圍限制 |
| Geo Story Map 0.5.1 | 兩個地圖標記與路徑線、圖磚呈現、故事下一頁、資料夾筆記索引、完整內文、返回 Markdown | 本機 AI 座標查詢／CLI 不可用；圖磚用內嵌資料驗證，未驗遠端供應商 |
| Vault Feed Reader 0.6.1 | 訂閱與資料夾、OPML、RSS 下載解析、IndexedDB 快取、閱讀／管理介面、儲存 Markdown、已讀持久化、原文擷取、重新載入 | 本機 AI 摘要不可用且不改筆記；RSS／HTML 使用同源真 requestUrl，任意外站與 CORS 未覆蓋 |

Templater 的系統命令以真模板觸發，確認拒絕後一般模板仍可用。
Geo／Feed 的本機 AI controller 先回報找不到外部執行檔，另直接驗證 spawn 必定拒絕；
不把前者誤稱為已執行到 spawn，也不擴大檔案系統或 proxy allowlist。


### Feed Reader 0.6.1 的冷啟限制

若 root 資料夾已存在、但設定的訂閱 YAML 不存在，外掛在索引建立前誤認資料夾缺失，
接著建立既有資料夾失敗，訂閱服務會停留在唯讀。這是觀察到的外掛啟動前置條件問題；
尚未在原生 Obsidian 重現，不宣稱桌面版已確認有同樣缺陷。
全新 root 可正常建立；已有有效訂閱 YAML 會由初始掃描事件重新載入。

恢復方式已用真設定 UI 驗證：開啟 **Settings → Vault Feed Reader → Subscriptions YAML**，
保留原路徑並按 **Apply**，即可在索引完成後重新讀取並恢復寫入。不要刪除既有資料。
正式功能 harness 從全新 root 啟動並驗收寫入後重載；它不包含手動重啟或上述恢復步驟。
官方順序是 plugins.initialize → vault.load → metadataCache.initialize；
在 enablePlugin 等待 metadata 會互相等待，故沒有加入全域延遲或依外掛 ID 的自動重啟補丁。

## 卡片、查詢、任務與快速寫檔

本批以正常 boot、已安裝的原始外掛與各自獨立複本驗收，外掛資產 SHA256 前後一致。
Kanban／Tasks 操作使用真 UI；QuickAdd 使用外掛公開的 `api.executeChoice`，
Dataview 同時驗 DQL API 與原生 Markdown 區塊。沒有用直接寫檔假造外掛操作成功。

| 外掛 | 已驗收功能 | 驗收 | 尚未涵蓋 |
|---|---|---|---|
| Kanban 2.0.51 | 卡片新增、編輯、選單跨清單移動、完成、刪除、封存、Markdown 與重載一致 | `check:kanban` 14 項 | 拖曳、多看板、進階日期、其他外掛交互作用 |
| Dataview 0.5.68 | LIST／TABLE／TASK、frontmatter／inline fields、篩選排序、DataviewJS、查詢畫面更新、checkbox 寫回、外部更新、rename／delete 與重載 | `check:dataview` 17 項 | 全部 DQL 語法、任意使用者 JS、多寫入者衝突合併 |
| Tasks 8.6.0 | 查詢篩選、checkbox 完成／取消、完成日期、每日重複任務、保留其他內容、查詢更新與重載 | `check:tasks` 12 項 | 自訂狀態、所有 recurrence 語法、多檔競態 |
| QuickAdd 2.32.1 | Template Unicode 檔名與變數、保留既有檔案、Capture 依序追加與新建、變數隔離、重載後繼續寫入 | `check:quickadd` 14 項 | Macro、互動 prompt、Templater 串接、AI |

Kanban 的 Move to list 原本因宿主選單關閉時父子面板相互遞迴而失敗；
`menu.js` 已先斷開引用、移除關閉的子面板並取消 hover 計時器。
`check:menu` 新增多層動作、鍵盤／兄弟選單清理、關閉後取消 hover 三項回歸，
並檢查被 guard 捕捉的 menu warning。其餘三個外掛在這些情境不需新增宿主 API。

**同檔外部更新已修復**：原本瀏覽器剛寫過的檔案，在 30 秒 originToken TTL 內
會連外部修改一起被略過。server 現在比對成功寫入的內容與 metadata 版本，
瀏覽器逐事件判斷來源；同版本仍可跨批次過濾，外部不同版本立即送出。
Dataview 正式驗收已改成 checkbox 寫 Alpha 後，十秒內外改 Alpha，要求索引與 DOM 更新，
另保留 Gamma 外改控制組。首次綠測的外改發生於 checkbox 後 224 ms，約 3.1 秒套用。

`check:origin-echo` 另有 13 項真 renderer 驗收，使用 onload 會 saveData 的測試外掛，
檢查自己的跨批次寫入不重載、外部 data/main 更新會重載、重載後的存檔回音能收斂。
兩次外部 data 更新與一次 main 更新後，預期 loads 4／unloads 3／onload writes 4，
觀察窗口內不得繼續增加。多分頁同時持續互寫仍不屬於協作支援。

## 啟動時的信任決定

目前宿主每次 boot 都直接信任目前 vault，省略官方首次信任彈窗；
已停用的個別外掛維持停用，實際載入仍受啟用清單與 server policy 控制。
`check:plugin-trust` 6 項用全新 origin 驗首次載入、既有 false 決定被更新、
信任 modal 從未出現，以及停用外掛／清單保持不變。
瀏覽器若拒絕 localStorage，需允許網站儲存後重新載入。

## 重跑流程

每次以新的 vault 複本執行，`MYOBS_LIVE_VAULT` 必須指向真實 vault。
以下 `<copy>` 不能與真實 vault 有父子路徑關係；報告放到 vault 外。

```bash
npm test
npm run check:plugin-trust -- --vault <trust-copy> --json /tmp/plugin-trust.json
npm run check:origin-echo -- --vault <origin-copy> --json /tmp/origin-echo.json
npm run check:plugin-support -- --vault <copy> --json /tmp/plugin-support.json
npm run check:templater -- --vault <templater-copy> --json /tmp/templater.json
npm run check:geo-story-map -- --vault <geo-copy> --json /tmp/geo.json
npm run check:vault-feed-reader -- --vault <feed-copy> --json /tmp/feed.json
npm run check:kanban -- --vault <kanban-copy> --json /tmp/kanban.json
npm run check:dataview -- --vault <dataview-copy> --json /tmp/dataview.json
npm run check:tasks -- --vault <tasks-copy> --json /tmp/tasks.json
npm run check:quickadd -- --vault <quickadd-copy> --json /tmp/quickadd.json
npm run audit:plugins -- --vault <another-copy> --json /tmp/plugin-audit.json
```

- `check:plugin-support` 在複本加入 fixture，10 項驗收須全部通過。
- 七個具名 harness 要求複本安裝上表的精確版本；會隔離啟用清單／設定並加入 fixture，請勿重用複本。
- `audit:plugins` 沿用既有啟用清單，不加入 fixture；以正常 boot 啟用社群外掛，輸出每個 id／版本／結果。
- audit 的 `loaded` 表示 enablePlugin 成功且實例仍在；`failed` 表示觀測到失敗；`unobserved` 表示證據不足。
- audit 完成時 exit 0，外掛失敗屬盤點結果；無法完成或參數／守門錯誤為 exit 2。讀取 `summary`，不要把 exit 0 當成全部相容。
- 若原生 watcher 出現 `EMFILE`，可加 `CHOKIDAR_USEPOLLING=1`。本輪複本排除 `.git/`、`.docusaurus/`、`node_modules/`、網站產物 `build/`。

## 後續支援工作

本輪整合驗證：334/334 單元測試、21 支 harness／239 項斷言全數通過，包含真實網路安裝；
doctor 與 dev mode 的實際瀏覽器啟動通過。73 個 JavaScript 檔案語法檢查通過，
vendor manifest 記錄的四個資產雜湊一致，版本庫內沒有授權聲明文字。
所有寫入驗證均在獨立 vault 複本進行；本機原生 watcher 額度不足，以 polling 驗收。

1. 以 audit 選定外掛與實際使用情境，將失敗分成載入、fs、網路、視窗或 L3 邊界。
2. 每個新增 L2 API 先建立 Node 對照測試，再用真 renderer probe 驗證外掛載入路徑。
3. 已驗收的七個外掛依上表擴充情境；下一步可驗 Kanban 拖曳、Tasks 自訂狀態、QuickAdd 互動／Macro，以及跨外掛互通。
4. 同步 fs、crypto、stream 等未支援介面依外掛需求逐項補齊；不要以空 stub 假裝成功。
5. L3 需要獨立設計執行隔離、授權與資源限制；維持現有明確拒絕，不能直接把 server shell 接給外掛。

平行分工：三個 subagent 分別負責 Kanban、Dataview、Tasks／QuickAdd 的真功能驗收；主導者負責共用 runtime 修正、文件與完整整合驗證。
