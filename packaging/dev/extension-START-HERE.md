# Browser Key Automation 浏览器扩展

这是独立的 unpacked Chromium 扩展开发包。解压后，本目录根部直接存在 `manifest.json`；Chrome 应选择本目录本身，不需要再进入任何 `extension/` 子目录。

扩展会请求 `tabs`、`<all_urls>`、`scripting`、`userScripts`、`debugger` 等广泛权限，只应把生成的 Key 交给可信 Agent 或自动化程序。普通操作与元素截图不附加调试器；只有显式 `debugger.attach` 才启用调试，Chrome 自身的调试提示无法消除。Regular Key 需在独立“浏览器调试”权限组中授权，Root 自动包含。

当前支持 Chrome 138+。其他 Chromium 衍生浏览器需要按各自的扩展 API 与策略配置验证。

## 安装

1. 完整解压 extension ZIP。Chrome 不能直接加载 ZIP。
2. 在 Chrome 地址栏输入 `chrome://extensions`。
3. 开启“开发者模式”，点击“加载已解压的扩展程序”。
4. 选择这个解压目录本身；确认所选目录根部直接含 `manifest.json`。
5. 首次安装会自动打开本地介绍页，按页面指引完成设置。以后可从 Key 管理页的“安装与使用说明”重新打开；更新/重载不会重复弹出。打开扩展详情并核对：
   - 名称：`Browser Key Automation`
   - 版本：`0.0.0.3`
   - ID：`dbbbehdkedibhielmkaoohbeebnbfjbo`
6. 在详情页开启 **Allow User Scripts / 允许用户脚本**，返回扩展列表并点击“重新加载”。介绍页提供“打开扩展权限设置”和“重新检测”；后者只刷新当前说明页，不代替重载扩展。此开关由浏览器管理，插件不能代开，Root Key 也不能替代。任意 JS 执行必须开启；未开启时 Key 管理、DOM 和页面树仍可用。
7. 在浏览器工具栏或扩展菜单中点击 **Browser Key Automation**；它会在完整标签页中直接打开 Key 管理界面。需要常用时可把扩展固定到工具栏。“详情 → 扩展程序选项”是同一页面的备用入口。
8. 点击页面右上角 **创建 Key**，把类型从默认的 **Regular 明确改为 Root**，按需填写有效期，保持“立即启用”，然后创建。
9. 在创建结果中复制 Key。完整 Key 保存在这个扩展的本地数据库中；以后可在对应行点击“显示”或“复制”，隐藏、刷新或关闭页面不会删除它。旧开发版创建且仅有 verifier 的记录会显示“补存现有 Key”，可输入手中原始 Key 完成本地保存。

扩展与本地 App 分开交付。请另行解压并运行当前平台的 `browser-key-automation-local-app-...-dev` 包。扩展在 App 未运行时每 10 秒继续尝试连接。

管理页顶部的“后台：已连接”只表示管理页连到了扩展后台，不表示本地 App 已连接。本地实例是否 ready 只以 Agent/client 的 `instances` 结果为准。

## 常见问题

| 现象 | 含义与动作 |
|---|---|
| Load unpacked 提示缺少 manifest | 选错目录或没有完整解压；选择本包解压后直接含 `manifest.json` 的根目录。 |
| 扩展 ID 不同 | 立即停止；该 artifact 不会通过本地 App 的 exact Origin gate。 |
| 点击扩展图标没有打开管理页 | 在 `chrome://extensions` 对本扩展点击“重新加载”；若仍无入口，确认加载的是当前包且 manifest 根部含 `action`。 |
| “后台已连接”但 Agent 看不到实例 | 检查本地 App，等待至少一个 10 秒重试周期，再核对扩展 ID。 |
| 已开 Allow User Scripts，JS 仍不可用 | 重新加载扩展并重新枚举实例；仍失败则记录 Chrome 版本和策略。 |
| Agent 收到 USER_SCRIPTS_NOT_ENABLED | 按错误的 setupInstructions 开启上述开关；文档/skill 也要求 Agent 提醒用户，而不是反复重试。 |
| 生成结果未知 | 不改表单，原样再次点击生成，让同一 mutation 收敛。 |
| Key 当前被隐藏 | 在对应行点击“显示 Key”；这是显示状态，不会删除本地保存的 Key。 |
| 旧 Key 显示“需补存” | 点击“补存现有 Key”，输入与该记录匹配的完整原始 Key；校验通过后即可反复显示。 |

`SHA256SUMS.txt` 覆盖本目录内除清单自身外的所有文件。
