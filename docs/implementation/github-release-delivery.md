# GitHub Release 两资产交付

更新：2026-09-01。

本切片只定义 GitHub Release 的下载结构，不改变扩展、Key、命令、relay、InstanceRef、页面树或 `.real` 的运行合同。图标已经单独设计并由用户确认；Chrome Web Store 仍保持暂停，只有用户明确恢复后才继续。

## 无损描述

一个 GitHub Release 只给用户两个下载项：

1. 扩展 ZIP。用户解压后，选择根目录直接加载 `manifest.json`。
2. 本地 App ZIP。公共 CLI、协议和 Agent skill 只放一份；Windows x64 与 Linux x64 的 relay 分别放在清楚命名的平台目录里。

GitHub Release 不上传校验旁文件或说明旁文件，避免出现第三个下载项。两个 ZIP 的 SHA-256 写进 Release notes；每个 ZIP 内仍有自己的 `SHA256SUMS.txt`，覆盖解压后的全部文件。

## 目录

扩展包：

```text
browser-key-automation-extension-v<version>.zip
├── manifest.json
├── START-HERE.md
├── SHA256SUMS.txt
└── ...扩展运行文件
```

本地 App 包：

```text
browser-key-automation-local-app-v<version>.zip
├── START-HERE.md
├── SHA256SUMS.txt
├── windows-x86_64/
│   └── browser-key-relay.exe
├── linux-x86_64/
│   └── browser-key-relay
├── client/
├── protocol/
└── skill/browser-key-automation/
```

这里的“一个 App 包”只合并交付，不合并平台二进制。Windows 与 Linux relay 仍由同一 Zig 源码分别交叉编译，Linux 不因此声明尚未实现的 native click 后端。

## 构建

```powershell
npm run build:github-release
```

Release tag、资产名与说明中的版本统一取扩展 `manifest.json` 的版本；根 `package.json` 的版本只描述私有 Node 构建工具，不作为产品发布版本。

构建顺序：

1. 用现有 `build:dev-package` 生成并校验 extension、Windows App、Linux App 三个独立中间包。
2. 扩展 Release 包直接复用完整 extension 中间目录。
3. App Release 包比较 Windows/Linux 中间包的 `client/`、`protocol/` 与 `skill/` 文件集合和内容；完全一致后只复制一份公共文件，再复制两个平台 relay。
4. 重新生成两个 Release 目录各自的内部 SHA-256 清单，并从目录根部创建 ZIP。
5. 在 `out/github-release/v<version>/` 生成不上传的总 SHA 清单与 Release notes。

中间开发包继续保留原先的三包结构，便于按平台独立测试；只有 GitHub Release 的用户下载面收敛为两个资产。

## 验收

- Release 输出恰好有两个待上传 ZIP，文件名不含 `dev`。
- 扩展 ZIP 根部直接存在 `manifest.json`，固定开发 ID 与本地 App exact-Origin 匹配。
- App ZIP 根部直接存在平台目录、公共 CLI、协议、skill 和启动说明。
- Windows relay 是 PE，Linux relay 是 ELF；两个二进制不放错目录。
- Windows/Linux 中间包的公共文件逐字节相同；不以任选一份掩盖构建漂移。
- 两个 ZIP 解压后的文件集合与打包目录一致，内部 SHA 清单和 Release notes 的外部 ZIP SHA 均可复算。
- Release 页面不是 draft，并且资产数量精确为 2。
- Chrome Web Store ZIP、商店说明、源码、缓存和私钥都不进入 Release 资产。

## Chrome Web Store 暂停边界

GitHub 扩展 ZIP 使用用户已确认的现代极简正式图标。`build:chrome-web-store:first-upload` 及其本地产物只保留作后续流程基础，不上传 Dashboard、不放 GitHub Release，也不提交审核。图标确认本身不恢复商店 identity、listing 素材或发布工作。
