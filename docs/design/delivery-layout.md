# 开发交付结构

更新：2026-08-29。本文冻结 Browser Key Automation 的开发包交付层级。它参考本机 Smart Preload 的已验证发布结构：浏览器扩展与本地 App 分别打包，扩展包根目录直接含 `manifest.json`，平台 App 包根目录直接含可执行文件和自己的启动说明。

## 无损描述

- 浏览器扩展是一个独立交付物。用户解压后，把该目录本身交给 Chrome；不需要理解总包、子目录或本地 App。
- 本地 App 是另一个独立交付物。用户按平台下载并解压，目录根部直接看到可执行文件；Agent 客户端、配套 skill、精确 command/Freedom registry references 和 transport profile 随 App 交付。
- Windows 与 Linux 是同一个本地 App 的两个平台产物。开发中间包仍按平台分开；GitHub Release 的单一 App 下载包只在交付层聚合，并把两个 relay 隔离在明确的平台目录。
- 不再把 extension、Windows relay、Linux relay 和 client 套进一个 combined ZIP 作为主要安装入口。

## 当前产物

```text
out/
|-- browser-key-automation-extension-dev/
|   |-- manifest.json
|   |-- START-HERE.md
|   |-- SHA256SUMS.txt
|   `-- ...扩展运行文件
|-- browser-key-automation-extension-dev.zip
|-- browser-key-automation-local-app-windows-x86_64-dev/
|   |-- browser-key-relay.exe
|   |-- START-HERE.md
|   |-- SHA256SUMS.txt
|   |-- client/
|   |-- protocol/
|   `-- skill/browser-key-automation/
|-- browser-key-automation-local-app-windows-x86_64-dev.zip
|-- browser-key-automation-local-app-linux-x86_64-dev/
|   |-- browser-key-relay
|   |-- START-HERE.md
|   |-- SHA256SUMS.txt
|   |-- client/
|   |-- protocol/
|   `-- skill/browser-key-automation/
`-- browser-key-automation-local-app-linux-x86_64-dev.zip
```

ZIP 只负责传递。Chrome 不能直接加载 ZIP；解压 extension ZIP 后，选择解压出的 extension 目录。该目录根部直接存在 `manifest.json`，不会再出现“还要进入内部 extension/”的第二层判断。

## 构建与验收

1. 一次构建生成当前扩展和两个平台的 ReleaseSafe relay。
2. 三个目录独立 staging、独立 SHA-256 清单、独立归档。
3. extension 验收必须证明 `manifest.json` 位于目录和 ZIP 根层。
4. 每个平台 App 验收必须证明对应 executable 位于目录和 ZIP 根层，并且不夹带另一平台 executable。
5. 两个平台 App 验证 skill frontmatter、页面树 reference 与生成 registry 同步；Windows 成品 App 另用包内 relay 与包内 CLI 跑完整实例选择、路由、Key 脱敏和 stop 回环。
6. 旧 combined `browser-key-automation-dev` 产物不再发布；新的说明、README 和真实体验日志只引用拆分产物。

## 独立构建入口

- `npm run build:dev-package:extension` 只重建 extension 目录与 ZIP，不停止、替换或重写本地 App 包。
- `npm run build:dev-package:local-app` 只重建 Windows/Linux 本地 App 目录与 ZIP。
- `npm run build:dev-package` 保留为全量构建，按顺序生成两类独立交付物。

分开交付也必须分开更新；修改 extension UI 时不应因为打包器耦合而中断正在运行的本地 App。

## GitHub Release 下载面

开发阶段仍保留三个独立中间包，便于只重建扩展或只验证某个平台。GitHub Release 则按用户下载职责收敛为恰好两个资产：一个 extension ZIP，一个 local App ZIP。后者只合并交付层，Windows/Linux relay 仍在各自平台目录，公共 CLI、协议与 skill 只出现一次。完整结构见 [GitHub Release 两资产交付](../implementation/github-release-delivery.md)。

## Chrome Web Store 包

Web Store 包不是开发扩展 ZIP 的改名副本。`npm run build:chrome-web-store:first-upload` 从同一 `out/extension` 运行产物建立独立 ZIP，只在上传副本中移除开发固定 `key`，并排除 `START-HERE.md`、内部 SHA 清单和本地 App。该流程目前按用户裁定暂停，等待图标设计确认；现有 ZIP 不上传。恢复后首次上传仅用于取得 Dashboard Item ID/public key；同步固定 ID 与 App Origin 门禁并递增版本后才能发布。完整合同和验收项见 [Chrome Web Store 交付切片](../implementation/chrome-web-store-delivery.md)。

## 参考证据

- 参考仓库：`https://github.com/BIOcanse/Smart-Preload`；本轮只读本机快照位于 `F:\CodeArchive\D-Code\Chrome extension`。
- 其 `scripts/package-release.ps1` 分别建立 `$ExtensionStage` 与 `$AppStage`，并分别生成 extension/app ZIP；商店 ZIP 与 reviewer bundle 也保持独立路径。
- 已有 `zero-latency-web-extension-v1.0.18.zip` 的根层含 `manifest.json`；`zero-latency-web-app-windows-x64-v1.0.18.zip` 的根层含 exe、`START-HERE.md` 和注册脚本。
- 这里只复用交付层级，不引入 Smart Preload 的 Native Messaging、安装注册或自动唤起模型；本项目既定的 Key-only 扩展鉴权和薄 relay 架构不变。
