# Browser Key Automation 浏览器扩展

版本：`{{VERSION}}`

固定扩展 ID：`{{EXTENSION_ID}}`

这是 GitHub Release 中独立交付的 unpacked Chromium 扩展。Chrome 不能直接加载 ZIP；完整解压后，应选择根部直接含 `manifest.json` 的目录。

## 安装

1. 在地址栏打开 `chrome://extensions`，开启“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择本包解压目录本身。
3. 核对名称、版本和上面的固定扩展 ID；ID 不同就停止，错误 Origin 无法连接本地 App。
4. 打开扩展详情，开启 **Allow User Scripts / 允许用户脚本**，然后重新加载扩展。该开关由浏览器管理，插件和 Root Key 都不能代开。
5. 点击扩展图标进入 Key 管理页，创建并保存 Root 或按权限配置的 Regular Key。
6. 另行下载同一 Release 的 `{{APP_PACKAGE}}.zip`，解压并按其中 `START-HERE.md` 启动当前平台的本地 App。

本地 App 未运行时，扩展每 10 秒继续尝试连接。管理页显示的“后台已连接”只表示页面连接到扩展后台；本地实例是否 ready 以 App 包内 CLI 的 `instances` 返回为准。

扩展拥有 Key 鉴权、权限、页面引用、占据和浏览器操作。本地 App 不保存 Key 数据库，也不决定浏览器权限。只应把完整 Key 交给可信 Agent 或自动化程序。

Chrome Web Store 发布仍按独立的商店身份与审核流程推进；本包用于 GitHub 手动安装，不是商店上传包。

`SHA256SUMS.txt` 覆盖本目录中除清单自身以外的全部文件。
