# 首次安装与用户脚本提示：交互记录

2026-08-31。本批实现本地介绍页、Key 管理页的权限状态、正式错误返回的开启步骤，以及配套文档/skill。本文件中的 `.real` 状态只代表该安装引导批次；Windows 原生点击随后已完成，现状见[实现切片](../implementation/real-input-slice.md)和[最终交互记录](real-input-implementation-2026-08-31.md)。

## 真正走过的流程

本次使用独占临时 Chromium/profile，未动个人浏览器、账号、Key 或 App。完整原始页面状态保存在[welcome-interaction.json](D:/Code/浏览器自动化插件/out/test-artifacts/isolated-N14pZ1/out/test-artifacts/welcome-interaction.json)，执行结果保存在[results.json](D:/Code/浏览器自动化插件/out/test-artifacts/isolated-N14pZ1/results.json)。

| 步骤 | 操作 | 实际观察 |
|---:|---|---|
| 1 | 新 profile 安装 unpacked 扩展 | 安装事件自行打开 `admin/welcome.html`，不是测试额外打开一个标签页冒充自动入口。标题为“开始使用 · Browser Key Automation”。 |
| 2 | 查看说明页 | 状态为 required，说明如何开启 Allow User Scripts、重载扩展及重新枚举实例。介绍页同时说明 Key、App、Agent 的分工。 |
| 3 | 检查桌面与 390px 窄屏 | 页面没有横向溢出；按钮和设置地址可操作，窄屏卡片纵向排列。 |
| 4 | 点击“打开扩展权限设置” | 扩展通过 tabs.create 打开自身准确 ID 对应的 `chrome://extensions/?id=...`，不是让用户再找别的扩展。 |
| 5 | 在浏览器详情中打开真实开关 | 只在隔离测试浏览器中操作 Chrome 的“允许用户脚本”。插件本身没有代开能力。 |
| 6 | 回到介绍页点击“重新检测” | 当前说明页被重新加载，取得新脚本上下文；状态变为 ready，“用户脚本已启用”。 |
| 7 | 进入 Key 管理 | 同一套状态检查显示 ready；Key 创建、重复显示/隐藏、旧 Key 补存、吊销、worker 回收后的管理页恢复等既有测试保持通过。 |

“重新检测”只刷新说明/管理页面，不等于重载整个扩展。Chrome 对 API 可用性的上下文缓存意味着开启后仍可能需要在详情页重载扩展；文档和业务错误均明确提示。引导不是新的全局能力锁：DOM/树读取和 Key 管理仍可用。

## 截图

已逐张查看以下实际截图，未用设计稿代替运行结果：

- [完整桌面说明页](D:/Code/浏览器自动化插件/out/test-artifacts/isolated-N14pZ1/out/test-artifacts/welcome-ui.png)
- [390px 窄屏说明页](D:/Code/浏览器自动化插件/out/test-artifacts/isolated-N14pZ1/out/test-artifacts/welcome-ui-mobile.png)
- [已启用后的 Key 管理页](D:/Code/浏览器自动化插件/out/test-artifacts/isolated-N14pZ1/out/test-artifacts/admin-ui-mobile.png)

## Agent 能收到的提示

已有业务错误协议没有公开普通 Error.message，所以不能只改内部报错文字。本批在既有能力错误 schema 中增加可选 `setupInstructions`；仅用户脚本未启用时返回固定、随包维护的操作说明，其他错误不泄露 Chromium 原始异常文本。

```json
{
  "code": "CAPABILITY_UNAVAILABLE",
  "details": {
    "capabilityId": "platform.extension.user_scripts",
    "reason": "USER_SCRIPTS_NOT_ENABLED",
    "setupInstructions": "请在 chrome://extensions 中打开 Browser Key Automation 的详情，启用“允许用户脚本 / Allow User Scripts”，然后重新加载本扩展并重新枚举实例。此浏览器开关须由用户手动开启；Root Key 不能替代它。"
  }
}
```

这是已声明的返回形态；对应真实 JS 拒绝/开启后成功的端到端回归见最终验证记录。配套 skill 要求 Agent 读到它后告诉用户，不循环重试、不偷偷换 CDP，也不把整个扩展描述为损坏。

## 验证与范围

Node 56/56 通过，其中新增三个单测覆盖仅首次安装打开说明、只读检查的 absent/sync throw/async rejection 和操作说明进入错误 details。项目 skill quick_validate 通过。首次全套隔离测试在 UI 尺寸断言处停止：测试把含滚动条的 innerWidth 与不含滚动条的 scrollWidth 比较，观测为 1418/1403。改为 clientWidth/scrollWidth 后，上述独立 UI 回归完整通过；没有以修改页面来掩盖错误断言。协议与 CLI 两套在首次运行已通过。

没有新增业务命令、Key 权限、后台轮询或自动接管行为。App 业务代码不改；新 App 包只携带同源构建标识和更新后的 skill/说明。原始样本与截图留在上述目录，未随临时 profile 清理而删除。

`.real` 的实施前方案判断和一手资料见[本批合同中的审查](../implementation/onboarding-and-real-input.md#real本批次仅讨论后续已实现)。本批没有把可行性当作交付能力；后续 Windows 实现另行完成了窗口绑定、缩放、命中和真实输入验证。Linux 仍不声明该原生点击能力。

## 最终验证与开发包

扩展—relay 全套联调通过，[结果与日志](D:/Code/浏览器自动化插件/out/test-artifacts/isolated-Ahg5Js/results.json)保留；实际验证了 JS 关闭时返回 setupInstructions、在真实 Chrome 详情页开启后执行成功，以及既有 Key/占据/DOM/树/等待/文件功能。没有重跑此前已成功的协议与 CLI 门，只补齐首次运行尚未执行的联调。

Windows/Linux ReleaseSafe 构建成功。分包 smoke 验证扩展 33 文件、每个平台 App 12 文件，含 ZIP 解压、内容哈希及 CLI 可执行入口；Linux 仍未实机运行。项目配套 skill 已通过 quick_validate；按 skill-creator 指导将一次性浏览器设置放在现有入口，并复用生成的命令 schema，不另建指令列表。

| 包 | ZIP SHA-256 |
|---|---|
| [扩展](D:/Code/浏览器自动化插件/out/onboarding-2026-08-31/browser-key-automation-extension-dev.zip) | `4aae3aaa3404e79fcd2c64cd19e460e8e82896382bdad112b482339f5ee359ea` |
| [Windows App + skill](D:/Code/浏览器自动化插件/out/onboarding-2026-08-31/browser-key-automation-local-app-windows-x86_64-dev.zip) | `05e569ff3c8b56b71ef43a3cf5a552119f57a6964080b731f5925d7f70d53b01` |
| [Linux App + skill](D:/Code/浏览器自动化插件/out/onboarding-2026-08-31/browser-key-automation-local-app-linux-x86_64-dev.zip) | `79bfd8ae86f5245826b03aed1521fa728fe6fbdfdb3e2cdc09ffe4c4d8095a6b` |

扩展 buildId 为 `extension-b7a146a655c4342220ae618a`，relay 为 `relay-06331b8ad8e15a36521dac56`。新包放在独立目录，未覆盖旧交付。最后核对个人 32189 listener 仍为 PID 46104；没有重启、重载或替用户打开个人浏览器权限。已安装用户可重载更新后的扩展，从 Key 管理页的“安装与使用说明”进入新介绍页，不需要卸载来触发首次安装事件。
