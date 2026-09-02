Browser Key Automation — Chrome Web Store 提交包

1. 逐字段英文原文：打开 01-CHROME-WEB-STORE-FORM-COPY.md。
2. 隐私政策正文：02-PRIVACY-POLICY.md。发布前必须把它放到无需登录即可访问的公共 HTTPS 页面，并把 URL 填入 Dashboard。
3. Category 选择 Developer Tools。
4. Support URL 留空；当前私有 GitHub 仓库不能作为公共支持地址。
5. Remote code 必须选 Yes，并粘贴表单原文中的理由。js.execute 的输入代码来自 Key 客户端，但只通过 Chrome 明确允许的 User Scripts API 执行。
6. 上传 store-icon-128.png、small-promo-440x280.png，以及三张 screenshot-*.png（按编号排序）。
7. Data usage 勾选：Personally identifiable information、Health information、Financial and payment information、Authentication information、Personal communications、Location、Web history、Website content；不要勾 User activity。
8. 已上传的 v0.0.0.1 ZIP 只是身份引导包。后来生成的 ZIP 也不要直接提交审核或发布；先从 Dashboard Package 页取得 Item ID 与 public key，交回项目同步 release identity、Windows/Linux App 门禁，再做真实商店安装联调。

本目录不包含任何真实 API Key。截图中的 Key 为隔离测试夹具生成且只显示掩码。
