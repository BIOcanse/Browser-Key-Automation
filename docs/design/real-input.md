# `.real`：扩展定位，App 执行真实点击

2026-08-31。状态：Windows 首版已按[实现切片](../implementation/real-input-slice.md)落地；本文保留实现前的完整推演，文中的候选/待实现措辞只描述当时阶段。当前 registry 为 46 条 active command、40 个 active permission、57 个 active Freedom Point；真实验收见[实现交互记录](../experience/real-input-implementation-2026-08-31.md)。

## 实测更正：前台不是总前提

[Windows / Chrome 151 实测与原始数据](../experience/native-input-2026-08-31.md) 已证明定向窗口消息能产生可信 click，也取得了另一程序前台、未观测到切换的成功样本；另一些状态下 Chrome 会在 down 自行激活。窗口 x/y/大小、Z 序、线程内焦点、系统前台必须分开。

因此，下文的“SendInput、必须前台、系统鼠标短串行”只保留为 **SendInput 候选路径**，不再是所有 `.real` 的定义。窗口消息是已验证可行的 Windows 候选，不能承诺绝不抢前台。原 `activate` 把“选中 tab”和“请求窗口聚焦”混成一项，其合并语义及对应 default_activate 自由点建议撤回，后续选定最小参数后才登记。UIA 也不是已确定的必经依赖，实际内容 HWND 的视口测量值得先验证。

本次只更正实测推翻的前提；不扩建接口、占据或后端调度框架。下面其他机制继续作为待落地草案，不冒充已完成实现。

## 1. 用一句话说明

Agent 对已有 NodeRef 调用 `dom.click.real`；扩展检查 Key 和占据、让目标进入可点击状态并取得页面内位置，App 结合实际浏览器窗口内容区换算坐标，执行一次原生点击，把输入结果交回扩展。窗口消息和系统鼠标输入是不同候选后端，副作用按实测区分。

这就是用户提出的路线：不是 CDP 转发，不伪造 DOM 事件，不改网页的信任判断。普通 `dom.click` 保持原样，不自动升级为 `.real`。

## 2. 对外只增加一个指令

最短调用与现有 DOM click 只差后缀，使用同一 NodeRef，不让 Agent 拼窗口句柄或计算坐标：

```json
{
  "method": "dom.click.real",
  "schemaVersion": 1,
  "params": { "nodeRef": "nr1.<现有节点引用>" }
}
```

可选参数建议：

| 参数 | 默认 | 含义 |
|---|---|---|
| `activate` | 初稿 true，合并语义已撤回 | 不能再用一项同时代表选中 tab、请求窗口聚焦与保证系统前台；见上方实测更正 |
| `scrollIntoView` | `true` | 必要时将目标及所属 frame 滚入可见区域；为 false 时只使用当前视口 |
| `timeoutMs` | `10000` | 本次真实输入从申请 App 执行位置到结果的总期限，包含排队与准备，不为每步重新计时；建议上限 60000 ms |

首版固定为左键单击；不顺带增加右键、双击、拖拽、键盘、截图定位或任意桌面坐标接口。以后有明确需求时分别扩展，不以 `.real` 后缀自动宣称每个 DOM 指令都有原生版本。不存在的方法仍按现行 schema 边界拒绝。

成功结果建议保持窄合同：

```json
{ "nodeRef": "nr1.<现有节点引用>", "status": "input_sent" }
```

`input_sent` 只证明平台接受了完整点击输入，不保证网页业务完成，也不保证点击后原 NodeRef 仍有效。等待跳转或业务变化继续用既有 `page.wait` / 页面树读取；不在这里强制等页面 complete，不自动重新点击。

`activate=true` 会改变前台窗口/标签页，`scrollIntoView=true` 会改变页面滚动位置，鼠标也会移动；这些必须在 Key 权限说明、安装说明和 skill 中明确。完成后不偷偷恢复焦点、滚动或鼠标位置。滚动是显式声明的点击准备，不包含改 CSS、移除遮挡、取消 disabled 或修改站点监听器。

## 3. 权限和状态归属

| 内容 | 唯一负责方 |
|---|---|
| Key 生成、鉴权、权限、到期；NodeRef/文档身份；tab/global 占据 | 扩展既有模块 |
| 点击准备、页面命中判断、frame 内位置向主页面转换 | 扩展固定 DOM 模块 |
| 当前原生窗口、网页内容区、平台坐标转换、系统输入 | App 的 Zig 原生输入模块 |
| 实例编号与连接路由 | App 既有 relay 模块，扩展仍不接收或保存实例编号 |

新增独立 permission `dom.click.real`，与 `dom.click`、`js.execute` 等并列，不互相蕴含。它授权本指令完整且已公开的准备和点击行为，不要求消费者再拼若干内部辅助权限；也不使该 Key 能直接调用未授予的 `tabs.activate` / `dom.scroll`。

扩展在现有入队/派发边界鉴权；经过 App 等待后，在首次准备动作和最终输入派发前复核当前 Key、目标和占据。检查固定定位脚本依赖的 scripting/host 能力，不要求 `js.execute` 或 Allow User Scripts。后者仍只限制任意 JS 路线。

占据继续只有 `control.acquire` / `control.release`。`.real` 不自动占据、不解除别人的占据、不引入 lease、OccupationId 或 operation ledger。若准备要切换标签页或窗口，检查目标以及实际将失去激活/焦点的本扩展可见标签页，避免借切换绕过其占据；不把无关标签页一并锁住。跨扩展实例的占据不合并成全局 Key 数据库。

## 4. 单次执行流程

```text
Agent：dom.click.real(NodeRef)
  → 扩展：鉴权、解析原有引用
  → App：轮到本次真实输入执行
  → 扩展：复核占据 → 按参数激活/滚动 → 取得可命中点
  → App：测量实际内容区、换算坐标
  → 扩展：最终复核文档、目标及命中
  → App：复核前台窗口/几何未变化 → 系统点击一次
  → 扩展：返回 input_sent 或明确失败
```

App 一次只运行一个真实输入请求，执行位置从准备前保留到输入结束，因此两个请求不会在“聚焦 A → 聚焦 B → 点击 A”之间交错。排队受数量上限和本次总期限约束；等待不能阻塞 relay 的 socket 处理。现行每 Key lane 的 Promise 必须覆盖整个 `.real` 往返，不能启动 App 请求就提前返回，让同 Key 下一条动作越过本次点击。

这只是同一桌面鼠标资源的短串行段，不是第二套 Key 队列或新的公开占据。普通 DOM、JS、读取和其他 Key 的工作继续独立；不要求先申请 global 占据。它只协调本 App 的输入，不能锁住人类、其他软件或网页脚本。用户或页面在观察后继续变化的竞态不能被宣称消除。

输入前若检测到用户仍按着鼠标键/修饰键、窗口焦点已变化或命中点不再属于目标，就停止本次点击，不抢着重试。已经发出的按下必须尽力配对释放；若系统只接受了部分输入，返回未知/失败，不能当成完全没发生。

## 5. 两端如何合出点击位置

### 扩展：确定页面里的点

1. 从 NodeRef 取得原来的 tab、精确 document 和节点，复用普通 DOM 与页面树 NodeRef 的现有解析入口，不按旧 selector 找一个替代品。
2. 按参数准备目标。使用立即滚动，不用固定 sleep 等动画；后续读取实际布局。被丢弃的标签页激活后若换了文档，原引用失效，不能悄悄对新页面点击。
3. 读取实际矩形/可见裁剪区域，先尝试可见区域中心，再在有界候选点内查找；通过命中测试确认该点属于目标或其允许接收点击的内部节点。矩形中心被挡住不等于整个元素不可点，但候选点耗尽也不能声称数学上证明处处不可点。
4. iframe 逐层映射到主页面可见视口，同时验证父层确实命中对应 frame；使用实际父子 frame 关系和变换，不能按相同 URL 或 frame 数组下标猜配对。能访问内层 DOM 不等于已经解决跨 frame 坐标；无法可靠取得父层/变换时明确返回不支持。
5. 输出本次主页面可见视口中的 CSS 点与对应视口尺寸。CSS transform、边框、裁剪、visual viewport 偏移要在这个边界归一化，App 不理解 DOM。遍历使用显式循环和上限，不新增递归。

没有布局、disabled、实际无可命中区域、页面遮挡或缺少 frame 访问能力时，不发送点击。屏幕外但能正常滚动进入视口的元素不等于隐藏元素；透明但仍可正常命中的元素也不一律拒绝。

### App：确定屏幕上的点

扩展负责 `chrome.tabs.update({active:true})` 和必要的 `chrome.windows.update({focused:true})`；两者不是同一件事。App 在本次执行中观察实际前台原生窗口，并与扩展当前目标窗口/焦点/几何事实核对，不把 Chromium 的 windowId 当作 HWND，不靠标题或 URL 唯一匹配。[Chrome tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs)、[Chrome windows](https://developer.chrome.com/docs/extensions/reference/api/windows)。

Windows 首选从目标窗口的 UI Automation 结构取得当前网页内容视口区域；UIA 只提供结构/几何，不代替真实点击调用 Invoke。必须在隔离 Chrome 上验证拿到的是视口而不是整篇文档、浏览器客户区或其他 pane。若多个候选无法区分、窗口匹配不成立或平台没有提供可靠内容区，返回能力缺口，不加固定标题栏高度、不偷偷注入标记或改页面标题匹配。[UIA 坐标约定](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-screenscaling)。

归一化后的映射只需：

```text
原生点击点 = 内容视口原生原点
           + 页面可见视口 CSS 点 ×（内容视口原生尺寸 / 页面可见视口 CSS 尺寸）
```

两端必须测量同一视口边界，不能一端含滚动条/侧栏另一端不含；边界或比例不一致直接失败。缩放、DPI、多屏负坐标由平台模块处理，不能再盲乘一次 devicePixelRatio 或页面 zoom。Wayland 使用 portal 允许的坐标空间，不假设等同 Windows 物理屏幕坐标。

测量在激活和滚动之后进行，最终按下前重新核对；只缓存本次请求需要的信息，不保存长期 `instance → HWND`、像素坐标或所谓“最后一次成功位置”。窗口关闭、移动、缩放、文档变化和断线之后不复用旧位置。

以上是待实测的实现路线，不是已证明所有 Chromium 布局都能通过 UIA 正确定位。首个实现检查点就是验证内容区测量，失败时先报告具体布局/API 缺口，不扩建一串猜测回退。

## 6. 扩展与 App 的内部协作

复用现有 extension WebSocket/offscreen 路径，新增窄的双向 native 请求分支；不再开一个 HTTP 端口，也不把 Agent 客户端变成坐标中间人。

当前只有底层双向 WebSocket：`server.zig` 的 extension 分支只接收 `route.response`，后台也没有主动 native 请求桥。这是本次真实接入缺口，不是仅添加一个 DOM handler 就能工作。需在 `transport-controller.ts` / offscreen 补后台主动请求与子回复分流；子回复不能重新进入 Key lane，否则会与正在等待它的 `.real` 互等。主 `route.response` 仍只代表整个指令结束，原生子步骤不得提前完成主 RouteTable 条目。

- Agent 可见 App 操作仍只有实例枚举、关闭、转发。不能由 client role 直接发原生点击绕过扩展鉴权。
- native 分支只允许已建立的 extension role 发起，并关联现有业务 route 与原连接；App 从当前连接核对 route 的实例归属，不信任请求自报其他实例。连接 role 只是传输分工，不是第二套业务权限。
- 内部只需要“开始本次输入/轮到执行、取得原生几何、执行点击、结束或失败”几个消息阶段。它们属于同一个短请求，不是对外 acquire/release，也不产生可跨请求复用的授权票据。
- App 只接收本次执行所需的几何和输入数据，不新增 Key 验证、KeyId 调度、DOM 树、NodeRef 表或业务结果库。当前明文 relay 已会转发带 Key 的业务 payload；这里不冒称它从来见不到 Key。
- 使用原有消息大小、来源与连接代次约束，并把原连接上下文保留到后台的主动请求；不能借最新 socket 发送旧点击。内部关联号只用于这一次往返，不是实例编号或持久化 OperationId。App 重启后不恢复旧输入请求。
- 两端使用各自的单调时钟和剩余预算；后续阶段不得重新放宽 App 已开始的期限，也不直接比较不同进程的 performance.now 数值。
- 任一准备失败须结束本次 App 执行位置；扩展连接断开或本次 native 期限到期后清掉未输入项、拒绝其迟到输入消息，不重连后补点。同一请求的点击阶段只接受一次。平台输入调用已开始则不能把释放队列伪装成取消；等调用结束再结束该执行段，响应丢失仍为结果未知，绝不自动重发。
- Agent 客户端自己停止等待不等于扩展已取消；当前外层 relay 没有这样的取消合同。native 分支自己的有限期限负责避免无人完成的准备长期占住执行位置，不借此宣称对已发送输入可以回滚。
- 旧 App 没有 native 分支时，在首次准备动作前返回能力不支持，并提示更新 App；能力检测是握手/协议事实，不通过“试点击看看”探测，也不构建旧版兼容执行路径。

## 7. 结果和失败不要误导调用方

未开始任何准备动作时，复用既有鉴权、权限、占据、stale 和 capability 错误。新增原生失败族建议为 `NATIVE_INPUT_FAILED`，在 Error Registry 标为阶段敏感，details 至少包括稳定 `reason`、`phase=prepare|input` 和 `clickState=not_sent|unknown`。

可区分的 reason 包括：目标不在前台、目标/窗口无法匹配、目标不能命中、几何发生变化、原生后端未就绪、用户输入冲突、排队/执行超时、平台只接受部分输入。实现时只登记实际 producer 用到的项。

`clickState=not_sent` 只指没有投递点击，不代表之前未发生激活或滚动；准备后的失败不能套用“整个命令无副作用”。平台输入已经调用但未取得完整成功证据，用 unknown。外层连接中断继续使用现有 delivery unknown，不把“已送到扩展”误写为“已发出系统点击”。不返回假的站点成功、伪造的 isTrusted 结果或自动重试建议。

## 8. 平台与自由点

平台接入顺序建议：Windows → Linux/X11 → Linux/Wayland。三个后端在同一个小型 Zig 模块边界后实现，不改变 Agent 指令。

- Windows：Win32 内容窗口路径已取得几何与可信点击样本；PostMessage 是可行候选，SendInput 是不同副作用的系统输入候选，二者不视为无条件等价。UIA 可参与结构/几何验证但不先定为必需。不自动提权；后台不抢前台的可靠性边界仍按[实测报告](../experience/native-input-2026-08-31.md)描述。[SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)。
- Linux/X11：X11 窗口事实、可用的内容区结构信息与 XTEST 输入；同样先验证内容视口能可靠定位，不能只证明 XTEST 能移动鼠标就宣称闭环完成。
- Linux/Wayland：按实际桌面支持使用 RemoteDesktop portal/EIS；系统授权由桌面决定，首次授权或恢复失败时返回说明，不无限重复弹窗。不新增插件逐次确认，也不把它混同 Chrome 调试提示。[RemoteDesktop portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)。尚未验证的环境明确 unavailable；Linux App 其余扩展功能仍可正常使用。

自由点继续只声明在 `registries/freedom.registry.json`，由既有生成器投影 TS/Zig：

| 新自由点建议 | 建议默认/归属 |
|---|---|
| `command.dom.click.real.default_activate` | 初稿建议已撤回；不登记，待选定切 tab/窗口聚焦的最小参数 |
| `command.dom.click.real.default_scroll_into_view` | true；扩展参数边界一次展开 |
| `command.dom.click.real.default_timeout_ms` | 10000；扩展展开完整期限预算 |
| `command.dom.click.real.maximum_timeout_ms` | 60000；入口和 App 有界检查 |
| `native_input.maximum_pending_requests` | 与原生排队容器一同落地后登记有依据的数量上限 |

候选命中点、frame 层数和原生结构遍历必须有界；算法实现时沿用语义相同的已有预算，否则新增有明确 consumer 的点，再以测试确定默认值。本轮不先造数字、轮询间隔、重试退避或运行时设置系统。不得把调试样例的像素偏移写成自由点掩盖错误坐标模型。

## 9. 就近文件结构，不另起架构

以下是实施位置，不表示文件已存在：

```text
apps/extension/src/background/
  command-dispatcher.ts          现有入口：注册精确方法、权限与准备动作范围
  dom-service.ts                 复用 DOM/树 NodeRef 解析和精确文档执行
  tab-service.ts                 就近补当前目标窗口聚焦/状态读取
  real-input-service.ts          新：单次点击编排、页面几何与最终命中检查
  transport-controller.ts        现有入口：主动子请求、原连接上下文、子回复分流
apps/extension/src/shared/
  native-input-protocol.ts       新：窄的双向消息类型；不导入 Key/业务状态
apps/extension/src/
  offscreen.ts / transport-worker.ts  现有连接中承载 native 往返
apps/relay/src/
  server.zig                    只接线，不把平台代码塞进消息大分支
  native_input.zig               新：本次请求、短串行执行与平台公共输入类型
  native_input/windows.zig       新：Windows 几何与输入
  native_input/x11.zig           随 X11 接入创建
  native_input/wayland.zig       随 Wayland 接入创建
registries/                     新方法、独立权限、原生能力/错误/自由点
protocol/transport-profile.json 内部 native 分支与能力说明的同源声明
tools/generate-*.mjs / build.zig 只按现有生成/构建路线扩展
tests/                          纯几何测试、双向协议测试、隔离原生点击体验
skills/browser-key-automation/  实现后才更新可调用指令和操作边界
```

当前 DOM 解析入口也接受页面树签发的 NodeRef，新模块必须复用它，不能只支持 `dom.query` 的引用。原生句柄、portal 会话等是平台资源，不是新的 Agent/Key/实例身份。

## 10. 最短落地与验收顺序

1. 用隔离 Chromium、本地简单按钮页面验证 Windows 的内容区测量与坐标换算。分别记录普通 DOM click 与系统 click 的 pointer/mouse/click、实际 target、isTrusted、按钮状态；包括拒绝合成事件的按钮。不要先搭庞大原生输入框架。
2. 通过后接入现有 Key dispatcher、双向 native 路由和单次执行，完成同一个 NodeRef 的一条 `dom.click.real`。验证首次权限缺口、旧 App、不抢占其他 Key 占据、不暗中调用 CDP。
3. 覆盖滚动、部分遮挡、disabled/无布局、hover 导致变化、iframe/跨域权限、浏览器缩放、不同 DPI/多屏、侧栏/停靠面板、同标题多窗口、多实例交错、超时断线不补点。对不支持的组合如实记录，不以猜测成功通过。
4. 对新自由点做修改投影测试；分别完成 X11、Wayland 的真实环境验收，再标注对应支持范围。交叉编译成功不等于 Linux 真实点击验收。
5. 保留脱敏原始输入/页面事件 JSON、目标窗口截图和逐步交互说明，形成 `docs/experience/real-input-<日期>.md`；扩展/App 继续独立分包。

初稿轮只建立方案；后续实测轮增加了隔离实验工具与原始记录，已实际执行测试窗口消息和系统点击，但仍未修改产品源码、registry、配套 skill 或运行中的个人浏览器/App。新增通用命令、长期校准缓存、桌面宏、自动反复点击、CDP 回退和平台提权均不属于本方案。
