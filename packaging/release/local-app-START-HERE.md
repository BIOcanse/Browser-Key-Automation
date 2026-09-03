# Browser Key Automation 本地 App

版本：`{{VERSION}}`

这是 GitHub Release 中与浏览器扩展分开交付的本地 App 包。它只负责 loopback WebSocket 路由、由 App 分配的 InstanceRef、Agent 客户端传输和明确声明的平台原生能力；Key 鉴权及全部浏览器业务状态仍由扩展拥有。

## 启动

完整解压 ZIP，不要直接在压缩包内运行文件。把目录放到稳定位置，然后按平台执行：

Windows x64：

```powershell
.\windows-x86_64\browser-key-relay.exe
```

Linux x64：

```bash
chmod +x ./linux-x86_64/browser-key-relay
./linux-x86_64/browser-key-relay
```

Linux 包当前提供路由和文件落地，但不声明 `native.input.click.v1`；Windows 包包含当前 `.real` 点击后端。

默认监听 `127.0.0.1:32189`。若端口已占用，不要改端口或启动第二份 App；先确认已有 listener 是否是兼容版本。扩展未连接时按 10 秒周期继续尝试。

## Agent 客户端

CLI 需要 Node.js 20 或更高版本。无需 Key 即可枚举实例：

```text
node client/browser-key-cli.mjs instances
```

- 0 个实例：确认扩展已启用，等待一个 10 秒周期并核对固定扩展 ID。
- 恰好 1 个：可继续调用。
- 多个：显式选择目标 InstanceRef，不默认选择第一个，也不拿 bearer Key 逐个尝试。

客户端只从 `BKA_API_KEY` 环境变量读取完整 Key，拒绝命令行 Key 参数，stdout 会脱敏完整 Key 形状。常用入口：

```text
node client/browser-key-cli.mjs page-save --tab-ref <TabRef> --output ./page.mhtml
node client/browser-key-cli.mjs page-shot --tab-ref <TabRef> --output ./page.png
node client/browser-key-cli.mjs element-shot --node-ref <NodeRef> --width 800 --height 600 --output ./element.png
node client/browser-key-cli.mjs demo-open ./demo.html
node client/browser-key-cli.mjs stop
```

发送后连接失败可能返回 `delivery: "unknown"`，不得自动重试有副作用指令。`stop` 只关闭本地 App，不吊销 Key，也不自动释放扩展 occupation。

元素截图使用已有截图与 Artifact 读取权限，返回等比居中、形状外透明的 PNG。调试通过 `call` 下的 `debugger.attach/send/events.get/detach` 使用独立权限组；Chrome 自身的调试提示保留。两者都由扩展实现，本地 App 不新增截图或 CDP 服务。

## Agent Skill

`skill/browser-key-automation/` 是配套 Agent skill。安装或直接加载其中的 `SKILL.md`；精确命令和 Freedom Point 上限位于同目录 references。公共 CLI、协议与 skill 在本跨平台包中只保留一份。

`SHA256SUMS.txt` 覆盖本目录中除清单自身以外的全部文件。本 App 未进行代码签名，操作系统首次运行时可能显示来源提示。
