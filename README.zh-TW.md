# Browser Key Automation

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文 | [日本語](README.ja.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md) | [Русский](README.ru.md)

**讓 Agent 直接使用你正在用的瀏覽器。**

Agent 可以沿用已登入的 Chromium 分頁，按需閱讀網頁、執行操作，無縫接管。

## 為什麼使用

- **網頁很大，檢視可以很小。** 快取操作樹保留整體結構，只展開需要的分支。切換分頁後，只要文件未變，展開狀態仍在；深度、區間與子樹是一次性檢視選擇，而不是有損改寫網頁。
- **隨時跨分頁工作。** 以明確的分頁參照閱讀、導覽及操作。每個 Key 依序執行，搭配分頁、視窗或全域占用，減少協作衝突。
- **直接取得結果。** 一鍵儲存 MHTML、擷取網頁或 Canvas／圖表元素、傳輸資源；提交 HTML 即可開啟展示，無須本機網頁伺服器。
- **選用合適的輸入。** DOM、Windows 真實點擊與鍵盤，以及獨立虛擬滑鼠與鍵盤各有用途；需要深入診斷時再啟用 CDP。
- **確認結果，不只送出動作。** `ensure.run` 整合條件、有限等待與準備、動作及可觀察目標。未知結果會明確回報，不盲目重播不可重複的動作。

## 開始使用

> 每次全新安裝都會建立相同的**公開 Root 試用 Key**，具體值在 Agent skill 中。它不是私人憑證。個人瀏覽器請建立私人 Key、切換用戶端，再撤銷試用 Key；只建立新 Key 不會停用舊 Key。更新不會恢復。

1. 需要 Chromium **138+**、Windows 或 Linux x64 App；CLI 需要 **Node.js 20+**。從[最新 Release](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest)下載兩個壓縮檔並分別解壓縮。

   - `browser-key-automation-extension-v0.0.0.5.zip`
   - `browser-key-automation-local-app-v0.0.0.5.zip`

2. 於 `chrome://extensions` 啟用開發人員模式，載入根目錄含 `manifest.json` 的擴充功能。工具列圖示可開啟 Key 管理。`js.execute` 需要在詳細資料啟用 **Allow User Scripts / 允許使用者指令碼**；DOM 與操作樹不需要此開關。

3. 依下列指令啟動對應 App。Windows 的 `virtual-mouse-hook.dll` 必須與程式放在一起。尚未連線時，約每 10 秒重試 `127.0.0.1:32189`。

```text
# Windows
.\windows-x86_64\browser-key-relay.exe

# Linux
chmod +x ./linux-x86_64/browser-key-relay
./linux-x86_64/browser-key-relay
```

4. 為 Agent 安裝或載入包內 `skill/browser-key-automation/SKILL.md`。先列舉實例並選定瀏覽器，再以環境變數 `BKA_API_KEY` 提供私人 Key，不放進命令列參數，也不逐一試探其他實例。

```text
node client/browser-key-cli.mjs instances
node client/browser-key-cli.mjs call --method system.describe --schema-version 1 --params-json "{}"
```

## 從網頁到結果

先以 `system.describe` 查詢目前版本與有效權限。完整參數請查閱[指令登錄表](dev/skills/browser-key-automation/references/commands.registry.json)，不要猜測參照格式。

| | API / CLI |
| --- | --- |
| 檢視 → 選擇 → 展開 | `tabs.list` → `page.tree.open` → `page.tree.find` / `page.tree.expand.v2` → `page.tree.view.get` |
| 等待網頁條件 | `page.wait` · `ensure.run` |
| 儲存網頁 / 網頁截圖 / 元素截圖 | `page-save` · `page-shot` · `element-shot` |
| 上傳並展示 HTML | `demo-open` |
| DOM / 真實點擊 | `dom.click` · `dom.click.real` |
| 精確文字 / 快捷鍵 / 釋放按鍵 | `keyboard.type` · `keyboard.typeHuman` · `keyboard.press` · `keyboard.reset` |
| 虛擬滑鼠 / 鍵盤 | `virtualMouse.*` · `virtualKeyboard.*` |
| 量測原生輸入目標 | `input.calibrate` |
| 動作庫 | `actions.create` · `actions.list/get` · `actions.run` |
| DOM / Windows 真實錄製 | `recording.start/pause/resume/stop` → `actions.compile` |
| 上傳、下載與對話框 | `files.upload` · `downloads.*` · `dialogs.*` |
| 網路與診斷 | `network.*` · `console.*` · `performance.*` |
| 整頁 / 區域 / 元素截圖 | `page.screenshot.fullPage/region/element` |
| 瀏覽器資料與搜尋 | `search.tabs` · `semantic.search` · `bookmarks.*` · `history.*` |
| 視窗與檢視區 | `windows.*` · `page.viewport.get` · `page.zoom.set` |
| 明確啟用 CDP | `debugger.attach` → `debugger.send` → `debugger.events.get` → `debugger.detach` |

```text
node client/browser-key-cli.mjs page-save --tab-ref <TabRef> --output ./page.mhtml
node client/browser-key-cli.mjs element-shot --node-ref <NodeRef> --width 800 --height 600 --output ./element.png
node client/browser-key-cli.mjs demo-open ./demo.html
```

可以直接儲存指令序列，也可以錄製後編譯，檢查條件後依動作編號重播。Windows 真實錄製會保留視窗變動，排除目標視窗外的滑鼠軌跡；外部 App 依可見視窗區域記錄原生像素座標，包括上一頁、下一頁兩個側鍵。權限、準備條件與重播範圍請見[動作與錄製](dev/skills/browser-key-automation/references/actions-and-recording.md)。

## Key 與輸入邊界

- Root 擁有所有有效權限；Regular Key 可透過可展開的權限群組設定，並支援期限、再次檢視、停用與撤銷。JavaScript 和原生輸入權限獨立。Key 不等於替使用者付款、發布或刪除的授權。
- 指令提交時只驗證一次；進入佇列後依提交時的權限執行，Key 後續到期、停用或撤銷只影響新提交。已接受的工作仍依自身期限及明確的停止、釋放指令運行。
- 虛擬輸入狀態綁定 Key，跨分頁保留，必須先占用整個目標視窗。普通虛擬輸入動作使用有效的 `input.calibrate` 校準；`ensure.run` 會檢查並按需更新。真實輸入要求前景視窗，虛擬輸入不移動實體滑鼠。
- Windows 提供原生輸入；Linux 目前提供瀏覽器路由與檔案流程，不提供原生鍵鼠。不支援最小化視窗；首次校準需要可量測網頁，遮蔽時沿用校準有條件限制。多視窗首次校準與完整原生 HTML5/OLE 拖放仍有未解情境。
- 元素截圖只擷取目前可見視口及支援的形狀遮罩，不重建隱藏內容。Chrome 管理受限網頁、網站存取及使用者指令碼開關；`debugger.attach` 保留偵錯提示。合成 DOM 事件與虛擬視窗訊息不能繞過所有輸入限制。

## 適用情境

BKA 是目前針對個人 Agent 助手情境最全面的瀏覽器自動化擴充功能，一次授權，隨時使用。真正讓 Agent 成為你的助手。

| | |
| --- | --- |
| [Playwright](https://playwright.dev/docs/intro) · [Selenium](https://www.selenium.dev/documentation/overview/) | 跨瀏覽器測試與 CI |
| [Puppeteer](https://pptr.dev/) | 可程式化瀏覽器自動化 |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | 提供無障礙快照的 Agent 工具 |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | 深入瀏覽器診斷 |
| [Browser MCP](https://browsermcp.io/) · [Chrome MCP Server](https://github.com/hangwin/mcp-chrome) | 連接既有瀏覽器的 MCP 工具 |
| [Nanobrowser](https://github.com/nanobrowser/nanobrowser) | 瀏覽器內的 Agent 介面 |

## 指南與維護

[Agent skill](dev/skills/browser-key-automation/SKILL.md) · [Operation tree](dev/skills/browser-key-automation/references/operation-tree.md) · [Ensure](dev/skills/browser-key-automation/references/ensure-workflows.md) · [Virtual input](dev/skills/browser-key-automation/references/virtual-mouse.md) · [Capture & CDP](dev/skills/browser-key-automation/references/debugger-and-element-capture.md)

擴充功能 UI 支援 20 種語言，倉庫指南有十個語言版本。[隱私說明](PRIVACY.md) · [開發目錄](dev/README.md)。本專案由作者維護，不接受外部貢獻或 Pull Request。
