# 原生点击实测：消息、焦点、前台与位置

2026-08-31。已完成 Windows / Chrome **151.0.7922.175** 的隔离实测。本文件记录产品实现前的实验阶段；该阶段只增加实验工具、数据和文档。Windows 产品 `.real` 随后已实现、注册并打包，现状见[实现切片](../implementation/real-input-slice.md)和[最终交互记录](real-input-implementation-2026-08-31.md)。

## 1. 结论先说

1. **可以直接投递窗口消息并得到可信点击；不能把“必须先前台化”作为总前提。** `PostMessageW` 的移动、按下、抬起进入 Chrome 原生输入路径后，测试按钮收到 `isTrusted=true` 的 click，业务计数增加。不是通过修改 `isTrusted`、JS `.click()` 或 CDP Input 达成。
2. **确实取得了实际后台成功样本，但不等于可以保证任何情况下都不抢前台。** 两次 PostMessage 点击均成功，输入前后采样的系统前台都属于其他程序。第二次约 1.5 秒观察期内，前后台快照相同、无前台切换事件、鼠标及窗口几何不变。第一例有前台事件信号，不能据前后相同就声称全程无切换。详见第 5 节。
3. **同一 Chrome 的两个窗口之间，后台消息点击会自行激活目标。** 分拆测试中，move 不切换，down 阶段目标成为前台，up 产生 click；给测试窗口设置 `WS_EX_NOACTIVATE` 仍未阻止这条路径激活。不是调用方预先激活才有 click。
4. **激活不必移动或缩放窗口。** 首轮 31 个用例的输入前后目标窗口矩形全部不变。逐条消息组的鼠标也始终未动，但窗口 Z 序、前台和线程内焦点变化了。

上述都是本机观测，不是对所有 Chromium 版本、站点和桌面的保证。尤其不能把“后台可行”写成“不打扰前台”的无条件承诺。

## 2. 数据入口与实验环境

优先看以下四份，具体用例在 `cases` 或 `setups` 数组，页面原始事件另有 `page-events.json`：

| 数据 | 内容 | 原始记录 |
|---|---|---|
| A / `gB3r8u` | 首轮 31 个输入用例；无准备异常 | [results.json](../../out/test-artifacts/native-input-chrome-gB3r8u/results.json)、[页面事件](../../out/test-artifacts/native-input-chrome-gB3r8u/page-events.json) |
| B / `kFnoiC` | 4 组 move/down/up；含 NOACTIVATE 对照 | [results.json](../../out/test-artifacts/native-input-chrome-kFnoiC/results.json)、[页面事件](../../out/test-artifacts/native-input-chrome-kFnoiC/page-events.json) |
| C / `txMgWE` | 单独选中 tab、单独请求窗口聚焦 | [results.json](../../out/test-artifacts/native-input-chrome-txMgWE/results.json) |
| D / `tJI4E1` | 另一进程实际处于前台时的 2 次定向点击 | [results.json](../../out/test-artifacts/native-input-chrome-tJI4E1/results.json)、[页面事件](../../out/test-artifacts/native-input-chrome-tJI4E1/page-events.json) |

Windows 桌面观测尺寸 2560×1600，目标窗口 DPI=144，页面 devicePixelRatio=1.5。浏览器使用新建空 profile；target、cover、spare 均为随机本地端口提供的固定测试页面。A/B 首轮没有安装产品扩展，C/D 加载的只是极小的 API 实验扩展。

输入工具复用既有 Windows App Debugger 的 `WindowsMessageInput`：已检查该 click 路径，只发 mouse move/down/up，不调用 SetForegroundWindow、SetFocus、SetCursorPos 或 SendInput。分阶段组直接调用单条 PostMessage；SendMessageTimeout 与 SendInput 用小型 C# 实验探针补齐。没有把这些实验 C# 文件加入 Zig 产品。

CDP 只用于准备、读取本地夹具及目标页截图；**未调用任何 CDP Input 方法**。每次原生输入前关闭页面 CDP session；输入后先采原生状态，再重连读取页面。浏览器级 CDP 连接保留，API 实验组的测试扩展 worker 也有调试连接；这不是完全无调试通道的验收。C/D 的 `--enable-unsafe-extension-debugging` 仅对新建测试进程生效，用于安装测试扩展，不是产品运行要求或个人浏览器设置。

每次记录 HWND/PID/父子关系、窗口和客户区矩形、DPI、原生前台、GUI 线程 active/focus/capture、Z 序、鼠标位置、API 返回、DOM 事件及业务计数。页面还主动把事件 POST 到本地服务保存；这是同一页面处理器的第二条记录渠道，不是独立硬件传感器。

## 3. 每一步实际看到了什么

### 3.1 建立最小页面

窗口 A 显示蓝色 target 页，窗口 B 显示绿色 cover 页；A 内另有 spare 标签页。按钮只有两个计数：可信点击、脚本合成点击，不访问外部网络或账户。按钮被 DOM 遮挡、被 disabled 时各有独立对照。

以下是已经实际查看的目标页截图：按钮下显示“可信：1；脚本合成：0”。截图前单独执行了一次标记为 `screenshot-success` 的点击，不计入四组分阶段统计。

![实际可信点击后的测试页面](D:/Code/浏览器自动化插件/out/test-artifacts/native-input-chrome-kFnoiC/target-viewport.png)

### 3.2 先做 DOM 对照

前台和后台各调用一次 `button.click()`：都产生 click，但 `isTrusted=false`，脚本合成计数增加，可信业务计数不增加。后台调用没有把窗口带到前台。

### 3.3 改发窗口消息

首轮矩阵如下。“成功”特指 **target 页 button 的可信计数增加**，不是 API 返回成功，也不是任意页面收到任意 click。

| A 的状态 | PostMessage → 内容子 HWND | PostMessage → 顶层 HWND | 关键观察 |
|---|---|---|---|
| 前台，target 已选中 | 3/3 成功 | 1/1 成功 | 鼠标不动，窗口矩形不变 |
| 后台但可见，target 已选中 | 3/3 成功 | 1/1 成功 | 每次 A 都由后台转前台 |
| 被 B 完全覆盖 | 0/3，无 click | 1/1 成功 | 顶层路径使 A 前台化；子窗口路径无事件 |
| target 未选中，A 显示 spare | 0/3，无 click | target 0/1；**spare 被可信点击** | 顶层 HWND 不是任意 tab 的地址 |
| A 最小化 | 0/3，无 click | 首轮坐标有缺陷，不用它证明不可行 | 修正坐标后的补测仍无 click，见第 8 节 |

被覆盖、最小化或 tab 未选中时，原先 target 的内容 HWND 仍存在，但在这些样本里已重挂到隐藏父窗口，`visible=false`。此时消息包装器返回成功，却没有到达目标 DOM。不能把这种状态与“后台但仍可见”混为一谈。

同一组条件下，SendMessageTimeout 内容子窗口路径：前台、后台可见各 1 次成功；完全覆盖、最小化各 1 次没有 click。这里没看到它比 PostMessage 多解决一个条件。

### 3.4 拆开 move / down / up

数据 B 有 4 组：后台子 HWND、被覆盖的顶层 HWND，以及二者各自加 NOACTIVATE 的版本。

| 观察点 | 系统前台 | A 页面焦点 | A 可信计数 | A 窗口矩形 | 系统鼠标 |
|---|---|---|---|---|---|
| 投递前 | B | false | 0 | (30,50,900,760) | (700,1424) |
| move 后 | B | false | 0 | 不变 | 不变 |
| down 后 | A | true | 0 | 不变 | 不变 |
| up 后 | A | true | 1 | 不变 | 不变 |

4/4 组模式相同。A/B 的 Z 序由 B→A 改为 A→B；down 时有 mouse capture，up 后释放。不是“鼠标一定要移动过去才有原生 click”。

NOACTIVATE 两组的扩展样式从 `0x00200100` 改为 `0x08200100`，各阶段均读到该标志，结束恢复原值。**确实设置并还原了它；但它没有阻止这条消息处理路径激活。** 不据此声称该标志对其他用途无效。[微软样式定义](https://learn.microsoft.com/en-us/windows/win32/winmsg/extended-window-styles)

### 3.5 区分两种遮挡

- DOM overlay 盖住按钮：PostMessage 得到的是 overlay 的可信 click，按钮计数为 0。
- 按钮 disabled：有 pointerdown/up，但没有 button click，业务计数为 0。
- 另一个桌面窗口 B 盖住 A：SendInput 在屏幕该点点中了 **B 的按钮**，不是 A。探针预先确认该点属于隔离 B，才允许这次负对照。

因此，“向目标窗口投消息”和“向系统屏幕坐标发鼠标输入”不是同一条路线；页面内部命中和桌面窗口命中也不是同一层。

## 4. 扩展 active / focused 的实际区别

数据 C 先在 A 选中 spare，并请求 B 聚焦，然后单独执行两条扩展 API。此时系统实际前台属于另一个进程，实验没有读取它的标题或操作它。

| 调用 | 扩展/页面结果 | Win32 线程内状态 | 系统前台（两端快照） | 位置和大小 |
|---|---|---|---|---|
| `chrome.tabs.update(target, {active:true})` | target 成为 active tab；hasFocus=false | 仍为 B | 外部 HWND `0x1300D40`，不变 | 不变 |
| `chrome.windows.update(A, {focused:true})` | 返回 focused=true；hasFocus=true | active/focus 改为 A | **仍为外部 HWND，不变** | 不变 |

第二条还使本进程中 A/B 的 Z 序互换，并记录到 A 的 foreground 事件，因此不能声称该 API 调用全程没有短暂前台变化。证据支持“浏览器内部认为聚焦”和“系统前台采样”可以在本场景不一致；**不能只看扩展返回值或 document.hasFocus 来判定系统输入会送给谁**。不把该样本泛化成 Chrome API 每次都会虚报。Z 序列表只包含本实验 Chrome 的窗口，不能据此推断它与所有外部窗口的排序。

`tabs.update` 的 active 本来就不要求聚焦窗口；`windows.update` 的 focused 是单独的请求。聚焦请求与原生实际结果需要分别记录。[Chrome tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-update)、[Chrome windows](https://developer.chrome.com/docs/extensions/reference/api/windows#method-update)

## 5. 另一程序仍在前台，能否点击成功？

数据 D 利用现场自然存在的外部前台条件补测，**没有为制造条件去激活个人程序**。两次均向 A 的内容 HWND 投递消息，不调用 SendInput。

| 指标 | 第一次：窗口聚焦 API 前 | 第二次：窗口聚焦 API 后 |
|---|---|---|
| 输入前→后的系统前台 | 外部 `0x1300D40 / PID 46540` → 同一外部窗口 | 同左 |
| 页面 hasFocus | false → true | true → true |
| Chrome GUI active/focus | B → A | A → A |
| button click | isTrusted=true；计数 +1 | isTrusted=true；计数 +1 |
| 系统鼠标 | (1266,1085) → 原位 | 原位 |
| 窗口几何 | 不变 | 不变 |
| 前台事件日志 | **有 1 条目标 A 的 foreground 信号** | **无 foreground 信号** |
| dispatch→事后原生快照 | 1598 ms | 1509 ms |

第一次不能排除短暂切换，也不能只凭该通知解释所有系统状态。第二次在该观察窗口内，前后台快照、事件日志、鼠标及几何一致支持“可信点击成功且没有观测到系统前台切换”。

第二次之前，第一次点击已经建立了 A 的线程内/DOM 焦点；中间的 windows.update 没有进一步可观察的改变。**不能把第二次结果归因于“windows.update 消除了抢前台”或说它是必要步骤。** 两端快照加事件监听也不是无遗漏的连续测量，更没有查询 click 精确时刻的系统前台。

这把结论从“只能先前台化才能点”修正为：**窗口消息后台点击有实际成功证据；是否引发激活还依赖当时的浏览器线程状态和系统前台条件。** 本实验没有建立一种可以强制所有情况下都保持后台的机制，不能把偶然拒绝前台请求当作产品控制手段。

最精简的真实样本，可直接在 D 的 `setups[id=external-foreground-post-after-window-focus]` 找到：

```json
{
  "before.foreground": { "hwnd": "0x1300D40", "pid": 46540 },
  "after.foreground":  { "hwnd": "0x1300D40", "pid": 46540 },
  "observed.trustedDelta": 1,
  "observed.foregroundEvents": [],
  "observed.geometryChanged": false,
  "observed.cursorChanged": false
}
```

## 6. 以后统一使用的概念

| 概念 | 指什么 | 不等于什么 |
|---|---|---|
| 业务目标 / NodeRef | 本次命令要操作哪个 document/节点 | 不代表已切换浏览器标签页 |
| active tab | 某个浏览器窗口正在显示的标签页 | 不代表该窗口是系统前台 |
| 系统前台 | 实际 `GetForegroundWindow()` 结果 | 不由 `tabs.active`、DOM focus 或 API 请求成功代替 |
| GUI 线程 active / focus | 该线程记录的活动顶层窗口/焦点窗口 | 非前台线程也有记录；不代表它正接收人的键盘输入 |
| DOM hasFocus / activeElement | 页面内部焦点状态/节点 | 不证明系统前台归属 |
| 几何位置 | x/y/width/height | 不含 Z 序、前台归属或 tab 选中 |
| Z 序 | 谁叠在谁上面 | 与坐标变化不同，也不等同系统前台 |
| 可见 / 覆盖 / 最小化 / 未选中 | 四种不同状态 | `IsWindowVisible=true` 不证明像素没被另一窗口盖住 |
| isTrusted | 这条 DOM 事件的可信标志 | 不证明来自物理鼠标、真人，更不保证站点业务接受 |

GUI 线程信息按线程读取；探针里多个 HWND 下重复出现相同 GUI 对象，不代表每个子 HWND 同时拿到键盘焦点。[GetGUIThreadInfo](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getguithreadinfo)

输入通道也拆开：

| 通道 | 地址和语义 | 本次证据 |
|---|---|---|
| JS `.click()` | 指定 DOM 节点 | untrusted click，不等同原生输入 |
| PostMessage / SendMessageTimeout | 向指定 HWND 送鼠标消息，坐标属于该客户区 | 可进入 Chrome 输入路径、产生 trusted click；接收方可能自行激活 |
| SendInput | 向系统输入流注入，没有目标 HWND 参数 | 屏幕命中谁就可能点谁；本实验含鼠标绝对移动 |

PostMessage 返回成功只说明投递被接受；SendMessageTimeout 返回也不代表页面业务结束。`isTrusted` 不是“真人证明”。本例可绕过只拒绝 JS 合成 click 的测试逻辑，不承诺绕过所有网页校验。[PostMessage](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-postmessagew)、[SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)、[DOM 标准](https://dom.spec.whatwg.org/#dom-event-istrusted)

## 7. 对方案的最小修正建议

1. **保留用户确定的“扩展定位 + App 原生执行 + `.real` 后缀”。** Windows 的候选后端应包含已测通的定向窗口消息，不再把 SendInput / 强制前台写成定义的一部分；两种后端的副作用不能混称。
2. **不要用一个 activate 布尔值捆绑“切 tab”和“抢系统前台”。** 选中目标 tab 是窗口消息正确路由的准备；是否主动请求窗口聚焦是另一项。即便不主动请求，也必须说明接收方可能自行激活。这里修正参数建议，不注册新接口或新增权限。
3. **几何无需先假定必须走 UIA。** 这套 Chrome 夹具直接从实际内容 HWND 的客户区拿到了视口原点/尺寸。产品落地时先验证这条小路径；UIA 只是候选，不搭多层自动回退。实验里的标题匹配、宽高过滤只适用于隔离夹具，不能直接当成真实多实例身份算法。
4. **分别设计副作用边界。** SendInput 使用系统鼠标；窗口消息不需要移动鼠标，但仍可能改变 tab、焦点、capture 和 Z 序。是否需要按窗口/线程协调，要按实际共享状态决定，不能从“鼠标不动”跳到“可以无条件并行”，也不借此新增全桌面占据体系。

坐标也有一个已证实的简化：CSS 点通过“原生视口尺寸 / CSS 视口尺寸”映射到原生客户区即可。本次 D 的 CSS 点 (250,240) → 原生内容客户区 (375,360) → 屏幕物理点 (401,505)。DOM 事件 screenX/Y 记录约 (267,336)，是另一量纲，不能当成物理屏幕坐标再直接输入。不写死地址栏高度，不重复乘 DPI。

这些是数据支持的工程建议，不是已实现功能。产品仍为 41 条 active command、37 个 active permission、47 个自由点；没有为实验常量新增产品 Freedom Point。

## 8. 失败、纠正与未覆盖范围

- **首轮最小化顶层坐标有缺陷。** 原正常屏幕点减去了最小化后的原点，得到 (32405,32540)，不能用该负结果证明最小化顶层输入不可行。`2oStEg/cases[id=minimized-post-top-1]` 改用最后正常客户区点 (375,490)，返回已投递但没有 click，也没有还原窗口；仍只证明这次路径/坐标无效，不穷举所有最小化策略。
- **首轮有鼠标观测噪声。** 22 个 Post case 中 20 个指针前后不变，另 2 个出现未归因的运动；没有全局输入来源日志，不能归因给 PostMessage。普通前/后台成功组的重复均未动鼠标，数据 B、D 也无此噪声。
- `3OL5i7`：4 组准备失败，原生前台不是测试窗口，找不到可见内容 HWND；没有投递点击。随后把固定等待改成有界的实际状态检查，并保存激活 API 返回。
- `UR12Hf`：备用 Chromium 149 在 10 秒内未生成调试端口文件，没有进入测试；不据此评价其点击能力，不反复延长启动等待。
- `cNoUmk`：4 组逐条消息已完成，后续 API 对照未取得目标 tab，整轮异常结束；那时 worker 选择不够精确，未保存足够上下文作唯一根因判断。后续绑定安装返回的精确扩展 ID。
- `2oStEg`：31 个 case 中 25 个完成输入观察，6 个准备失败；4 个 staged 也准备失败。已直接捕获 `SetForegroundWindow.ok=false` 和外部实际前台，失败组不发输入。长轮结束时测试 worker 已不在目标列表；后续改为安装后立即附着精确 worker，并单独运行短 API 对照。失败不是产品 bug，也不是“后台点击失败率”。
- A 的 31 个 case 中，2 个 DOM + 29 个 native。29 个 native 的 API/包装器均表示接受，只有 13 次 target-button 可信计数成功；另有 spare、cover、overlay 各 1 次可信 click。API 接受数、任意可信 click 数和目标业务成功数不能混用。
- A 的 HTTP 日志共 423 条、18 个 click，与每个用例页面快照逐条核对一致。准备阶段事件与输入阶段已按标签区分，不能把所有 blur/visibilitychange 都归因给点击。观察时间包含包装器启动耗时，不拿这组数据冒充性能基准。
- 正式矩阵的 A/B 属于同一浏览器进程；D 只补充了现场其他进程在前台的样本，未固定/枚举外部应用类型。尚无完全无 CDP 环境、Linux/X11/Wayland、不同 DPI/多屏、iframe、各种复杂站点和版本覆盖。

前台请求受 Windows 规则限制，必须检查实际状态；本实验不修改这些系统规则，不用强制抢焦点技巧。[SetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)

## 9. 全部原始运行索引

没有删除失败样本。目录均在 `out/test-artifacts/`，每个都有 results.json、page-events.json、browser-stderr.log；有截图的运行另外保留 PNG。results 中含当时源码 SHA-256，不能把新 runner 当作每轮完全相同的源码版本。

| 目录 | 状态 | results.json SHA-256 |
|---|---|---|
| [native-input-chrome-gB3r8u](../../out/test-artifacts/native-input-chrome-gB3r8u/results.json) | 完整首轮 | `ac71eeeb42148dbbc1c777f97a38cba1d2b405029b5b4b51896c203f63a120af` |
| [native-input-chrome-3OL5i7](../../out/test-artifacts/native-input-chrome-3OL5i7/results.json) | 前置条件失败 | `c41298d6634c785a6d768b894f5b4816e75818f4c8f32c6ef0180b48dd7ac526` |
| [native-input-chrome-kFnoiC](../../out/test-artifacts/native-input-chrome-kFnoiC/results.json) | 完整分阶段对照 | `700195fc4f4a4ebea778e9028ffcb947819af92a895d3023260c00afbf03c7a1` |
| [native-input-chromium-UR12Hf](../../out/test-artifacts/native-input-chromium-UR12Hf/results.json) | 未进入测试 | `69353605656e78cdcaa7b208e6b494e6367a6c59ccf2e0519c8fee7691d1965b` |
| [native-input-chrome-cNoUmk](../../out/test-artifacts/native-input-chrome-cNoUmk/results.json) | 分阶段完成；后续异常 | `ec019425bb3eb11c9c3e09ba8654a3bd972282b647d6264bceeec2326542d1c3` |
| [native-input-chrome-2oStEg](../../out/test-artifacts/native-input-chrome-2oStEg/results.json) | 部分输入完成；保留失败 | `ee0f9402c95170bbb9027b9e8c7830223ce910e8331e14a6837081a501f2700f` |
| [native-input-chrome-txMgWE](../../out/test-artifacts/native-input-chrome-txMgWE/results.json) | 完整扩展 API 对照 | `951a4511b580087775be760275ff612c2b41159dbb3d2e4982dc873618e47fd4` |
| [native-input-chrome-tJI4E1](../../out/test-artifacts/native-input-chrome-tJI4E1/results.json) | 完整跨进程前台补测 | `96c5fb146823ed4399169e60d462182a6c2772092b87aa82be932b5989066599` |

## 10. 复现与本轮改动边界

测试入口：[run.mjs](../../tests/experiments/native-input/run.mjs)。必须显式 `--execute`；普通矩阵会操作新建测试窗口焦点，并在受检查的测试坐标发送 SendInput。后台补测若没有自然存在的外部前台条件，会明确跳过，不操控个人窗口制造条件。

```powershell
# 首轮矩阵与逐条消息；会实际操作隔离测试窗口。
& ./tools/run-noninteractive.ps1 -Executable 'C:/Program Files/nodejs/node.exe' 'tests/experiments/native-input/run.mjs' '--execute'

# 仅逐条消息/NOACTIVATE 对照。
& ./tools/run-noninteractive.ps1 -Executable 'C:/Program Files/nodejs/node.exe' 'tests/experiments/native-input/run.mjs' '--execute' '--stages-only'

# 两个扩展 API 与自然存在外部前台时的定向消息补测。
& ./tools/run-noninteractive.ps1 -Executable 'C:/Program Files/nodejs/node.exe' 'tests/experiments/native-input/run.mjs' '--execute' '--chrome-fixture' '--api-only' '--external-post'
```

依照 coding-guidance 的资产复用和边界要求，复用既有窗口消息实现与项目 CDP 客户端；实验代码留在 tests，不侵入产品。依照 execution-strategy，备用浏览器启动超时后转用已验证的 Chrome 路径；没有下载新工具或反复盲重试。报告经独立只读数据复核，指针噪声、错误坐标及前台信号差异均保留。

收尾检查：本次隔离 Chrome 主进程均已关闭；个人 relay 仍为原 PID **46104**，原启动时间未变，仍监听 `127.0.0.1:32189`。没有使用个人 Key、操作账户网页、重启个人 App 或改动个人扩展。没有新增产品指令、权限、自由点、平台后端或开发包。
