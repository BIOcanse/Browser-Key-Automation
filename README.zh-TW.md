# Browser Key Automation

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文 | [日本語](README.ja.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md) | [Русский](README.ru.md)

Browser Key Automation 把你正在使用的 Chromium 瀏覽器變成供可信 Agent 與自動化程式使用、由 Key 劃定權限的控制面。擴充功能只需安裝一次；建立 Key 後，獲授權用戶端不必另開自動化瀏覽器，就能隨時跨越現有的已登入分頁工作。

主路徑使用一般擴充功能 API，不接入 CDP、WebDriver、遠端偵錯開關或 `chrome.debugger`。Chromium 仍負責擴充功能安裝、網站存取與一次性的 **Allow User Scripts** 設定；完成這些正常設定後，日常瀏覽器指令不會附加偵錯器，也不會顯示 Chrome 的偵錯連線確認或警告列。

## 為什麼選擇 Browser Key Automation

- **無縫操作眼前這一個瀏覽器。** 隨時列出、建立、選取、導覽、重新整理與關閉分頁，同時保留使用者真實的登入狀態、Cookie、擴充功能與手動到達的頁面狀態。
- **把完整網頁變成 Agent 看得懂的乾淨視圖。** 快取的 canonical 操作樹始終保留整體結構，只展開請求的分支；每枚 Key 的展開狀態會保留到文件改變，並可一次性讀取指定深度、區間或子樹而不改變快取狀態。
- **用 Key 劃定信任，而不是暴露偵錯端點。** Root/Regular Key 具有明確權限、有效期、再次顯示、停用與撤銷控制。同一 Key 的呼叫串行，不同 Key 可以互不干擾地工作。
- **一個後綴切換到原生點擊。** Windows 上的 `dom.click.real` 會把擴充功能取得的元素幾何資訊交給本機 App，在網頁拒絕合成 DOM 啟用時傳送作業系統級滑鼠左鍵點擊；目標仍須存活、可見、可用且未被遮擋。
- **檔案是一等能力。** 一鍵儲存 MHTML、擷取可見視埠、把資源取得為有界 Artifact 並落盤、上傳自包含 HTML，再無需本機 Web 服務直接在瀏覽器開啟展示。
- **為可信多用戶端協作準備。** Key 可佔用分頁或全域以避免髒狀態；其他有權 Key 必須先明確解除原佔用，再自行取得佔用。

### 使用路線比較

連線模型核對於 2026-09-01。這裡比較一般使用路線，不比較理論功能上限。

| 路線 | 能否使用現有已登入 Chromium | 一般控制路徑 | 最適合 |
| --- | --- | --- | --- |
| **Browser Key Automation** | 可以，可跨任意已授權分頁 | 一般擴充功能 API + Key 驗證；本機 App 補充路由、檔案與可選 `.real` 點擊 | 無需附加偵錯器的長期可信 Agent 控制、選擇式快取樹與一體化檔案流程 |
| [Playwright](https://playwright.dev/docs/api/class-browsertype)、[Puppeteer](https://pptr.dev/guides/browser-management)、[Selenium](https://www.selenium.dev/documentation/overview/) | 一般路線建立自動化工作階段，也都存在連接現有 Chromium 的方式 | Playwright/CDP、Puppeteer/CDP 或 WebDriver | 確定性測試、跨瀏覽器驗證、CI，以及成熟的定位與偵錯生態 |
| [Playwright MCP 擴充功能](https://github.com/microsoft/playwright/tree/main/packages/extension#readme) | 可以；profile token 可取消其自身後續連線審批 | 透過宣告 Chrome `debugger` 權限的擴充功能轉送 Playwright | 在選定現有分頁上使用 Playwright 動作與 accessibility snapshot |
| [Chrome DevTools MCP](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect) | 可以，但要先開啟遠端偵錯或公開偵錯端點 | DevTools/CDP；Chrome 的 auto-connect 路線每次偵錯工作階段都要求使用者允許 | Console、Network、Performance、記憶體等深度 DevTools 診斷 |
| [Browser MCP](https://browsermcp.io/) | 可以，但要由使用者先連接目前分頁 | 擴充功能 + 本機 MCP，作用於明確連接的工作分頁 | 面向一個已選現有分頁的精簡 MCP 能力面 |
| [Chrome MCP Server](https://github.com/hangwin/mcp-chrome) | 可以，可跨分頁 | 擴充功能 + native-messaging bridge；manifest 在一般擴充功能權限外還要求 `debugger` | 豐富的跨分頁 MCP、網路擷取、下載與檔案上傳工具 |
| [Nanobrowser](https://github.com/nanobrowser/nanobrowser) | 可以 | 基於 Puppeteer/CDP 的瀏覽器內整合 Agent，使用者提供 LLM provider Key | 一體化多 Agent UI，而不是與 provider 無關的瀏覽器控制面 |

Browser Key Automation 不取代 Playwright/Selenium 測試套件，也不取代 DevTools 深度診斷。它填補的是另一塊：低摩擦、可設定權限地控制人正在使用的瀏覽器，並提供足夠乾淨的結構與檔案能力，讓 Agent 完成實際工作。

> 開發狀態：目前的解壓縮擴充功能開發包以 Chrome/Chromium 138 以上版本為目標；目前不是 Chrome 線上應用程式商店版本。商店頁面仍在準備；完成前請使用 [GitHub Releases](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest)。每個 Release 固定只有兩個下載項目：`browser-key-automation-extension-v0.0.0.2.zip` 與 `browser-key-automation-local-app-v0.0.0.2.zip`。

## 目前能力

- 在本機管理頁建立、顯示、複製、更新、停用與撤銷 Root/Regular Key。完整 Key 儲存後仍可再次顯示，不限於只顯示一次。
- 列出分頁，並使用繫結目前執行期的 `TabRef`、`DocumentRef`、`NodeRef`、`TreeRef` 與 `ArtifactRef`，而不是裸瀏覽器 ID。
- 瀏覽快取的頁面操作樹。展開狀態按 Key 儲存；頁面文件未重新整理或替換時，切走再回來仍會保留。
- 不展開樹即可尋找節點；一次性讀取指定層級、同父區間或子樹；讀取有界 live DOM、描述節點並執行 DOM 操作。
- 開啟 Chromium 的 **允許使用者指令碼 / Allow User Scripts** 後，在明確的 `USER_SCRIPT` 或 `MAIN` world 執行 JavaScript。
- 等待導覽、`interactive`、`complete`、DOM 或文字條件。
- 將目前網頁儲存為 MHTML、取得經驗證的視埠截圖、傳輸有界 Artifact，以及在沒有本機 HTTP 伺服器的情況下開啟自包含 HTML 展示。
- 透過 `dom.click.real` 傳送明確的 Windows 原生滑鼠左鍵點擊；其權限獨立於一般 `dom.click`。
- 讓某個 Key 佔用分頁或全域範圍。其他獲授權的 Key 必須先明確解除原佔用，再自行取得佔用。

精確方法、schema、權限與錯誤以 Command Registry 為準。`system.describe` 會回報目前建置及呼叫 Key 的實際有效權限。

## 快速開始

### 環境需求

- Chrome 或相容的 Chromium 瀏覽器 138 以上版本
- Windows x86_64 或 Linux x86_64 本機 App
- 套件內 CLI 需要 Node.js 20 以上版本

### 1. 下載擴充功能與 App

從[最新 Release](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest) 下載兩個 ZIP，分別解壓縮到獨立目錄。

- 擴充功能: `browser-key-automation-extension-v0.0.0.2.zip`
- 本機 App: `browser-key-automation-local-app-v0.0.0.2.zip`

App ZIP 內含 `windows-x86_64/`、`linux-x86_64/`、CLI 與 Agent skill，無需自行編譯。

### 2. 載入擴充功能

1. 完整解壓縮擴充功能套件。
2. 開啟 `chrome://extensions`、啟用開發人員模式，選擇 **載入未封裝項目**。
3. 選取根目錄直接包含 `manifest.json` 的解壓縮目錄。
4. 在擴充功能詳細資料頁啟用 **允許使用者指令碼 / Allow User Scripts**，然後重新載入擴充功能。此瀏覽器控制的開關只對 `js.execute` 必要；未啟用時 Key 管理、DOM 與頁面樹仍可使用。
5. 從工具列開啟 **Browser Key Automation**。完整可信控制可建立 Root Key；要限制範圍時建立只含必要權限的 Regular Key。

首次安裝會開啟本機設定頁；一般更新與重新載入不會反覆開啟。

### 3. 啟動本機 App

解壓縮 GitHub Release 的 App 套件，並保持目前平台的 relay 執行：

```text
# Windows
.\windows-x86_64\browser-key-relay.exe

# Linux
chmod +x ./linux-x86_64/browser-key-relay
./linux-x86_64/browser-key-relay
```

預設端點為 `127.0.0.1:32189`。App 無法使用時，擴充功能會依目前設定的名義 10 秒間隔持續重新連線，直到成功。固定端點已由相容 App 使用時，請勿再啟動第二份。

### 4. 連接 CLI

在解壓縮後的本機 App 目錄執行：

```text
node client/browser-key-cli.mjs instances
```

此指令不需要 Key。0 個執行個體表示擴充功能尚未連線；存在多個執行個體時，必須明確選擇目前有效的 `relayEpoch/instanceNumber`，不得將 bearer Key 逐一嘗試。

Key 只能透過環境變數提供，不可放入 argv：

```powershell
# PowerShell
$env:BKA_API_KEY = "bk1.<key-id>.<secret>"
node .\client\browser-key-cli.mjs call --method system.describe --schema-version 1 --params-json "{}"
```

```bash
# Bash
export BKA_API_KEY='bk1.<key-id>.<secret>'
node client/browser-key-cli.mjs call --method system.describe --schema-version 1 --params-json '{}'
```

CLI 會先重新列舉執行個體，再讀取 Key。若 delivery 回報為 `unknown`，就應視為確實未知；不可自動重試有副作用的指令。

## 常用流程

- 頁面探索：`tabs.list` → `page.tree.open` → `page.tree.find` 或 `page.tree.expand.v2` → `page.tree.view.get`。
- 頁面同步：使用 `page.wait`；省略 timeout 時為 10 秒，條件已滿足會立即回傳。
- 儲存網頁：`node client/browser-key-cli.mjs page-save --tab-ref <TabRef> --output ./page.mhtml`。
- 擷取視埠：`node client/browser-key-cli.mjs page-shot --tab-ref <TabRef> --output ./page.png`。
- 開啟展示：`node client/browser-key-cli.mjs demo-open ./demo.html`。
- 呼叫不熟悉的指令前，先查看 `skills/browser-key-automation/references/commands.registry.json`；隨附的 Agent skill 含相同的產生參照。

### 原生 `.real` 點擊

`dom.click.real` 是明確且獨立於 `dom.click` 的能力。在 Windows 上，它會要求啟用目標分頁並聚焦其瀏覽器視窗，驗證參照元素仍存在、可見、可用且未被遮擋，再要求本機 App 對匹配的 Chromium 內容視窗傳送一次原生左鍵點擊。

`{ "status": "input_sent" }` 只表示一組輸入已被接受，不代表網站已完成業務目標；之後必須重新觀察頁面。未知或失敗的原生輸入絕不可自動重播。Linux App 目前不宣告 `native.input.click.v1`，因此擴充功能會在任何頁面準備動作之前拒絕 `.real`。

## Key、權限與佔用

- Key 是唯一外部身分。Agent 品牌、程序、帳號、socket 與 App 執行個體都不是額外的授權身分。
- Root 動態擁有全部 active 權限；Regular 只擁有明確選取的權限。
- JavaScript、一般 DOM 操作、原生 `.real` 輸入、網路存取與未來偵錯後端是平行權限；授予其中一項不會暗中授予其他項。
- 同一 Key 的指令在目前擴充功能執行期內序列化。不同 Key 有獨立 lane，但對同一網頁的效果仍可能競爭。
- 佔用歸 Key 所有。沒有隱藏 takeover、force 或 replace：必須先 release，再 acquire。
- 完整 Key 保存在擴充功能內部。受信任的管理頁，以及另外獲授權 `keys.create` 或 `keys.reveal` 的呼叫方可以取得它；一般清單與診斷不包含完整 Key。CLI 只從 `BKA_API_KEY` 或明確指定的環境變數讀取。

高權限 Key 等同於本機瀏覽器控制憑證，只應交給可信 Agent 或自動化程式。Key 的技術權限永遠不能替代使用者對付款、發文、傳送訊息、變更帳號、刪除資料等重要操作的授權。

## 瀏覽器與平台邊界

Chromium 仍控制 host access、受限頁面、file URL 存取、**允許使用者指令碼** 開關、擴充功能啟停與 DevTools 偵錯確認。Root 無法繞過這些瀏覽器邊界。

Windows/Linux App 都提供路由與檔案落地；Windows 額外宣告目前的原生點擊後端，Linux 暫不宣告。無痕模式及其他 Chromium 衍生瀏覽器必須依各自 profile 與原則實際驗證。

Agent 接入：[Browser Key Automation skill](skills/browser-key-automation/SKILL.md)。

本專案由作者維護，不接受外部貢獻或 Pull Request。
