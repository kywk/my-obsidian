# 聲明與免責（NOTICE）

使用 my-obsidian 前請完整閱讀本文件。首次啟動的同意畫面會要求你逐項確認其中的重點。
Short English summary at the end.

---

## 1. 所有權：Obsidian 屬於 Obsidian

- **Obsidian** 的軟體、程式碼、名稱、標誌與商標，以及其著作權，**全部屬於其權利人**
  （Obsidian／Dynalist Inc.）。本專案對其不主張任何權利。
- **my-obsidian 與 Obsidian 沒有任何隸屬、贊助、合作或背書關係。**
  它是獨立的第三方專案，不是 Obsidian 的官方產品，也不代表 Obsidian 的立場。
- 專案名稱中的「obsidian」僅用於**描述相容對象**，不表示來源或授權。
  若你要重新散布或衍生本專案，請自行評估名稱與商標的使用，必要時改名。
- 外掛、主題與你 vault 中的內容，各自屬於其作者與你本人，與本專案無關。

## 2. 本專案包含與不包含什麼

| | |
|---|---|
| **包含** | 本 repo 的原始碼（宿主 server、shim、runtime、驗收工具、文件），以 MIT 授權釋出（見 [`LICENSE`](LICENSE)） |
| **不包含、不散布** | Obsidian 的任何程式碼或資產。`vendor/` 由 `npm run vendor` 在**你的機器上**，從**你自己已安裝**的官方 Obsidian 取得，並且被 `.gitignore` 排除 |
| **不修改** | 取得的 renderer 與官方檔案位元組一致；本專案不 patch、不重新封裝、不繞過它的任何檢查 |

**MIT 只涵蓋本 repo 的程式碼。** `vendor/` 內的內容不適用 MIT，仍受 Obsidian 自己的條款約束。
請**不要**把 `vendor/` 提交到任何 repo、打包成映像檔或壓縮檔轉交他人。

## 3. Obsidian 的條款，以及你的責任

- Obsidian 不是開源軟體，使用受其官方條款約束：<https://obsidian.md/terms>。
  條款可能隨時改變，**以官方當下版本為準**，本文件不是它的替代或摘要。
- 新版 renderer 在啟動時會要求宿主提供一段聲明字串，並與自己內建的比對。
  **本專案不內建、不代填這段字串。** 它由你本人從自己機器上的 `vendor/obsidian/app.js` 取出、
  貼到同意畫面並確認，之後只存在你本機的設定檔（預設
  `~/.config/my-obsidian/config.json`，權限 0600）。
  **按下確認的人，就是做出該聲明的人**；同意畫面也會把你勾選的項目、時間與聲明版本記錄在同一個檔案。
- **用途界線：** 本專案設計給**你自己在自己的機器、自己的 vault** 使用。
  把 Obsidian renderer 送到其他人的瀏覽器（團隊共用、客戶、公開網站、託管服務），
  在字面上落在該聲明的射程內，**需要 Obsidian 團隊的明示同意**。
  取得同意、或決定不這麼做，是**操作者**的責任，不是本專案的責任。
- `--auth-token` 只是共用密碼，不是授權機制，也不構成對第三方提供服務的許可。

## 4. 免責聲明

本軟體依 MIT 授權以**「現狀」（AS IS）**提供，**不附任何明示或默示的保證**，
包含但不限於適售性、特定用途適用性與不侵權。在法律允許的最大範圍內，
作者與貢獻者**不對任何索賠、損害或責任負責**，不論基於契約、侵權或其他理由，
也不論是否因使用或無法使用本軟體而產生。

特別提醒（這些風險是本軟體的運作方式本身造成的）：

- **資料風險：** 服務對你指定的 vault 擁有**完整讀寫權限**，並會**執行 vault 內的社群外掛程式碼**。
  寫入並非原子操作；與桌面版 Obsidian、同步工具（Dropbox 等）或 git 同時寫入同一檔案可能產生衝突或遺失修改。
  **請先備份你的 vault，並先用副本試用。**
- **安全風險：** 預設只綁 `127.0.0.1`。若你改綁其他位址，等於把整個 vault 交給所有連得到的人；
  TLS、防火牆與存取控制由你負責。
- **相容性：** 只驗證過特定的 Obsidian 版本（見 README）。Obsidian 自動更新後可能無法開機；
  本專案**不保證**跟上任何版本。
- **第三方內容：** 外掛、主題、更新與從網路取得的內容不受本專案控制，也不由本專案背書。
- **非法律意見：** 本文件是專案的善意說明，**不是法律意見**。若你有商業或對外提供的需求，請諮詢專業人士並直接聯繫 Obsidian。

## 5. 隱私

本專案不蒐集、不回傳任何遙測。server 只在你本機執行；唯一的對外連線是社群外掛瀏覽／安裝時，
由 `/api/proxy` 向固定的 GitHub／Obsidian 網域取得資料（見 README〈安全性〉）。

## 6. 回報

發現本專案侵犯你的權利、或對 Obsidian 的使用有疑慮，請開 issue 說明；我們會優先處理。

---

## English summary

- **Obsidian belongs to its owner.** Its code, name, logo and trademarks are theirs. This project is
  an **unofficial, independent** tool with **no affiliation, sponsorship or endorsement**.
- This repository contains **no Obsidian code**. The renderer is extracted on **your** machine from
  **your own** installed Obsidian (`npm run vendor`) and must not be redistributed. MIT covers this repo only.
- Obsidian's own terms (<https://obsidian.md/terms>) apply to you. You supply the acknowledgement the
  renderer asks for; this project never ships or fills it in for you.
- Intended for **personal use on your own machine and vault**. Serving the renderer to other people
  requires Obsidian's explicit permission, which is the operator's responsibility.
- Provided **AS IS, without warranty**. The service has full read/write access to your vault and runs
  its community plugins: **back up first**. Authors are not liable for any loss.
- Not legal advice.
