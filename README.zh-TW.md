# Browser Key Automation

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文 | [日本語](README.ja.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md) | [Русский](README.ru.md)

Browser Key Automation 讓可信 Agent 或自動化程式透過 Manifest V3 擴充功能與一枚 API Key 操作已授權的本機 Chromium 瀏覽器。

擴充功能擁有 Key 驗證、權限、瀏覽器參照、佔用與瀏覽器操作；小型 Zig 本機 App 只負責本機路由、由 App 配發的瀏覽器 Instance 參照、檔案落地，以及它明確宣告的平台原生能力。

> 開發狀態：目前的解壓縮擴充功能開發包以 Chrome/Chromium 138 以上版本為目標；目前不是 Chrome 線上應用程式商店版本。

Chrome Web Store 工作已暫停，等待正式圖示設計。請使用 [GitHub Releases](https://github.com/BIOcanse/Browser-Key-Automation/releases)：每個 Release 固定只有兩個下載項目，`browser-key-automation-extension-v0.0.0.1.zip` 與 `browser-key-automation-local-app-v0.0.0.1.zip`。詳見 [GitHub Release 交付合約](docs/implementation/github-release-delivery.md)。

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

## 架構

```text
Agent / 自動化程式
        |
        | BKA_API_KEY + 指令
        v
Windows 或 Linux Zig 本機 App
        |
        | 本機 loopback 路由 + App 配發的 InstanceRef
        v
MV3 offscreen transport
        |
        v
擴充功能 service worker
        |
        +-- Key 驗證與權限
        +-- 佔用與執行期參照
        +-- 分頁、頁面樹、DOM、JavaScript、Artifact
        `-- 選用的平台能力要求
```

擴充功能是唯一的業務狀態擁有者。本機 App 不儲存 Key 資料庫，也不決定瀏覽器權限。每個成功連線的擴充功能都由 App 配發 Instance 參照；擴充功能不會自行產生或保存執行個體編號。

主要路徑使用一般擴充功能權限。CDP/DevTools 可維持為平行的選用能力，但 Chromium 自己的偵錯確認無法由本專案取消。

## 快速開始

### 環境需求

- Chrome 或相容的 Chromium 瀏覽器 138 以上版本
- Windows x86_64 或 Linux x86_64 本機 App
- 套件內 CLI 需要 Node.js 20 以上版本
- 只有從原始碼建置本機 App 時才需要 Zig

### 1. 建置拆分套件

```text
npm ci
npm run build:dev-package
```

建置會產生三個彼此獨立的壓縮檔：

- `out/browser-key-automation-extension-dev.zip`
- `out/browser-key-automation-local-app-windows-x86_64-dev.zip`
- `out/browser-key-automation-local-app-linux-x86_64-dev.zip`

擴充功能與本機 App 刻意分開交付。每個壓縮檔都有自己的 `START-HERE.md` 與 `SHA256SUMS.txt`。

`npm run build:github-release` 會把這些已驗證的中間套件聚合成 GitHub 使用的兩資產結構：一個擴充功能 ZIP，以及一個含 `windows-x86_64/`、`linux-x86_64/` relay 目錄與單份共用 CLI、協定、Agent skill 的 App ZIP。

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

按平台拆分的 `-dev` App 中間套件仍把 relay 放在壓縮檔根部；使用開發中間套件時請依照其中的 `START-HERE.md`。

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

## 開發

| 指令 | 用途 |
|---|---|
| `npm run generate` | 產生命令、UI、傳輸、capability 與 Freedom Point 投影 |
| `npm run check:extension` | 重新產生並型別檢查全部擴充功能 realm |
| `npm run build` | 建置擴充功能與目前平台 Zig App |
| `npm run test:unit` | 執行 UI、Key、runtime、WebSocket 與 Zig 單元測試 |
| `npm run test:runtime` | 執行單元測試及隔離 relay/Chromium 整合測試 |
| `npm run build:dev-package` | 建置擴充功能與兩個平台 App 套件 |
| `npm run build:github-release` | 建置 GitHub Releases 實際發布的兩份 ZIP |
| `npm run build:chrome-web-store:first-upload` | 建置已暫停的身分引導產物；圖示工作恢復前請勿上傳 |
| `npm run test:dev-package-smoke` | 驗證壓縮檔層級、執行檔、雜湊與 skill 參照 |

隔離整合測試使用暫存連接埠、profile 與 relay 程序，不得指向個人瀏覽器 profile 或既有的個人 App 執行個體。

## 文件

- [文件索引](docs/README.md)
- [目前裁定](docs/decisions.md)
- [進度與已驗證狀態](docs/PROGRESS.md)
- [指令合約](docs/contracts/commands.md)
- [頁面操作樹](docs/design/page-information-tree.md)
- [Freedom Point](docs/design/freedom-points.md)
- [交付結構](docs/design/delivery-layout.md)
- [Agent skill](skills/browser-key-automation/SKILL.md)

舊 Cleaner/PageIR 候選只保留在 `docs/historical/`，不代表目前產品行為。
