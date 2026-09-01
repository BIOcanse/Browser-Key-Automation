# UI 精简与 20 语言

2026-08-31。用户要求：“UI优化，删多嘴文案，然后就是20国语言+简繁区分。”状态：已交付。

仓库 README 的语言集合是另一层交付：按 Smart Preload 仓库结构采用 8 种外语加简体/繁体，共 10 份完整 README。它不改变本文件冻结的 20 个扩展 UI locale，也不让 README 语言选择进入扩展运行时。

## 本轮合同

管理页直接呈现 Key 列表、创建、搜索、状态和操作。删除存储说明横幅、重复标题/用途解释、成功加载/显示的多余提示；用户脚本检测通过后不占一整块区域。保留未启用时的操作入口、Root 权限含义、结果未知恢复、过期信息和不可逆吊销提示。不改 Key、权限、占据、串行、App 或协议行为。

20 个界面语言选项：English、简体中文、繁體中文、日本語、한국어、Deutsch、Français、Español、Português (Brasil)、Italiano、Русский、العربية、हिन्दी、Bahasa Indonesia、Tiếng Việt、ไทย、Türkçe、Polski、Nederlands、Українська。简繁计为两个独立选项；按此清单先实现，不追加地区重复项。

语言选择为“跟随浏览器”或某个语言，保存于扩展页面已有同源 localStorage，多个打开的 UI 页通过 storage 事件同步。自动模式按浏览器语言顺序选择；zh-Hant/TW/HK/MO 对应繁体，zh-Hans/CN/SG 对应简体，未支持语言最终使用英语，选择框显示实际匹配语言。切换只更新文字/方向/日期，不重载页面、不丢表单/筛选/已显示 Key，不重新发出业务请求。保存偏好失败须可见提示。

管理页、弹窗、权限说明、引导页、演示外层错误文本离线本地化。品牌、API Key、KeyId、指令/权限 ID、URL 和用户内容不翻译；机器协议/CLI 保持原样。日期和数量使用所选语言的 Intl；阿拉伯语 RTL，代码/Key/地址始终 LTR。主题保留系统/浅色/深色，不添加新动效。

一份语言清单和完整字典生成 UI catalog 及 Chrome 原生 locale 消息。构建检查每种语言的键和插值参数与英文一致，不以缺译回退冒充完成。默认语言选择由自由点 registry 投影，实际用户选择覆盖默认。Chrome 自己的扩展详情/工具栏文本跟随浏览器语言，页面内选择控制本扩展 HTML UI。

## 文件落点

- `registries/ui.registry.json`：语言清单与 20 份完整文案；无远程翻译服务。
- `tools/generate-ui-config.mjs`：验证字典、默认自由点、生成 UI/native locale 产物；接入现有 generate/build/package。
- `apps/extension/src/ui/`：语言匹配/格式化与页面偏好唯一 owner。
- `apps/extension/src/admin/`、`static/admin/`：精简后的管理/引导页；原事件和业务调用复用。
- `apps/extension/src/demo/viewer.ts`：仅外层加载/错误文案，提交的 HTML 内容不动。
- `tests/`：语言匹配、字典闭合、自由点变更、真实管理页切换/表单保留/简繁/RTL/移动布局及分包检查。

## 验收

沿用独占临时端口、临时 Key、独立 Chromium 的测试入口，不操作个人 App/浏览器。生成器逐项验证 20 个词库的 113 个键及占位符；自动匹配覆盖 zh-Hant/Hans、地区别名和未知语言。真实管理页验证切换不重载、不丢已打开表单、持久选择、阿拉伯 RTL 无横向溢出、简繁页面、390 px 窄屏和 service worker 回收后的同页重连。

验收结果：`npm test` 通过 72 项 Node 与 10 项 Zig；独立 Chromium 完整 Key/UI smoke 通过；扩展、Windows App、Linux App 三个分包的清单、格式、ZIP 和摘要校验通过。稳定截图及首次安装交互 JSON 位于 `out/ui-i18n-2026-08-31/`。现行开发包位于 `out/browser-key-automation-extension-dev(.zip)`、`out/browser-key-automation-local-app-windows-x86_64-dev(.zip)`、`out/browser-key-automation-local-app-linux-x86_64-dev(.zip)`。
