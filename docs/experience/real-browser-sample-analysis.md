# 真实浏览器样本分析

更新：2026-08-30。本文只记录 Agent 通过 Browser Key Automation 扩展权限和 Key-only 协议对用户真实 Chromium 会话所做的观察。未使用 CDP/DevTools，未使用调试 profile。

## 采集边界

- Chrome **Allow User Scripts / 允许用户脚本** 开启并重载后，relay 为新 extension socket 分配了实例 `2`；旧实例消失。
- `js.execute` 在 `USER_SCRIPT` 和 `MAIN` 中的无副作用探针都返回 `fulfilled`，值未截断。
- 完整样本先在 USER_SCRIPT world 将 `document.documentElement.outerHTML` 和 `document.body.innerText` 冻结为字符串，再用 12,000 个 JavaScript code unit 为一块转移；字符数、UTF-8 字节数与 SHA-256 全部复核。
- 这些是采集时刻的 live DOM，不是最初 HTTP response、MHTML 或全部网络资源。
- 含个人内容的文件只在 `F:\code\浏览器自动化插件\browser-samples`；本文不记录邮箱地址、邮件摘要、ChatGPT 会话标题、视频标题或其他个人正文。

## 样本矩阵

| 页面类型 | 目录 | 元素数 | live DOM bytes | visible text bytes | DOM/text | `<body>` 起点 code units | 标准 preview |
|---|---|---:|---:|---:|---:|---:|---|
| B 站首页 | `2026-08-30T15-13-49-057Z-bilibili-home-full` | 2,873 | 1,446,217 | 4,138 | 349.5:1 | 573,747 | 截断 |
| ChatGPT 首页 | `2026-08-30T15-14-13-739Z-chatgpt-home-full` | 1,400 | 769,236 | 976 | 788.2:1 | 121,617 | 截断 |
| Gmail 收件箱 | `2026-08-30T15-16-34-688Z-gmail-inbox-full` | 2,837 | 4,942,765 | 366 | 13,504.8:1 | 4,481,509 | 截断 |
| MDN DOM 文章 | `2026-08-30T15-17-54-785Z-mdn-dom-introduction-full` | 1,169 | 157,082 | 15,809 | 9.9:1 | 65,499 | 截断 |
| B 站视频页 | `2026-08-30T15-19-49-494Z-bilibili-video-full` | 2,380 | 1,509,853 | 2,576 | 586.1:1 | 985,669 | 截断 |

5 份标准 `page.dom.get` preview 全部 `htmlTruncated:true`，且 5/5 都在 `<body>` 前已经用完预算。因此当前 `page.dom.read` 单独授权时，这些真实页面的消费端拿不到主体；用 `js.execute` 分块抓取只是本次采样手段，不能代替独立 DOM 权限的产品能力。

## 实际看到的结构

### B 站首页

- 可见文本中有首页、番剧、直播、游戏中心、会员购、漫画和赛事等通用导航；266 个非空行中 248 行不超过 20 个字符，列表卡片和短标签明显。
- 33 个 style 含 559,782 code units，31 个 script 含 68,317 code units；还有 237 个 SVG、573 个 path、1,160 个 `data-*` 属性和 325 个 inline style。
- 241 个链接、83 张图片、28 个 heading 表明它是高密度推荐页，但大部分 DOM 体积不是推荐文本本身。

### ChatGPT 首页

- 可见通用界面文本包含 ChatGPT 和“新聊天”；未将会话标题或正文复制到报告。
- 14 个 script 已含 496,709 code units，是主要体积来源；页面有 76 个 button、4 个 input、1 个 textarea、309 个 ARIA 属性和 120 个 hidden/`aria-hidden=true` 节点。
- 可见文本只有 47 个非空行，44 行不超过 20 字符；交互状态和可访问性属性比纯文本更重要。

### Gmail 收件箱

- 保持用户已登录状态，可见通用界面文本包含 Inbox、Compose、Sent 和 Drafts；未打开、发送、删除、归档、标记或修改任何邮件。
- 12 个 style 含 4,402,100 code units，已占 live DOM 的绝大部分；另有 430 个 ARIA、918 个 `data-*`、96 张图片和 334 个 inline style。
- `innerText` 只有 366 bytes，而 DOM 接近 5 MB。这份后台标签页样本证明，虚拟列表、页面可见性和惰性渲染会让 `innerText` 严重少于用户认知中的应用信息。

### MDN DOM 文章

- 可见通用文本包含 Document Object Model、In this article、See also 和 MDN；它是本批的连续语义内容正样本。
- 157,082 bytes DOM 产生 15,809 bytes 可见文本，比例 9.9:1；32 个 heading、4 个 nav、2 个 aside、1 个 main 和 1 个 footer 给出了明显语义骨架。
- 虽然也有 60,004 code units 的 style 和 289 个链接，正文与结构信号仍远强于三个 Web App。

### B 站视频页

- 从首页的首个站内 `/video/` 链接导航，页面加载后检测到 1 个 `<video>`，立即确认 muted 与 paused；未点赞、投币、收藏、关注或评论。
- 可见通用文本包含关注和弹幕；点赞、投币、收藏和分享存在于 DOM，但本次后台可见文本中没有它们。
- 58 个 style 含 927,372 code units，还有 164 个 SVG、436 个 path、30 个 input 和 1 个 canvas；播放器 UI 带来大量图形与状态噪声。

## 真实交互结果

1. `window.open(..., "_blank")` 和脚本创建 `<a target="_blank">` 的两次尝试都在 JS 层正常返回，但 `tabs.list` 确认 tab 数始终是 7；Chromium 弹窗策略阻止了新 tab，没有产生未知重复或脏状态。
2. 当前没有 `tabs.create/navigate`，因此使用已完整采样的 B 站首页 tab 作为临时载体，依次 `location.replace` 到 Gmail、MDN、B 站视频页并回到首页。每次导航后都重新 `tabs.list` 取新 TabRef，不复用旧 generation。
3. 最终 B 站首页恢复为 `complete`，tab 总数仍为 7，没有遗留 Gmail、MDN 或视频 tab。

## 已证实、但未裁定的接口缺口

| 缺口 | 证据 | 需要裁定的问题 |
|---|---|---|
| DOM preview 无法取得真实页面主体 | 5/5 页面的 `<body>` 都在 preview 截断点之后；JS 权限又与 DOM 权限并列不互含 | 当前由 Artifact 保留完整文件、页面信息树提供逐层可达内容；这是传输/选择问题，不再交给清洗删除信息 |
| 页面 JS 无法可靠创建新 tab | 两种新 tab 方式均被 Chromium 弹窗策略拦截 | 是否增加显式 `tabs.create`、`tabs.navigate`，两者都加，或暂不做；同时裁定它们的独立 permission atom |
| JS capability 失败不可诊断 | 开关未开时 `system.describe` 仍列 active catalog capability，`js.execute` 只返回无详情 `CAPABILITY_UNAVAILABLE` | 是否在 error details 返回稳定 capability reason，或增加 runtime readiness 接口；不应把具体 Chrome 文案变成不稳定协议 |

## 页面树编排与折叠摘要仍可使用的证据

这些样本不再用于调整已裁定移除的 selection，而用于验证唯一 operation tree 的编排、折叠行摘要和一次性 view 是否可读；任何展示优化都不能改变 rootRef 下完整信息的可达性：

- 输入字节顺序不等于信息优先级；5 份样本的 head 都可先吃完普通 inline 预算。
- script/style/preload、SVG/path、`data-*`、inline style 可以占据绝大多数 DOM，但并非全部可盲目删除；页面状态、可访问性和交互语义有时只存在属性中。
- `innerText` 对 MDN 连续内容非常有效，对 Gmail 这类后台虚拟应用却只有 366 bytes；不能用一个信号统治所有页面。
- 互动控件、语义骨架、可见文本、虚拟渲染状态和媒体状态需要能被分开表达；具体优先级等用户指导。

## 完整性与私密复核

- 5 份 full 样本的 live DOM 与 visible text 均通过元数据字节数和 SHA-256 复算；标准 preview 也各有独立 SHA-256。
- 仓库文档、采集工具与整个私密样本根上的完整 `bk1.<KeyId>.<secret>` 形状扫描命中数为 0。
- 详细文件名、字节数、分块数和哈希见 `F:\code\浏览器自动化插件\browser-samples\corpus-index.json`。
