# 文档索引

更新：2026-08-31。本目录保存 Browser Key Automation 的产品裁定、公开合同、实现切片、验证证据和历史方案。仓库首次使用者应先阅读根目录对应语言的 README；这里面向继续开发、审查或精确调用的人。

## 文档权威顺序

同一事实出现冲突时，按以下顺序解释：

1. 用户已经冻结并记录在[裁定记录](decisions.md)中的产品事实。
2. 当前 registry，以及与其一致的[指令实现切片](implementation/command-expansion-slice.md)、[页面树实现切片](implementation/page-information-tree-slice.md)、[原生点击实现切片](implementation/real-input-slice.md)。
3. [当前进度](PROGRESS.md)顶部与最新实现/体验记录。
4. 已对齐现状的设计与合同。
5. 明确带有“实施前”“历史批次”“当时状态”的段落只解释当时为什么这样做，不能覆盖后续实现。
6. `historical/` 只供追溯，不代表当前产品行为。

Command、permission、schema、error、capability 与 Freedom Point 的机器权威分别是 `registries/*.registry.json` 和 `protocol/transport-profile.json`。生成文件、skill 中的 registry 副本和 README 都是消费端，不是平行 authoring source。

## 按目的阅读

### 安装与直接使用

- 根目录十种语言 README：安装扩展、本地 App、创建 Key、CLI 首次调用与平台边界。
- [开发交付结构](design/delivery-layout.md)：扩展、Windows App、Linux App 的拆分包层级。
- [Chrome Web Store 交付](implementation/chrome-web-store-delivery.md)：当前暂停；保留的首次上传 ZIP、图标、固定 ID 衔接与自动校验边界。
- [GitHub Release 两资产交付](implementation/github-release-delivery.md)：扩展 ZIP 与单一跨平台 App ZIP 的发布结构和验收。
- [Agent skill](../skills/browser-key-automation/SKILL.md)：通用 Agent 的实际连接、调用、页面树、等待、保存、截图、演示和 `.real` 规则。
- [真实个人浏览器验证](experience/real-browser-validation.md)：早期真实安装路径和管理页体验；其中数量与功能状态以当前 registry 和本页权威顺序覆盖。

### 理解产品模型

- [当前裁定](decisions.md)：Key-only 身份、扩展 owner、App 实例、串行、occupation、浏览器边界和已实现功能。
- [页面信息树](design/page-information-tree.md)：完整信息如何编成唯一操作树、按 Key 保存展开状态，以及一次性 view 的含义。
- [Key 鉴权](design/key-auth.md)：Root/Regular、有效期、保存与权限模型。
- [Freedom Points](design/freedom-points.md)：所有默认值、上限和可替换边界的归属。
- [图标设计](design/icon-design.md)：已裁定的 Open Frame 现代极简图标、双主稿导出和资产验证约束。
- [Zig 核心边界](design/zig-core.md)：扩展业务与薄本地 App 的职责分离。

### 精确接口与实现

- [指令合同](contracts/commands.md)
- [控制合同](contracts/control.md)
- [权威与引用](contracts/authority-and-refs.md)
- [传输合同](contracts/transport.md)
- [浏览器核心指令实现](implementation/command-expansion-slice.md)
- [页面树实现](implementation/page-information-tree-slice.md)
- [等待与保存实现](implementation/usability-wait-save-slice.md)
- [截图与演示实现](implementation/quick-screenshot-and-demo.md)
- [Windows 原生点击实现](implementation/real-input-slice.md)
- [UI 与 20 语言实现](implementation/ui-i18n.md)

较早合同中仍保留的候选结构不能覆盖 registry 与后续裁定。发现冲突时应修正文档或明确加上历史状态，不得让消费端自行猜测。

### 运行证据

`experience/` 记录真实或隔离 Chromium 交互、截图、原始输出和失败修正。重点入口：

- [页面操作树逐层示例](experience/page-tree-layer-by-layer-example.md)
- [页面树浏览器烟测](experience/page-tree-browser-smoke.md)
- [等待与保存](experience/usability-wait-save-2026-08-31.md)
- [截图与演示](experience/quick-shot-demo-2026-08-31.md)
- [Windows 原生点击最终实现验证](experience/real-input-implementation-2026-08-31.md)

体验记录是对应构建的证据，不是永久版本声明。文件中的旧包哈希、实例编号、测试数量和“尚未实现”只能解释该次运行。

### 历史与审查

- `audits/`：反证、自审查和修复依据。
- `historical/`：已放弃或被替代的 Cleaner、PageIR、旧页面模型和 Freedom Point 候选。
- [进度](PROGRESS.md)：当前项在顶部，早期批次继续向下保留；阅读旧条目必须带着当时阶段。

## 当前公开边界

- 产品只支持 Chromium 内核；当前开发扩展以 Chrome/Chromium 138+ 为目标，并在运行时逐项探测能力。
- Windows/Linux x86_64 App 均可构建和分包；Linux 尚无本项目的真实运行验收。
- Windows 声明 `native.input.click.v1`；Linux 不声明。`input_sent` 不代表网站业务完成，未知输入不能自动重放。
- 主路径使用扩展权限。CDP/DevTools 是并行可选能力，Chromium 自己的调试确认无法消除。
- 当前 loopback profile 不是端到端加密通道；relay 不做 Key 鉴权，但能看见它转发的明文业务载荷。
- 页面模型是可展开的完整 canonical 操作树，不是删除式清洗，也没有隐藏 selection 或“重点区”。

## 多语言仓库入口

仓库 README 参考 Smart Preload 已验证结构，固定为十份完整文件：

```text
README.md
README.zh-CN.md
README.zh-TW.md
README.ja.md
README.ko.md
README.de.md
README.fr.md
README.es.md
README.pt-BR.md
README.ru.md
```

英文是默认入口；其余语言文件保持相同章节拓扑和技术标识。简体与繁体必须独立维护，不做自动字形替换。修改公开能力、安装步骤、包名、命令或平台边界时，应同步十份 README，并运行 `npm run test:readme-i18n`。

许可证尚未由项目裁定；在仓库出现并确认真实 `LICENSE` 前，README 不声明或复制其他项目的许可证。
