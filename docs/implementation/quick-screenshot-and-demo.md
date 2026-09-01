# 一键截图与 HTML 演示实现合同

2026-08-31。用户指示：开始落地。状态：已实现并交付；68 项 Node、10 项 Zig、四路隔离烟测及分包校验通过，见[真实交互与原始样本](../experience/quick-shot-demo-2026-08-31.md)。本轮没有修改或重启个人浏览器/App。

## 行为

本地 `page-shot --tab-ref … --output …` 调既有截图指令，再复用 Artifact 下载校验和不覆盖落盘；默认 PNG，JPEG 质量默认 80，扩展 registry 唯一展开默认值。导出同路的 `saveScreenshot(options)`。

本地 `demo-open ./demo.html` 将 UTF-8 自包含 HTML 的原始字节分块传入扩展，扩展收齐并核对 SHA-256 后打开沙箱展示页。CSS/JS/图片应包含在 HTML 内。`--tab-ref` 只更新已有演示页；`--active false` 允许不选中标签；可指定 `--window-id` 选择新建窗口位置，但不移动窗口、不请求 OS 前台。导出同路的 `openDemo(options)`。

默认新建并选中演示标签，返回既有 TabRef、Artifact 元数据和输入文件路径；返回表示浏览器接受打开/更新，不声称任意演示脚本执行成功。普通网页的 DOM/树指令暂不扩展到演示沙箱。

## 输入与状态

- 扩展新增 `artifact.upload.begin / append / commit`，共同使用独立并列权限 `artifact.write`；`demo.open` 使用独立并列权限 `demo.open`。只认 Key，沿用每 Key 串行；打开/更新沿用全局或目标标签 occupation。
- begin 声明 HTML 类型与总字节数，扩展按当前 Artifact 配额预留并返回 ArtifactRef、允许的块字节数。append 必须严格匹配当前偏移，最后一块可以较短。commit 核对完整长度和 SHA-256 后才使 Artifact 可读。
- 暂存状态就在原 Artifact 记录中，不建立 UploadId、DemoId、新数据库或文件服务；未完成内容禁止 read/open，已完成内容不可再 append。暂存占用原配额与留存，调用者可显式 release，不隐藏重试或删除。
- 块大小由扩展返回；传输上限不变，大小取既有传输预算内的有界自由点，不把存储块当传输帧。App/relay 不解释业务，也不新增鉴权。
- 固定外层扩展展示页读取已提交 Artifact；manifest sandbox 页承载提交的 HTML。只有打包的外层页可走内部读取入口，sandbox 无扩展 API、Key、文件读取或管理能力。外层地址中的公开 KeyId/ArtifactRef 只定位内容，不放 API Key。
- Artifact 仍有效时刷新可重新读取；到期/释放明确显示不可用。演示原始文件不移动、不删除。普通页面不得被 `demo.open --tab-ref` 替换。

## 文件落点

- `apps/client/src/artifact-files.mjs`：截图保存；`demo-files.mjs`：有界文件提交；`main.mjs`：CLI/直接调用入口。
- `apps/extension/src/background/artifact-service.ts`：Artifact 写入、完成与读取状态；`demo-service.ts`：打开和内部展示读取；`command-dispatcher.ts`：边界解析/权限/占据。
- `apps/extension/src/demo/` 与 `apps/extension/static/demo/`：固定加载页和沙箱；沿既有 TS/manifest/static 打包链路。
- registry：默认格式、质量、默认选中与上传块上限均有实际 consumer；现有文件容量/留存保持唯一 owner。
- tests：截图封装、上传状态/失败、打开目标/占据、真实 Chromium 脚本/按钮/截图；文档、skill 和扩展/Windows/Linux 分包同步。

## 验收

先验证最小沙箱确实可运行内联 JS，按钮改变可见内容，并由现有截图 API 拿到真实图像，再验完整 CLI 工作流。测试使用现有独占端口/独立 Chromium fixture，不操作个人 Key/网页，不停止个人 32189 relay。记录原始 HTML、截图、命令返回、耗时与每步观察。

针对性负例：无权上传/打开、其他 Key 读取、偏移/长度/哈希错误、未完成读取、已完成追加、过期/释放、输出已存在、已有普通网页被指定、占据冲突、大小超限、传输中断。均由本批单元/集成测试覆盖；非 UTF-8 文件在展示页给出明确另存提示。最后对照本合同自检，不为通过测试增加新业务架构。

交付自检：截图后端、Artifact 仓库、Key lane、占据及 relay 业务边界复用原实现；没有新 HTTP 服务、UploadId/DemoId、目录托管或隐式接管。四个新增自由点只在 registry 定义并由生成器投影到实际入口；普通扩展页 CSP 未放宽，提交的脚本只在 manifest sandbox 中运行。通用 DOM/树操作仍未扩展到演示沙箱；`.real` 不属于本批次，但后续 Windows 产品实现已经完成，见[原生点击实现切片](real-input-slice.md)。Linux 已交叉构建但未声称完成 Linux 真实浏览器验收。
