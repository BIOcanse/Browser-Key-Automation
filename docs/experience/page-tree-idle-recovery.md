# 页面操作树：空置失效复现与修复

日期：2026-08-30（本机日期；原始目录名使用 UTC，所以日期前缀为 2026-08-31）。

结论：真实个人浏览器中复现了“页面没刷新，但闲置后旧树引用失效”。页面树和展开状态并没有丢失，丢的是扩展后台内存中的路由。现已改为扩展 session 路由，通过独立 Chromium 的强制后台回收回归，并已用用户新提供的 Key 完成真实个人浏览器更新后复测：空置 45 秒，原 root view 和原 HTML expand 均成功，展开状态保留。下文保留修复前失败和修复后成功两组证据。

## 1. 真实交互中看到了什么

使用用户指定的桌面 `问题.txt` 读取 Key，仅放入子进程临时环境；不打印、不写进请求转录。本地 App 未运行时按既定流程启动，并保持运行。连接仅有一个实例，因此固定该实例完成整组操作，没有向多个浏览器试 Key。

本轮开始，浏览器列表只有一个新标签页，之前的 B 站页已经不在。我通过扩展 `tabs.create` 新开了一个后台 B 站首页，没有切换用户前台、点击视频、投稿或发送任何内容。

| 步骤 | 实际操作 | 实际看到的结果 |
|---|---|---|
| 1 | `page.tree.open` | `reused=false`，创建这个 Document 的 root |
| 2 | `view.get(maximumLevel=0)` | 2 行：`[0] doctype html`、`[1] HTML`；均未展开 |
| 3 | 显式 expand HTML，再 get 第 1 层 | 11 行；HTML 有 3 个 attributes、6 个 DOM children；HEAD 在 `[1,4]`，BODY 在 `[1,6]` |
| 4 | 显式 expand BODY，再 get 第 2 层 | 38 行，未截断；BODY 有 2 个 attributes、25 个 DOM children；HEAD 仍折叠，没有为了凑层级而展开 |
| 5 | 45 秒不发浏览器请求 | 没有刷新/导航页面，没有 debugger 或心跳保活 |
| 6 | 直接用原 root get | `TARGET_REF_STALE`，且 `delivery=extension_response`：请求已到扩展，不是网络没反应 |
| 7 | 直接用原 HTML TreeRef expand | 同样 `TARGET_REF_STALE` |
| 8 | 用原 TabRef reopen | `TAB_REF_STALE` |
| 9 | 重新列出标签页，再用新 TabRef reopen | `reused=true`、root 与先前相同；HTML/BODY 的展开路径仍是 `[1]`、`[1,6]` |

第 0 层实际摘要：

```text
[0] doctype html  expanded=false
[1] HTML          expanded=false  attributes=3  children=6
```

展开 HTML 后的关键行摘录（完整 11 行在原始文件中）：

```text
[1]     HTML  expanded=true
[1,4]   HEAD  expanded=false  attributes=0  children=75
[1,6]   BODY  expanded=false  attributes=2  children=25
```

这仍然说明不能硬编码“HTML 下第一个元素就是 BODY”。原始树先列 attributes，也保留注释、文本和其他扩展注入的内容。本轮没有更改编树/选择规则。

空置测试做了两次，实际空置分别为 45,012 ms 和 45,007 ms。第二次完整记录了第 9 步；新的 DocumentRef 字符串与旧值不同，但 root 相同且 `reused=true`，说明是后台重新签发运行期别名，不是页面树被重建。仅等待 45 秒不能单独证明 Chrome 确实回收了 worker，因此另做了下面的强制回收测试。

## 2. 修复内容与边界

自然语言逻辑只有两部分：页面保存唯一的树和各 Key 展开集合；扩展 session 保存 TreeRef 到精确 Document 的路由。后台睡眠结束后仍能找到路由，直接继续 view/expand；真实文档替换后仍失效。

- 路由仅含 `rootRef / tabId / frameId / documentId`，没有复制 DOM、页面文本、Key secret 或展开集合。
- 不再保留一份后台内存路由副本，不靠定时请求维持后台存活。
- 使用当前有效 TabRef，向原 Chromium Document ID 注入，并校验返回的 Document ID、frame 和页面侧 TreeRef；不凭相同数字 tabId 对新页面操作。
- 原有 TabRef/DocumentRef/NodeRef 的运行期规则没有整体改造；树结果返回本次有效的 TabRef 和 DocumentRef。
- session 读写失败明确报 `STORAGE_UNAVAILABLE`；不会静默删掉别的已签发路由腾空间。
- 短 session 存取和清理按序处理，导航清理保留新 Document 的路由；各 Key 的网页操作队列不变。

## 3. 修复后的独立真实 Chromium 验证

测试浏览器有独立临时 profile、测试 Key 和测试网页，没有关闭/刷新用户的浏览器。实际指令仍经过扩展—本地 Zig App；CDP 只用于测试环境中明确停止后台这一故障注入，不成为产品能力。

1. 打开测试网页树，展开 HTML、BODY，记录第 2 层和原引用。
2. 给后台设置测试 sentinel，再强制停止该 worker。
3. 第一笔恢复请求直接使用原 BODY TreeRef expand；此前不重新 open，也不先 view 重新签发子节点引用。成功。
4. 使用原 root get；成功，原两条展开路径完全一致。
5. 检查新 worker 已不存在旧 sentinel，确认后台确实更换。
6. 旧 TabRef 仍报 `TAB_REF_STALE`；用树结果返回的新 TabRef reopen，root 相同、`reused=true`。
7. 真正刷新测试页面后，旧 root view 和旧 BODY expand 均报 `TARGET_REF_STALE`。

验证通过：TypeScript 检查与构建；runtime-core 6 项（含 session 读写失败、安全错误、失败后继续、有序清理、清理期间的实际注册写入、保留新文档和其他 tab）；Key-core 7 项；管理页真实 Chromium smoke；39 指令的扩展—relay smoke；拆分开发包校验（extension 29 项、Windows/Linux App 各 9 项）。没有为跑测试停止用户的 relay。独立只读审查未发现具体正确性/安全回归，指出的写入故障覆盖缺口已补测通过。

## 4. 原始文件

旧样本在 F 盘，本轮该盘未挂载。新私密数据单独放在文档目录，没有混入仓库或开发包：

```text
D:\ALL THINGS\Document\BrowserKeyAutomation\browser-samples
├─ 2026-08-31T00-44-36-881Z-tree-idle
│  ├─ interaction.jsonl  # 10 条逐次 request/response，24,221 bytes
│  └─ summary.json
└─ 2026-08-31T00-47-24-522Z-tree-idle
   ├─ interaction.jsonl  # 13 条逐次 request/response，39,665 bytes
   └─ summary.json
```

两份转录的 SHA-256 分别为：

```text
2d49691b79b0367da8af293e7154f7a74f1ca925cd49bd279fe904039929a814
8ba0fcd7f8f5b40283adc92ddb53101a3345e2662a179bc6e87e12a0a7325e22
```

完整 Browser Key 形状扫描均为 0。转录保留的是每次接口的原始返回，包括行、展开状态、失败和 delivery，不声称是一份无限制全 DOM 快照。

独立测试网页的修复后原始交互：`D:\Code\浏览器自动化插件\out\test-artifacts\page-tree-worker-restart.json`。这个文件不含用户页面或用户 Key，可对照测试代码复核。

手动空置复核脚本：`tools/probe-live-tree-idle.mjs`；输入页面 URL 和私密输出目录，Key 从环境变量读取，遇到多个实例或多个同 URL 标签页就明确停止，不猜目标。

## 5. 交付

只更新扩展开发包 `out/browser-key-automation-extension-dev.zip`；原目录为 `out/browser-key-automation-extension-dev`，根目录直接含 manifest。本地 App 二进制、Key 权限模型、指令 schema 和选择算法都未改。

ZIP 为 79,567 字节，SHA-256 `a36e0521b7736da11f3daaaae3c5495ab885fc1d8504aa782f5faf1f94f32bc0`。

更新扩展时需要重新加载一次；这不要求网页在每次空置后刷新。用户随后提供新 Key，本轮直接使用该 Key 的临时环境鉴权，未读写桌面 Key 文件，真实验证结果如下。

## 6. 用户真实浏览器更新后复测：通过

本轮只调用 `tabs.list` 和三条树指令；没有切换前台、刷新网页、停止后台或更改设置。当前唯一实例为 relay 分配的 `iEbt0FBNowfFRzXLAlysuA/4`，整组调用固定该实例。

| 顺序 | 实际操作 | 实际结果 |
|---|---|---|
| 1 | 打开已有 B 站首页的树，get 第 0 层 | 2 行：doctype、HTML |
| 2 | expand HTML，get 第 1 层 | 11 行；BODY 位于 `[1,6]` |
| 3 | expand BODY，get 第 2 层 | 39 行；已展开路径为 `[1]` 和 `[1,6]` |
| 4 | 停止浏览器请求 45,015 ms | 页面不刷新，不用调试器或心跳保活 |
| 5 | 第一笔恢复请求直接 get 原 root | 成功，91 ms，仍为 39 行；root 和两条展开 TreeRef/路径均未改变 |
| 6 | 直接 expand 原 HTML TreeRef | 成功，77 ms；没有先 reopen |
| 7 | 用空置前的旧 TabRef reopen | `TAB_REF_STALE`，符合既定 TabRef 运行期规则；不影响前两笔原 TreeRef 操作 |
| 8 | 显式 tabs.list，再用当前 TabRef reopen/get | 成功，`reused=true`、root 相同、两条展开路径保留 |

这证明真实个人浏览器中的空置问题已修复。不能把旧 TabRef 失效伪装成成功，也不能把它与树引用丢失混为一谈；本轮直接使用原树的两笔请求均收到了成功的 `extension_response`。91/77 ms 是这一次调用的观测值，不是性能保证。

新私密原始文件：

```text
D:\ALL THINGS\Document\BrowserKeyAutomation\browser-samples\2026-08-31T01-13-49-049Z-tree-idle
├─ interaction.jsonl  # 13 次原始 request/response，57,066 bytes
└─ summary.json       # 1,377 bytes
```

- `interaction.jsonl` SHA-256：`2b0b71bece40f5d338d611dacff3ea347812aa39da5912ce0e7d8c943fd78384`。
- `summary.json` SHA-256：`d3483bcca3c2c0434a055079aba1043b4bae4f87e611a23aa94a62eed30df7e8`。
- 已独立复算转录哈希、检查 13 条记录、比较空置前后的 root/展开 TreeRef/路径；完整 Browser Key 形状扫描为 0。
- 等待包装工具超时后，检查确认采集进程已退出且上述文件完整落盘；依据持久化原始结果完成核对，没有因此重发浏览器操作。

本轮没有修改产品代码、接口、权限、开发包或选择算法，只补真实运行证据与进度记录。

## 7. 审查修复交付后，用户再次重载的真实复测

2026-08-30 本机时间，用户报告“重新加载了”后复测。先无 Key 枚举到唯一实例 `iEbt0FBNowfFRzXLAlysuA/6`，再固定该实例使用用户此前提供的 Key；Key 仅进入子进程临时环境，没有读写桌面 Key 文件。`system.describe` 鉴权成功，返回 39 条 active command。随后只在已有 B 站首页执行树操作，没有新建/切换/刷新页面，没有停止后台或使用 debugger。

| 顺序 | 实际操作 | 实际结果 |
|---|---|---|
| 1 | open 后 get 第 0 层 | `reused=false`，2 行：doctype、HTML |
| 2 | expand HTML，再 get 第 1 层 | 11 行，BODY 位于 `[1,6]` |
| 3 | expand BODY，再 get 第 2 层 | 39 行，展开路径 `[1]`、`[1,6]` |
| 4 | 45,008 ms 不发送浏览器请求 | 没有刷新、导航、调试器或业务心跳 |
| 5 | 直接用原 root get、原 HTML TreeRef expand | 两笔均成功收到 `extension_response`，分别 97/61 ms；仍为 39 行，原 root、展开 TreeRef 和路径完全相同 |
| 6 | 用旧 TabRef reopen | `TAB_REF_STALE`；不把该失败当成树引用失效 |
| 7 | 显式重新 tabs.list，使用当前 TabRef reopen/get | `reused=true`，同一 root，39 行及原展开 TreeRef/路径保留 |

本轮按项目 `browser-key-automation` skill 固定当前实例，使用树视图而非全页 DOM 抓取，并如实保留旧 TabRef 失败；没有隐藏重试该旧请求。45 秒空置本身不证明 worker 已回收，本轮证明的是原树引用和展开状态在这次真实空置后的可用性。

原始文件保持在私密样本目录，不进入仓库或开发包：

```text
D:\ALL THINGS\Document\BrowserKeyAutomation\browser-samples\2026-08-31T03-51-54-519Z-tree-idle
├─ interaction.jsonl  # 13 次逐次 request/response，60,178 bytes
└─ summary.json       # 1,377 bytes
```

- `interaction.jsonl` SHA-256：`c37af48202d3c1fc3cc2e27c4fe23d3629bf1617cb2e8afb4280a015467c3f99`。
- `summary.json` SHA-256：`ceb055bf454467555e9fa0aa0a461b992a577089eee794e4b1659b53e9727c0e`。
- 已重新解析 13 条原始记录，逐项比较空置前后及 fresh reopen 后的 root、展开 TreeRef/路径；完整 Browser Key 形状扫描为 0。

部署边界：该次检查时运行中的本地 App 仍为 PID 24896，路径 `out/browser-key-automation-local-app-windows-x86_64-dev/browser-key-relay.exe`，该文件 SHA-256 为 `75fb90273d84b12f9cad75e53635c31bc94527eeb99d5aca3f6828572191a2d5`；新交付包内 relay 为 `ca3fb3f4f81c57b38ebe8e4177549812511788274fe6d827d94d46c172682658`。仅该次扩展重载没有更新本地 App；后续已按用户指示完成新版 App 重启，见第 8 节。`system.describe` 的 `0.0.0.1` 版本号不区分这些开发构建，不能据此断言已加载文件与新包逐字节相同。第 7 节这轮只记录真实行为结果，没有替用户停止或替换 App，也没有修改产品代码、开发包或选择算法。

## 8. 按用户指示切换修复版 App 并重启：通过

用户明确要求“那就重启应用下修复啊”后，按配套 skill 正常停止旧 App，再启动已交付并核验哈希的修复版；没有强杀进程、刷新浏览器页面或更改 Key。

| 步骤 | 实际操作与结果 |
|---|---|
| 1 | 核对固定端口 `127.0.0.1:32189` 的监听者确为旧 PID 24896；新包 exe 哈希与交付值一致 |
| 2 | CLI `stop` 返回 `stopping=true`，确认旧进程正常退出且端口释放 |
| 3 | 从 `out/review-fixes-2026-08-30/browser-key-automation-local-app-windows-x86_64-dev/browser-key-relay.exe` 后台启动 PID 46104；此进程成为固定端口的唯一监听者 |
| 4 | 等待 10 秒后的首次无 Key `instances` 检查已连通；新实例为 `vryXrHxsc9CNL7YRYwxLdg/1`，没有使用旧 relay epoch |
| 5 | 原 Key 直接鉴权成功；已有 B 站页面 `open` 返回 `reused=true`，root 和 HTML/BODY 的 TreeRef、展开路径与 App 重启前完全相同，第 2 层仍为 39 行 |
| 6 | 再空置 45,007 ms，直接读取原 root 和展开原 HTML 均成功，分别 88/67 ms；39 行和展开状态不变。旧 TabRef 按既定规则失效，显式重新获取后仍复用同一 root |

本轮核验的运行 exe SHA-256 为 `ca3fb3f4f81c57b38ebe8e4177549812511788274fe6d827d94d46c172682658`，与修复版包一致。App 保持运行。旧包目录没有覆盖或删除；后续手动启动应使用上述修复版路径。本轮没有修改产品代码、包或选择算法，也没有把这次有限复测扩大描述为所有修复的个人浏览器全面验收。

私密原始样本：

```text
D:\ALL THINGS\Document\BrowserKeyAutomation\browser-samples\2026-08-31T03-59-58-873Z-tree-idle
├─ interaction.jsonl  # 13 次逐次 request/response，60,175 bytes
└─ summary.json       # 1,377 bytes
```

- 转录 SHA-256：`55d96aaddd1297a161b1105b4da36a4206f6e4e99dd9b772c96a77fea919f62b`。
- 摘要 SHA-256：`8a12b59b1ab98a9e5bedb81af5f6d934c7e8cef34c5b4f6ace61c0ba7760d75c`。
- 两文件已解析、复算哈希及扫描完整 Browser Key 形状，匹配数为 0；与第 7 节原始样本逐项比较，确认跨 App 重启的 root 和展开 TreeRef/路径没有变化。
