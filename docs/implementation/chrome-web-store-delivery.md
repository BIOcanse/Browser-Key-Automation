# Chrome Web Store 交付切片

更新：2026-08-31。

> 当前状态：按用户 2026-08-31 的最新裁定暂停。现有图标仅是开发阶段临时图标；在图标设计确认前，不上传本页 ZIP、不创建 Dashboard 条目、不提交审核。当前对外交付改为 [GitHub Release 两资产](github-release-delivery.md)。

本切片只增加 Chrome Web Store 发布产物与仓库发布边界，不改变扩展命令、Key 鉴权、页面树、占据、relay 路由或 `.real` 语义。

## 目标

1. 源码构建继续保留固定 `manifest.key`，使解压开发版保持确定扩展 ID，并让 Zig App 的 exact-Origin 门禁可由同一生成链得到。
2. Web Store ZIP 根目录直接包含 `manifest.json` 和全部运行文件；不嵌套顶层目录，不混入开发说明、校验清单、源码、私钥或本地 App。
3. 首次上传 ZIP 的清单副本移除 `key`。Chrome Web Store 创建条目后，以 Dashboard 的 public key / Item ID 解析正式的 release identity profile，再重新生成商店扩展与配套 Zig App 门禁并构建更高版本的正式候选。
4. 初始 ZIP 只用于创建 Dashboard 条目，不应在完成身份同步前发布；否则商店安装版的 Origin 与当前本地 App 门禁不同，扩展会被拒绝连接。
5. 每个 ZIP 旁生成 SHA-256 摘要；自动检查根层级、版本、描述、本地化、图标尺寸和敏感文件排除。

## 图标

品牌主稿是仓库内的确定性 SVG。扩展跟踪 16、32、48、128 像素 PNG，并在清单的 `icons` 与 `action.default_icon` 中声明。128 像素图标遵循 Chrome 的商店布局：图形内容位于 96×96 中央区域，四周各保留 16 像素透明留白。

商店 listing 的截图和宣传图属于 Dashboard 元数据，不进入扩展 ZIP；后续沿用 Smart Preload 的分层方式放在独立的 `assets/chrome-web-store/` 路径，不和扩展运行资产混在一起。

## 产物

执行：

```powershell
npm run build:chrome-web-store:first-upload
```

生成：

```text
out/chrome-web-store/
├── browser-key-automation-chrome-web-store-initial-upload-v<version>/
├── browser-key-automation-chrome-web-store-initial-upload-v<version>.zip
├── browser-key-automation-chrome-web-store-initial-upload-v<version>.zip.sha256.txt
└── NEXT-STEPS.md
```

`NEXT-STEPS.md` 位于 ZIP 外，避免把开发说明提交给商店扫描器。

## 身份衔接

首次上传后必须从 Dashboard 的 Package 页取得 Item ID 与 public key，并验证二者相符。之后：

1. 把 Dashboard public key 与 Item ID 记录为 `build.extension.identity_profile` 的 release resolved fact；当前开发公钥继续作为 dev profile，避免让现有 unpacked origin 下的 IndexedDB、Key 与设置静默消失。
2. 由 release profile 生成候选 manifest，确认派生 extension ID 等于 Dashboard Item ID。
3. 将扩展版本递增，使用同一 release profile 重新构建扩展和 Windows/Linux App；Zig App exact-Origin 随生成链同步。
4. 生成新的无 `key` 商店 ZIP，作为同一 Dashboard 条目的更新包，再做真实商店安装联调；dev 与 release profile 的产物不得混装。

不保存、提交或要求用户提供 Chrome Web Store 私钥。当前采用 Dashboard 分配身份再同步 public key 的官方流程。

## 验收

- ZIP 根目录存在 `manifest.json`，没有额外顶层产品目录。
- ZIP 清单没有 `key`，源码清单仍有固定 `key`。
- `name`、`version`、`description`、`icons`、`default_locale` 和 `minimum_chrome_version` 完整。
- 16/32/48/128 PNG 都是对应的正方形尺寸，128 图标具有透明外边缘。
- ZIP 不含 `key.pem`、`.map`、`START-HERE.md`、`SHA256SUMS.txt`、本地 App 或仓库缓存。
- 解压后的文件集合与打包目录完全一致，旁置 SHA-256 可复算。

## 一手依据

- Chrome Web Store 准备说明：<https://developer.chrome.com/docs/webstore/prepare>
- 固定扩展 ID / Dashboard public key：<https://developer.chrome.com/docs/extensions/reference/manifest/key>
- 商店图像要求：<https://developer.chrome.com/webstore/images>
- 首次上传流程：<https://developer.chrome.com/docs/webstore/publish>
