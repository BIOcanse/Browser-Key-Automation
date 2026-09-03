Browser Key Automation — Chrome Web Store 资产说明

本目录保存可重复生成的商店视觉资产源码。运行 `npm run render:chrome-web-store-listing` 会在 `out/chrome-web-store/listing-assets/` 生成 128×128 图标、440×280 宣传图和三张 1280×800 实际扩展界面截图。

商店提交应使用 `npm run build:chrome-web-store:first-upload` 生成的专用 ZIP，不能使用 GitHub Release 的手动安装包。每次提交前核对：

1. manifest 版本高于 Dashboard 中已上传的版本，扩展 ID 与本地 App 的 exact-Origin 门禁一致。
2. Category 为 Developer Tools；Support URL 可使用公开仓库主页 `https://github.com/BIOcanse/Browser-Key-Automation`。
3. 隐私政策使用公开的 `PRIVACY.md`，并与 Dashboard 数据披露保持一致。
4. Remote code 选择 Yes：`js.execute` 的代码由持有 Key 的客户端提供，并通过 Chrome User Scripts API 执行；扩展包本身不从开发者服务器下载脚本。
5. Data usage 如实披露 Personally identifiable information、Health information、Financial and payment information、Authentication information、Personal communications、Location、Web history、Website content；不勾选未收集的 User activity。
6. 上传本目录生成的图标、宣传图和按编号排序的三张界面截图。截图只显示隔离测试生成的掩码 Key，不含真实 API Key。

Dashboard 中的 Item ID、审核状态和线上版本是发布时的外部真值，不在仓库文案中保存临时快照。
