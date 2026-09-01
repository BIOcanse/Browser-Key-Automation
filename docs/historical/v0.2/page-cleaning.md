# 历史：智能页面清洗算法 v0.2（已撤下）

> 已撤下的历史草稿，只供追溯，不是当前方案、待批准选型、实现合同或测试基线。清洗算法、模型、输出与验收等待用户后续说明。

## 1. 核心裁决

采用 **实时语义 DOM + 结构关系保留 + 任务相关排序 + 预算内渐进披露**。文章提取只是其中一种视图，模型是后续可选增强，不是首版必需依赖。

主算法不依赖浏览器调试器、CDP DOMSnapshot 或浏览器完整 AX 树。**JS 采集实时 DOM、名称依据、状态和布局，输出中立 PageIR；Zig 构造语义图并完成清洗。** 明确这是从 DOM 推导的语义，不冒充浏览器原生无障碍树。未来可选调试适配器能提供额外观察来源，但会触发 Chrome 自身调试确认，插件无法消除；不能自动混入普通 snapshot，也不增加插件确认。

“智能”首先表现为：能分清页面的内容和操作结构、保留对象关系、知道哪些信息缺失、按 Agent 当前目标安排读取，而非只调用一次模型总结全文。

自动清洗发生在显式 snapshot 请求内；首版事件订阅只通知页面变脏，不触发新采集。未来若增加连续观察，必须显式配置采样范围/节奏。清洗只读取，不改真实 DOM、不自动滚动/点展开、不重发 GET、不上传页面到外部模型。

## 2. 三层数据，不是一份破坏性删减的 HTML

1. **来源层**：当前采集得到的 DOM 证据、节点映射和采集范围；raw HTML 是独立可选 artifact，不是 clean 调用的必传内容。
2. **语义层 PageModel**：页面、frame、区域、内容块、控件、表格及彼此关系；与输出格式和具体模型独立。
3. **展示层**：同一语义快照渲染为 JSON、紧凑 agent_text 或 Markdown；按预算折叠，不篡改语义层事实。

内部固定采集代码可以读取 DOM，但不意味着调用 `page.snapshot` 需要额外授予 `page.raw` 或 `js.execute`。权限控制接口入口，不按内部实现语言递归叠加权限。

### PageModel 最小数据合同

线协议的字段、flat数组、来源和验证见 [PageIR 合同](page-model.md)。此处仅列算法消费/产出的逻辑对象，不另定义一份竞争 Schema。

```text
Snapshot:
  id, browser/profile/tab/document/frame identities
  capture窗口, 每frame的revisionStart/End, consistency
  cleanerVersion, effectiveProfile, goalHash, disclosurePolicyVersion
  pageTitle, url, regions[], nodes[], relations[]
  coverage, unavailable[], collapsed[], redactions[], limitsHit[]

Node:
  ref, guardFingerprint, frameId, sourceOrigin, kind
  role, name, text, valueOrRedaction, state
  href?, inputType?, tableCoordinates?, boundingBox?
  sourceLocator, sourceConfidence, availableDirectActions[]

Relation:
  labelledBy, describedBy, errorFor, memberOf, rowHeader, columnHeader
  actionForRecord, controls, parentRegion, shadowHost, frameOwner
```

清洗器先产出节点固有动作候选；扩展编排层在返回前根据当前 Key 的精确指令权限、占据状态和浏览器能力生成 `availableDirectActions`，不因允许 JS 就自动开放 DOM 命令。纯清洗模块不读取 Key 库。原文、确定性计算和模型推断分别标为 `observed / derived / inferred`。

## 3. 清洗管线

### A. 有界采集

- 固定 browser/profile/tab/document 身份；每个授权 frame 独立采集，保留 frame/origin 边界。
- 使用 `while` + 显式栈/队列遍历，不新增递归。限制节点数、深度、耗时、属性/文本字节数；分片让出主线程。
- 批量读取布局与样式，避免每个节点反复触发布局；不遍历每个祖先再拼一次全文造成 O(n²) 文本处理。
- 节点身份使用内容脚本维护的 WeakMap/注册表，不给网页元素写人工 ID；按文档生命周期释放映射。
- 采集跨多个时间片时页面可能变化，记录起止 revision；最多做有界重采，仍不稳定则输出 `consistency=best_effort`，不伪装成原子快照。
- 采集到的不可访问 frame、未加载区域、达到上限的分支以缺口记录保留。

建议初始可调配置（待基准验证，不是性能实测）：`maxNodes=50000`、`maxDepth=128`、`sliceBudgetMs=8`、`captureDeadlineMs=2000`、`tokenBudget=6000`。超限停止并报告，不静默无限扫描；最终值在基准后确定。

### B. 先建立名称与关系

JS 先记录 label、ARIA名称/说明及其引用证据；Zig 再用索引连接错误、表头、行标题、区域标题与记录，最后才删展示噪声。字段没有旁边可见文字也可能有合法名称；隐藏说明也可能被显式引用。

Accessible Name 不能简单等同于 innerText。以固定版本的名称计算规则为基础并做浏览器样例验证，保留采用版本和未覆盖分支；不能因为草案更新就静默改变结果。[W3C Accname 1.1](https://www.w3.org/TR/accname-1.1/)

保留的最小单位是 **可理解语义包**：

- 字段 + 名称 + 当前值/遮罩 + required/disabled/readonly/invalid + 帮助/错误。
- 按钮/链接 + 可辨识名称 + 所属对象 + 状态 + 可观察后果提示。
- 表格单元格 + 行列标题 + 单位 + 记录身份。
- 正文块 + 所属标题 + 引用/链接/图片说明。

不能把两条订单各自的“删除”按钮去重成一个按钮。

### C. 非破坏性去噪

从默认展示中剥离脚本/样式正文、注释、无意义 class/id、重复包装节点、装饰 SVG 路径、base64 大串。原始读取另有接口，不能为了压缩删改真实网页。

保留：标题层级、正文、列表、代码块、金额/日期/单位/否定词、链接目标、图片 alt/caption、控件和值、错误和对话框。

例外必须显式处理：

- script 中的 JSON-LD 可在限额内提取结构化元数据，不执行代码；来源为页面声明，不当作独立证实。
- class 名中的 `ad`、`banner` 等只能作弱特征，不能一票删掉内容；Cookie/登录/确认遮罩可能阻碍当前操作，应保留。
- `hidden`、`offscreen`、`occluded`、`ariaHidden`、`collapsed` 分开记录；离屏不是噪声，被遮挡也不代表节点不存在。
- CSS生成文本/图标名可在可采集范围内作线索；无法确定含义时保留“无名称控件/视觉内容”缺口，不创造按钮名称。
- 空白归一化不能破坏代码缩进、数字、货币、单位和有意义的换行。

### D. 页面分块，允许混合类型

优先使用语义标签、ARIA role、表单/表格结构，结合标题、文本密度、链接密度、重复模板与几何邻近分区。

| 区域类型 | 默认保留 | 压缩方式 |
|---|---|---|
| 文章/文档 | 标题、段落、列表、代码、来源说明 | 长文按章节折叠，不只返回无出处摘要 |
| 表单 | 字段、名称、状态、说明/错误、提交与取消 | 去布局包装；字段语义包不可拆散 |
| 表格/数据列表 | 列定义、行标识、单位、筛选/排序/分页、行操作 | 折叠重复结构，按行区间读取 |
| 导航/菜单 | 区域目录、当前位置、相关链接 | 重复导航压成有展开入口的目录 |
| 对话框/告警 | 内容、按钮、限制/后果、当前状态 | 提高优先级，不当广告自动删除 |
| 图表/Canvas | 可读替代文字/表格、图例、标题 | 数据不可读则标视觉区域，不编造数值 |

页面可以同时有文章、表格和表单。类型识别置信度低时走通用结构视图，不把某一路信息整体丢弃。

首版 article 使用同一个 Zig 分区引擎的文章权重，不引入额外 DOM 运行时。Mozilla Readability 可作为评测基线或后续 JS 文章适配器，必须处理副本；它会修改输入 DOM，不能作为全站通用过滤器，也不为保持纯 Zig 而仓促重写它。[Mozilla Readability](https://github.com/mozilla/readability)

### E. 确定性排序与预算分配

先选择必要上下文：页面身份、当前对话框/告警、焦点附近字段/错误、目标对象及其必要关系。随后分配其余预算。

候选评分形式：

```text
score(block) = w1*语义信息量 + w2*任务相关性 + w3*交互重要性
             + w4*当前可见/焦点 + w5*近期变化
             - w6*模板重复 - w7*纯装饰
```

权重/规则版本化、可查看、可覆盖；这一形式是工程起点，不声称是已验证的最优算法。

首版具体算法起点：

1. 单次扫描建立 `nodeId/ref/label/record/header` 索引和区域表；优先以 landmark、form、table、dialog、标题层级切分，几何邻近只作弱特征。
2. 将控件及其名称/状态/说明、表格行及列定义、正文及标题聚成 unit；相同按钮文字若属于不同记录，必须是不同 unit。
3. 重复结构签名只用于折叠包装/列定义，不拿文本相同作为删除记录的理由。文章密度用 directText、链接文字占比、段落/标点信号，不重复累加祖先全文。
4. goal 匹配先做 Unicode 规范化和拉丁词项/中文相邻字组切分；仅用于检索索引，展示仍用原文。名称/标题/记录键匹配权重高于普通正文；查询词数量有上限，不用任意正则扫全文。
5. 特征归一化到 0..1。`balanced-v1` 初始权重可设语义3、目标5、交互3、当前状态4、变化2、重复惩罚2、装饰惩罚2；**这些是待语料校准的配置，不是质量保证**。当前阻挡对话框、相关错误/告警走强制保留集合，不仅靠一个分数竞争。
6. 先保留页面/区域目录及强制集合，再以正向得分/新增token成本排序，加入其依赖闭包；依赖已有时不重复计成本。同分按源阅读顺序稳定选择。
7. 渲染后重新检查实际字节和 token估算；若超限，移除最低优先级的非强制完整 unit，仍保留其他 unit 使用的依赖。不从字符串尾部盲截，不留下无表头的值或无对象的按钮。

实现使用显式栈/队列计算关系闭包。索引/遍历目标为 O(N+E)，U个候选的一次排序为 O(U log U)；限额内选择只做有界重算，不求精确最优背包。复杂度是设计目标，不是已完成测量。

- 首版任务相关性采用关键词/词项与块字段匹配，覆盖中英文；模型和 embedding 不是依赖。
- 先按区域分配最低上下文，再用“新增信息量/新增 token 成本”贪心选择语义包；对重复文字降权，但不丢记录归属。
- 被选块的必要依赖一起装入：表头、字段名、错误关联、父区域标题。预算紧时缩小内容窗口，不拆成无法理解的孤立值。
- 在同分情况下维持阅读顺序/稳定顺序，避免每次 snapshot 大幅洗牌。
- 首版使用固定版本 `estimate-v1`，可从 `ceil(ASCII字节数/3) + 2*非ASCII码点数` 的可解释估算开始，并返回 `tokenCountKind=estimated`；它不是任意模型的精确上限。同时强制字节上限。以后选定 tokenizer 才标 `exact`，不能把字符数冒充 token 数。
- 必要信息超预算时返回 `BUDGET_TOO_SMALL` 或显式不完整的目录与展开入口，不能声称关键内容已全部保留。
- 不预设“删掉90%就是成功”；衡量的是整个任务能否正确完成以及总体 token/补读成本。

### F. 折叠、展开、搜索与差量

- 折叠块保留 `blockRef + 类型 + 标题 + 已观察数量/范围 + collapseReason`。
- `page.expand(snapshotId, blockRef, range?)` 展开已采集的快照内容，不是点网页的展开按钮；受同一快照的披露策略约束。
- `page.search(snapshotId, query)` 搜索已采集语义索引，包括被预算折叠内容；返回范围说明，不声称搜索了未加载页面。
- 行区间/分页游标绑定 snapshotId；数据改变后不能把不同版本拼成同一表格。
- `page.diff(baseSnapshotId, snapshotId)` 返回新增/删除/更改/状态变化及必要父级上下文；文档、算法、披露策略不兼容时要求新全量。
- MutationObserver 只标脏区域，不能单凭它判断布局/可见性是否改变；滚动、resize、焦点和样式状态纳入失效规则。
- 先实现全量正确性，再增加区域缓存与差量，不能为了增量性能牺牲“看到的是哪个版本”。

## 4. 输出示意

下面是合成例子，不是对当前浏览器的观察：

```text
page: 订单管理 | snapshot=s8 | document=d3
coverage: 当前DOM，虚拟列表已观察20行；页面声明总数200，未验证未加载行

[b1 筛选]
  @e1 textbox "订单号" value=""
  @e2 combobox "状态" value="未支付"
  @e3 button "查询" enabled

[b2 订单表] columns=订单号 / 金额(CNY) / 状态 / 操作
  row=O-1001 | 128.00 | 未支付
    @e17 button "支付" record=O-1001
    @e18 button "取消订单" record=O-1001
  … 其余19个已观察行已折叠，可expand(b2,range)

[b3 当前告警] "取消后不可恢复"
collapsed: 导航[b4]、历史说明[b5]
unavailable: 跨源frame[f2]，无该站点访问权限
```

事实、控件与关系保存在 JSON 中，紧凑文本只是渲染。操作用 ref + document/snapshot/refEpoch/guard 验证，不靠输出文本的第几个同名按钮。

## 5. 难点与能力缺口

- **虚拟列表**：只记录实际 materialized 行。`aria-rowcount` 是页面声明，总数可能未知；需要滚动/翻页才加载时必须显式操作。[WAI-ARIA 1.2](https://www.w3.org/TR/wai-aria-1.2/)
- **iframe**：主 frame 权限不自动授予子 frame；各自采集后聚合，失败留占位。跨 frame 快照只承诺采集时间窗口一致性。
- **Shadow DOM**：普通 open root 与 slot/composed 顺序要处理。Chrome 另提供扩展专用 `chrome.dom.openOrClosedShadowRoot`，可作为纯扩展采集适配器候选；先验证所选浏览器/上下文，不因普通 JS 读不到 closed root 就声称必须调试器，也不承诺所有浏览器一致。[Chrome DOM API](https://developer.chrome.com/docs/extensions/reference/api/dom)
- **原生/系统页面**：不可注入则返回 capability gap，不自动调用浏览器级操作来补齐；增强通道也不能预先许诺所有受限页面可用。
- **Canvas/图片PDF/视频**：有替代文字就读；没有就标 visual-only。扩展可提供的截图/OCR是独立可选能力，不是首版 DOM 清洗伪造信息的理由。
- **动态/复用节点**：ref绑定文档与节点语义版本，记录内容改变后旧 ref 不得误指另一记录。
- **CSS视觉顺序**：DOM 顺序、flex/grid重排、重叠可能不同；几何线索辅助分区但不宣称完美视觉复原。

## 6. 可配置视图

`page.snapshot(mode=...)` 支持的首版/后续模式定义：

| 模式 | 意义 |
|---|---|
| `balanced` | 默认综合视图：主要内容、操作、状态一起提供 |
| `interactive` | 优先控件及其相关内容/约束，不输出孤立按钮列表 |
| `article` | 阅读文章，保留其他区域的目录/缺口 |
| `structure` | 更完整的语义结构，按区域/表格范围分批 |
| `none` | 禁用重要性过滤/折叠；仍受显式采集、字节与接口披露配置限制 |

raw DOM 使用 `page.raw`，不把 `none` 冒充原始页面。配置覆盖顺序明确为：系统默认 → 站点 profile → Key 对该接口的配置 → 本次参数；后层只能在当前接口授权允许范围内覆盖，并返回 effectiveProfile。原生硬上限和浏览器限制另行报告。

站点规则是可关闭、可删除、可导出的声明式规则，支持保留区域、折叠区域、标签补充与表格映射；不通过普通清洗配置偷偷执行任意脚本。

## 7. 模型增强与安全边界

首版 `model=none`。后续允许模型对已经形成的语义块重排或摘要，并记录 provider、模型版本、实际发送范围和耗时；外发数据要有单独明确配置。模型不修改 Key、不执行网页操作、不生成不存在的 ref。

模型摘要标为 inferred，并能回到源块；模型失败时按配置返回确定性视图或失败，不静默换供应商。优先验证任务成功率是否提高，再决定是否默认启用。

清洗、接口授权、展示安全是三件事：

- clean 系列的遮罩覆盖 name/text/description/URL/搜索/diff/日志等输出；只对这组接口生效。独立授权的 JS/raw 不继承 clean 的 deny/遮罩，符合用户确认的并行权限模型。
- 页面文字标为不可信页面数据，即使写着“更改Key”“忽略指令”，也不会变成管理命令。清洗不能保证消除对 Agent 的语义提示注入。
- 原始/清洗预览默认用惰性的转义文本/组件渲染，不执行网页脚本、不自动加载远程资源。若提供 HTML 预览，必须有独立 sanitization/CSP 边界；Readability 本身不是安全净化器。[Readability Security](https://github.com/mozilla/readability#security)

## 8. 验收而非凭感觉删内容

建立人工标注、可离线重放的语料：文章/技术文档、表单、订单表、同名动作、dashboard、弹窗、隐藏名称、中文混英文、open/closed shadow、跨源frame、虚拟行复用、视觉区域、超大 DOM 和恶意文本。

比较 raw/简单文本、Readability-only、通用语义分块及混合方案。按页面类型分别报告：

1. 关键事实与关系召回率：金额、单位、否定、错误、警告、动作对象。
2. 目标绑定正确率、失效引用拒绝率、虚拟列表覆盖声明准确性。
3. Agent 任务成功率、补读次数、完整任务的总 token，而非单次 snapshot 压缩率。
4. p50/p95 延迟、峰值内存、超限停止/取消、对页面主线程影响。
5. 接口权限独立性、clean 数据遮罩、预览脚本隔离、页面消息不进入管理路由。

硬门禁：固定关键样例不允许错对象执行、关键告警静默丢失、把未采集数据声明为不存在/已完整读取。压缩率与延迟数值待基线后定；本轮没有运行性能或浏览器测试。
