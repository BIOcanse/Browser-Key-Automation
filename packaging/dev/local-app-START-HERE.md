# Browser Key Automation 本地 App

平台：`{{PLATFORM}}`

这是与浏览器扩展分开交付的本地 App。它只负责 loopback WebSocket 路由、relay-assigned InstanceRef 和 Agent 客户端传输；Key 鉴权与全部业务状态仍由扩展拥有。

## 启动

1. 完整解压本地 App ZIP，不要直接在 ZIP 内运行文件。
2. 把目录放在稳定位置。
3. `{{PREPARE_COMMAND}}`
4. 启动：`{{START_COMMAND}}`
5. 默认 App 监听 `127.0.0.1:32189`。保持它运行；扩展正常调度下每 10 秒尝试连接，直到连上。地址与时间由 build Freedom Points 生成。

若端口已占用，不要改端口或启动第二份 App；先确认已有 listener 是否是兼容版本。

## Agent 客户端

包内客户端需要 Node.js 20 或更高版本。无 Key 枚举实例：

```text
node client/browser-key-cli.mjs instances
```

- 0 个实例：确认扩展已启用，等待一个 10 秒周期并核对固定扩展 ID。
- 恰好 1 个：可以继续调用。
- 多个：停止，不默认选第一个，也不把 bearer Key 逐个试过去。

`instances` 返回 `relayBuildId`；扩展的 `system.describe` 返回自身 buildId 和当前 Key 的实际权限。请搭配同包 CLI 使用，不要混入其他版本的 CLI。

首次安装扩展会打开介绍页。需要 `js.execute` 时，应在 `chrome://extensions` → 本扩展的“详情”中开启“允许用户脚本 / Allow User Scripts”，再重载扩展；Root Key 也不能替代这个浏览器开关。未启用时错误会附 `setupInstructions`，Agent 应将步骤告知操作者，不要循环重试。DOM/树读取和 Key 管理不受这个开关阻断。

一条命令把网页保存为实际本地单文件（父目录需存在，不覆盖已有文件）：

```text
node client/browser-key-cli.mjs page-save --tab-ref <TabRef> --output ./page.mhtml
```

它复用扩展 MHTML 抓取/Artifact 读取，自动校验长度与 SHA-256。保存失败可用 `artifact-save --artifact-ref <ref> --output <path>` 读取已抓取的 Artifact，不自动重抓。细节见配套 skill 的 `references/wait-and-save.md`。

一键网页视口截图，以及提交自包含 UTF-8 HTML 演示（无需本地 HTTP 服务）：

```text
node client/browser-key-cli.mjs page-shot --tab-ref <TabRef> --output ./page.png
node client/browser-key-cli.mjs element-shot --node-ref <NodeRef> --width 800 --height 600 --output ./element.png
node client/browser-key-cli.mjs demo-open ./demo.html
node client/browser-key-cli.mjs demo-open ./updated.html --tab-ref <已有演示页的TabRef>
```

截图需要 `page.screenshot.capture` 与 `artifact.read`；演示需要 `artifact.write` 与 `demo.open`。Regular Key 在管理页授予这些权限，Root 自动包含。截图目标需已是当前标签，默认 PNG；演示默认新建并选中标签，不请求 OS 前台，`--active false` 可不选中。完整参数、函数入口和失败处理见 skill 的 `references/quick-shot-and-demo.md`。

元素截图复用相同权限，按元素及子元素几何生成透明 PNG，等比居中放入指定矩形。调试使用通用 `call` 下的 `debugger.attach/send/events.get/detach`，需要独立 `debugger` 权限，Chrome 调试提示不会隐藏。详细边界见 skill 的 `references/debugger-and-element-capture.md`。

客户端只从 `BKA_API_KEY` 环境变量读取 Key，拒绝把 Key 放进命令行参数；最终 stdout 会脱敏任何完整 API Key 形状。发送后若连接失败，可能返回 `delivery: "unknown"`，且不会自动重试。

停止本地 App：

```text
node client/browser-key-cli.mjs stop
```

停止本地 App 不吊销 Key，也不自动释放扩展内部 occupation。

## Agent Skill

`skill/browser-key-automation/` 是配套 Agent skill。把该目录安装到 Agent 的 skills 目录，或让支持本地 skill 的 Agent 直接加载其中的 `SKILL.md`。它会使用本包 CLI，Key 仍只从环境变量读取。

skill 的精确命令依据是自身 `references/commands.registry.json`，数值上限依据是 `references/freedom.registry.json`；两者由扩展 registry 同步生成。页面读取默认采用 `page.tree.open → page.tree.expand.v2 → page.tree.view.get`，不会使用已移除的 selection 或猜测 schemaVersion。

`SHA256SUMS.txt` 覆盖本目录内除清单自身外的所有文件。本开发产物未签名，操作系统首次运行时可能显示来源提示。
