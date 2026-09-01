# Chrome Web Store 提交材料

更新：2026-09-01。

本页记录当前 `0.0.0.1` 身份引导包对应的 Store Listing 与 Privacy practices 原文。字段文案来自现行 Manifest、实际命令实现和 Chrome 官方政策，不把 Dashboard 截图当作产品指令，也不改变扩展能力。

## 当前边界

- Dashboard 条目创建与资料填写已经恢复；当前上传包仍然只是取得 Store Item ID / public key 的身份引导包。
- 在 Item ID / public key 回填 release identity profile、扩展和 Windows/Linux App 的 exact-Origin 门禁同步、版本递增及真实商店安装联调完成前，不提交审核或发布。
- Support URL 目前留空，使用 Chrome Web Store 自带 Support 区；私有 GitHub 仓库不能作为公开支持地址。
- Privacy policy URL 是发布前唯一尚未有公开 URL 的资料字段。仓库根部 [PRIVACY.md](../../PRIVACY.md) 是可发布正文，必须先放到无需登录即可访问的 HTTPS 页面，再把该 URL 填入 Dashboard。

## Product details

### Description

以下整段直接填入 English listing 的 `Description`：

```text
Browser Key Automation gives trusted agents and automation programs controlled access to Chromium through extension APIs.

DATA DISCLOSURE
When you create and share an API Key, an authorized client can request data from the browser tabs and signed-in pages you select. Depending on the command and Key permissions, this can include tab URLs and titles, frame and navigation state, DOM structure, page text, form values, resource URLs, screenshots, MHTML archives, and explicitly fetched resources. Page content may contain personal, authentication, financial, health, location, or communications data. API Keys, settings, and bounded Artifacts are stored on this device. Results are sent through the local companion App only to Key-authenticated clients chosen by the user. Browser Key Automation has no developer-operated cloud service, analytics, advertising, or data sale.

The extension creates local API Keys with explicit permissions, optional expiration, disable, reveal, and revoke controls. A separately downloaded local App relays authenticated commands on this computer.

Key features:
- Scoped regular Keys and root Keys
- Tab navigation and lifecycle operations
- Bounded DOM, text, resource, frame, and operation-tree access
- DOM click, focus, value, selection, and scroll actions
- Page waits, visible screenshots, MHTML capture, and explicit resource downloads
- User-provided JavaScript through Chrome's User Scripts API when separately enabled and permitted
- Multi-client tab and global occupation controls that prevent conflicting automation

Browser Key Automation does not use Chrome's debugger permission. It cannot access Chrome-internal or other browser-restricted pages. The companion local App is required and is distributed separately for Windows x64 and Linux x64.
```

### Category

`Developer Tools`

### Support URL

留空。当前私有仓库 URL 对普通商店用户和审核人员不可用，不能填。发布后启用 Chrome Web Store 自带 Support 区。

## Graphic assets

运行：

```powershell
npm run render:chrome-web-store-listing
```

可得：

- `store-icon-128.png`：128×128，上传 `Store icon`。
- `small-promo-440x280.png`：440×280，上传必需的 `Small promo tile`。
- `screenshot-1-setup-1280x800.png`：英文首次安装与 User Scripts 设置。
- `screenshot-2-key-management-1280x800.png`：英文 Key 管理主界面。
- `screenshot-3-key-permissions-1280x800.png`：英文 Key 权限界面，可作为第三张截图。

截图来自隔离 Chromium 中真实运行的扩展 UI，Key 为测试夹具生成且只显示掩码；不是设计稿。商店要求至少一张截图，推荐按上述顺序上传前三张。

## Privacy practices

### Single purpose description

```text
Provide user-authorized, API-Key-scoped browser automation to trusted agents and programs through Chromium extension APIs.
```

### offscreen justification

```text
Maintains the extension's long-lived WebSocket transport to the companion App on 127.0.0.1 and the fixed reconnect cadence while the Manifest V3 service worker may suspend. The offscreen document contains no UI, does not browse remote sites, and only forwards bounded protocol messages between packaged extension code and the local relay.
```

### pageCapture justification

```text
Used only for the explicit page.archive.capture command. It calls chrome.pageCapture.saveAsMHTML for the selected tab and stores the returned archive as a bounded, Key-owned local Artifact so the authorized client can save the page. No background or automatic capture occurs.
```

### scripting justification

```text
Runs packaged, reviewable functions in the user-selected tab to inspect bounded DOM, text, and resource data, build the operation tree, evaluate explicit wait conditions, and perform requested DOM actions. Arbitrary user code is not executed through scripting; that separate feature uses chrome.userScripts and its own Key permission.
```

### storage justification

```text
Stores runtime-only tab and document references, operation-tree expansion state, tab or global occupations, settings, and connection state on this device. API Key records and bounded Artifacts are stored locally in extension IndexedDB. Storage is required for scoped authorization, stale-reference safety, explicit saves, and recovery across service-worker suspension; it is not used for analytics or advertising.
```

### tabs justification

```text
Provides the explicit tab automation commands: list or get metadata, create, navigate, activate, reload, and close tabs. It is also used to capture the visible viewport of an already-active tab and to open the packaged setup, options, and demo pages. Every external tab action requires an authenticated Key with the matching permission.
```

### userScripts justification

```text
Provides the explicit js.execute feature for arbitrary JavaScript supplied by a user-authorized client. Code runs only in the exact selected tab and requested USER_SCRIPT or MAIN world, requires a Key with js.execute permission, is bounded by source and result limits and a timeout, and additionally requires Chrome's per-extension Allow User Scripts toggle.
```

### webNavigation justification

```text
Tracks committed top-level and frame navigations and lists the current frames for an exact tab. This lets the extension issue document and frame references, invalidate stale DOM references after navigation, and implement explicit URL and document readiness waits. It does not build or retain a general browsing-history database.
```

### Host permission justification

```text
<all_urls> is required because the extension's single purpose is general browser automation on the web pages the user chooses, rather than automation of a fixed site list. It enables the requested DOM, tree, text, resource, wait, user-script, and action features on those pages. Access still follows Chrome site-access controls, browser-restricted pages remain unavailable, and every client command requires an authorized Key.
```

### Remote code

选择 `Yes, I am using remote code`，理由：

```text
Yes. The extension intentionally accepts JavaScript supplied by a user-authorized client for the explicit js.execute feature. It executes that code only through Chrome's documented User Scripts API in the exact selected tab and requested USER_SCRIPT or MAIN world. Chrome's per-extension Allow User Scripts toggle and a Key with js.execute permission are both required. The extension does not download or replace its own logic, load remote modules, or use eval in privileged extension pages. All extension logic and UI are packaged. User-provided demo HTML may execute only inside a sandboxed page with no extension API access.
```

不能选择 `No`：`js.execute` 的源码由 Key 客户端提供且不在扩展包中。Manifest V3 政策明确允许通过 User Scripts API 执行这类逻辑，但这只是允许路径，不会把 Dashboard 的事实回答变成 `No`。

### Data usage

勾选：

- Personally identifiable information
- Health information
- Financial and payment information
- Authentication information
- Personal communications
- Location
- Web history
- Website content

不勾选 `User activity`：扩展能执行明确请求的点击或滚动，但不会持续收集或记录人的点击、鼠标位置、滚动或击键活动。

这里采用能力上限披露：通用自动化可以在用户明确选择的已登录页面中处理上述内容，不能因为它们都属于网页内容就只勾 `Website content`。每类数据都只在具体命令与 Key 权限需要时处理，并不表示后台持续收集。

Limited Use 的所有认证项均勾选：不出售或违规转移数据；不用于单一目的以外的用途；不用于信用或借贷判断。

### Privacy policy URL

把 [PRIVACY.md](../../PRIVACY.md) 发布到无需登录即可打开的公共 HTTPS 页面后，填写其 URL。私有仓库文件、私有 Release 或本地路径均不合格。

## 提交前阻断项

1. 从 Dashboard `Package` 页取得 Item ID 与 public key。
2. 完成 release identity profile、扩展和两端 App 门禁同步，并递增扩展版本。
3. 用商店安装版与配套 App 做一次真实联调。
4. 发布 `PRIVACY.md` 并填入公共 HTTPS URL。
5. 确认 Description 的 `DATA DISCLOSURE` 保持在首屏，不删减；2026-08-01 起执行的新政策要求所有数据处理在安装前显著披露并取得知情同意。
6. 完成 Distribution、测试说明及 Dashboard 其余认证后，才提交审核。

## 一手依据

- Chrome Web Store 图像尺寸：<https://developer.chrome.com/docs/webstore/images>
- Privacy practices 字段：<https://developer.chrome.com/docs/webstore/cws-dashboard-privacy>
- 2026 数据披露政策更新：<https://developer.chrome.com/blog/cws-policy-updates-2026>
- Disclosure Requirements：<https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements>
- Limited Use：<https://developer.chrome.com/docs/webstore/program-policies/limited-use>
- User Data FAQ：<https://developer.chrome.com/docs/webstore/program-policies/user-data-faq>
- Manifest V3 远程逻辑例外：<https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements>
- User Scripts API：<https://developer.chrome.com/docs/extensions/reference/api/userScripts>
