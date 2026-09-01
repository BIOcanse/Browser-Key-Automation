# 使用闭环：等待、定向查找与一键保存

状态：2026-08-31 已实现、隔离回归与分包校验通过。个人浏览器与旧 App 未自动切换。用户已批准上一轮使用场景建议，并补充等待级别、默认 10 秒、已完成提示、GUI 式网页另存为，以及自由点贯彻检查。

## 最简逻辑与边界

扩展持有 Key、权限、页面引用和业务状态。等待只观察指定标签页，查找只在既有完整树中定位；二者不导航、不展开树、不重放动作。配套 CLI 明确组合采集、读取和保存文件；常驻 Zig App 仍只转发并分配实例，不新增业务状态所有者。

不修改树的编排/选择算法，不添加重点区、自动跳层、占据抢占、自动业务重试或 CDP 回退。测试使用既有隔离 Chromium 路线，不覆盖当前用户已加载的开发包或停止个人 App。

## 本轮接口

### page.wait

- 必需 `tabRef`；`until` 可省略，默认 `complete`；`timeoutMs` 可省略，默认 **10000 ms**。
- 加载等级：`committed`（目标导航已提交）、`domcontentloaded`（DOM 内容加载事件已发生）、`complete`（浏览器页面加载完成）。已达到所选等级立即返回，不等下一次导航，也不刷新页面。
- 可显式限定目标 URL；另允许明确的节点出现/消失/可见/启用和节点文字条件。加载已 complete 不代替显式 DOM/文字条件满足。
- 返回 `already_satisfied | satisfied | timed_out`、实际等待时间和当前观测摘要；`already_satisfied` 有明确提示。超时只是等待条件未满足，不表示之前的动作失败。
- 挂起导航时，不能把旧文档的 complete 当成目标新文档完成。关闭、替换或无法证明的目标身份变化仍明确失效；不换标签页猜目标。
- 一次调用只有一个等待期限，无后台持久任务或额外状态缓存。默认值、最大等待时间和观测间隔都由自由点生成；调用者可用参数覆盖允许范围内的超时。

### page.tree.find

在已打开树的指定范围按显式文字、角色或 CSS 条件查找，允许查折叠分支；结果保留 canonical indexPath、TreeRef 和可用的 NodeRef。查找不改变任何 Key 的展开集合，不建立第二棵树。扫描/结果有显式预算与截断标志；实际未覆盖范围不能声称“没有匹配”。继续使用现有 expand 和一次性 view。

### DOM 与默认参数

动作前检查节点仍属于目标实时文档；禁用控件的无效点击不能被描述为已经生效。动作回执仅说明本次 DOM 操作，不保证网站业务完成，不在失败/未知后重放。

`setValue` 补充明确的 contenteditable 纯文本替换路径，并返回实际观察的值/描述。普通 input/select 行为不借此变成浏览器可信硬件输入，不承诺适配所有富文本框架。

首次分页游标、默认页大小、focus/scroll 机械参数可省略；省略值在正式入口依照生成默认值解析一次。显式目标、URL、输入内容不猜测。

### 一键保存网页与 Artifact

配套 CLI 提供 `page-save --tab-ref ... --output ...`，以及可直接调用的一键保存函数。默认保存 MHTML 单文件：调用已有 `page.archive.capture`，再读取 Artifact、解码、校验长度和 SHA-256，最终得到真实本地 `.mhtml` 文件。不是只返回 ArtifactRef，不打开系统另存为对话框，也不需要用户逐块操作。

独立 `artifact-save` 复用同一文件保存函数。固定一次选择的实例与 Key；目标文件默认不得覆盖，失败不留下看似完整的成品；未显式要求不释放原 Artifact，不重做 capture。MHTML 是当前页面归档，不冒充首次导航原始响应，也不承诺所有动态资源离线可运行。

### 权限与构建可见性

既有 `system.describe` 补当前 Key 已解析的有效权限与扩展构建标识，仍需 `system.read`。App 在既有连接/实例诊断中暴露自己的公开构建标识；不扩展成来源鉴权或健康管理服务。

## 文件职责

- `registries/`：指令、参数/结果、权限、能力与自由点的唯一声明源；纠正仍描述历史方案的 authoring 文档。
- `tools/generate-*-config.mjs`：校验关联并生成扩展、CLI、Zig 所需投影；客户端不得继续手写另一套 endpoint/块大小/default。
- `apps/extension/src/background/page-wait-service.ts`：目标观测与有限等待；由 dispatcher 鉴权、归一化和排队。
- `apps/extension/src/background/page-tree-service.ts`：复用原 canonical 遍历与引用进行查找，不重建树模型。
- `apps/extension/src/background/dom-service.ts`：节点有效性及文本输入；其他服务保持各自所有权。
- `apps/client/src/`：CLI 编排、连接会话和文件保存，各模块按职责分开；不把文件传输循环塞进 relay。
- `tests/`：等待阶段/已满足/超时/旧文档、折叠树查找、DOM 无效目标、文件分块与完整性/目标已存在、自由点变更传播。

## 验收

1. 省略等待超时为 10 秒；显式超时生效；已完成默认等待立即提示；阶段和 DOM 条件分别测试。
2. 一条命令取得可读取的真实 MHTML 文件，长度/哈希与 Artifact 一致；默认不覆盖、不重放、不隐式删除。
3. 改动代表性自由点后，生成配置和真实消费者行为相应改变；非法/default 超界、缺失消费者和失配引用明确阻断。
4. 原 Key/occupation/同 Key 串行、39 条既有命令和页面树生命周期保持回归；新指令纳入 registry 和隔离真实 Chromium 测试。
5. 分别交付扩展和 Windows/Linux App 包；Linux 若只有交叉构建则如实标注，个人实例更新状态单独说明。

## 验证记录

Node 53 项、Zig 10 项通过；完整隔离 Chromium 回归通过，新功能实际交互 33 步并保存 2402 bytes MHTML，长度及 SHA-256 复算一致。分包校验覆盖扩展 30 文件、Windows/Linux App 各 12 文件，含 ZIP 解压与摘要检查。配套 skill 通过 quick_validate。

主线程裁决并修复了 CLI 重复 transport 配置、缺失 typed 默认投影，以及 find 错用原生 childCount 漏掉规范树分支的问题；原有标签摘要改成预算内逐节点遍历。测试还直接改变代表性自由点，验证正式 parser/生成配置接线。没有增加第二业务 owner 或全仓通用配置框架。

逐步观测、原始样本、测试命令、分包及限制见[交互与交付记录](../experience/usability-wait-save-2026-08-31.md)。Linux 只完成交叉构建和包格式验证，未做 Linux 运行测试；历史偶发 MHTML STORAGE_UNAVAILABLE 仍未定位，不因本批成功而宣称根治。
