# Browser Key Automation

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | 日本語 | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md) | [Русский](README.ru.md)

**いつものブラウザーを、そのまま Agent に。**

ログイン済みの Chromium タブで、ページの確認から操作、結果の保存まで。通常の操作は拡張機能の権限を使い、専用ブラウザーや自動的なデバッガー接続、拡張独自の操作ごとの確認は不要です。ブラウザー自身の権限確認は残ります。

## できること

- **必要な部分だけ読む。** キャッシュされた操作ツリーは全体構造を保ち、指定した枝だけ展開します。文書が変わらなければタブを戻しても状態を保持。深さ・範囲・部分ツリーの取得は一回限りの表示選択です。
- **タブをまたいで作業。** 明示的な参照、Key ごとの直列実行、タブ・ウィンドウ・全体の占有で共同作業の衝突を減らします。
- **結果を持ち出す。** MHTML 保存、ページや Canvas 要素の画像、リソース転送、サーバー不要の HTML デモ。
- **入力を使い分ける。** DOM、Windows の実入力、独立した仮想マウス・キーボード、必要時の CDP。
- **結果を確かめる。** `ensure.run` は条件、期限付き準備、操作、観測可能な目標をまとめます。結果不明の操作を無条件に再実行しません。

## 使い始める

> 新規インストールには共通の**公開 Root 試用 Key**が含まれ、値は Agent skill に記載されています。個人ブラウザーでは非公開 Key を作成し、クライアントを切り替えてから試用 Key を失効させてください。作成だけでは無効になりません。更新時には追加・復元しません。

1. Chromium **138+**、Windows または Linux x64、CLI 用 **Node.js 20+** が必要です。[最新リリース](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest)の両 ZIP を別々に展開してください。

   - `browser-key-automation-extension-v0.0.0.5.zip`
   - `browser-key-automation-local-app-v0.0.0.5.zip`

2. `chrome://extensions` の開発者モードで `manifest.json` を含むフォルダーを読み込みます。ツールバーから Key を管理。`js.execute` には **Allow User Scripts** が必要ですが、DOM とツリーには不要です。

3. 下記コマンドで App を起動。Windows では `virtual-mouse-hook.dll` を実行ファイルと同じ場所に置きます。未接続時は約 10 秒ごとに `127.0.0.1:32189` へ再接続します。

```text
# Windows
.\windows-x86_64\browser-key-relay.exe

# Linux
chmod +x ./linux-x86_64/browser-key-relay
./linux-x86_64/browser-key-relay
```

4. Agent に同梱の `skill/browser-key-automation/SKILL.md` を読み込ませます。インスタンスを列挙して対象を選び、非公開 Key は引数ではなく環境変数 `BKA_API_KEY` で渡します。他のインスタンスを Key で総当たりしないでください。

```text
node client/browser-key-cli.mjs instances
node client/browser-key-cli.mjs call --method system.describe --schema-version 1 --params-json "{}"
```

## ページから成果へ

`system.describe` で有効な権限を確認し、正確な引数は[コマンド定義](dev/skills/browser-key-automation/references/commands.registry.json)を参照してください。

| | API / CLI |
| --- | --- |
| 探索・選択・展開 | `tabs.list` → `page.tree.open` → `page.tree.find` / `page.tree.expand.v2` → `page.tree.view.get` |
| ページ条件を待つ | `page.wait` · `ensure.run` |
| ページ保存・画面・要素画像 | `page-save` · `page-shot` · `element-shot` |
| HTML を送信して表示 | `demo-open` |
| DOM・実クリック | `dom.click` · `dom.click.real` |
| テキスト・ショートカット・キー解放 | `keyboard.type` · `keyboard.typeHuman` · `keyboard.press` · `keyboard.reset` |
| 仮想マウス・キーボード | `virtualMouse.*` · `virtualKeyboard.*` |
| 入力先の計測 | `input.calibrate` |
| 明示的な CDP 接続 | `debugger.attach` → `debugger.send` → `debugger.events.get` → `debugger.detach` |

```text
node client/browser-key-cli.mjs page-save --tab-ref <TabRef> --output ./page.mhtml
node client/browser-key-cli.mjs element-shot --node-ref <NodeRef> --width 800 --height 600 --output ./element.png
node client/browser-key-cli.mjs demo-open ./demo.html
```

## Key と入力の制約

- Root は全有効権限を持ちます。Regular Key は展開可能な権限グループ、有効期限、再表示、無効化、失効に対応。JavaScript と実入力の権限は独立です。Key は支払い・投稿・削除の利用者同意を代替しません。
- 仮想入力状態は Key に属し、タブ間で保持されます。対象ウィンドウ全体の占有が必要です。通常の仮想入力には有効な `input.calibrate` が必要で、`ensure.run` は必要時に再計測します。実入力は前面ウィンドウを要求し、仮想入力は物理カーソルを動かしません。
- Windows はネイティブ入力に対応。Linux は現在、ブラウザーへの中継とファイル処理のみです。最小化は非対応。初回計測には計測可能なページが必要で、遮蔽時の再利用は条件付きです。複数ウィンドウの初回計測と完全な HTML5/OLE ドロップには未解決例があります。
- 要素画像は可視領域と対応形状のマスクを使い、隠れた画素を復元しません。制限ページ・サイト権限・ユーザースクリプトは Chrome が管理。`debugger.attach` の警告も残ります。合成イベントや仮想メッセージは万能な制限回避ではありません。

## 向いている用途

日常ブラウザーへの簡単な接続、選択的なツリー、操作とファイルの一貫した流れが中心です。テスト基盤や DevTools 全体の代替ではありません。

| | |
| --- | --- |
| [Playwright](https://playwright.dev/docs/intro) · [Selenium](https://www.selenium.dev/documentation/overview/) | クロスブラウザーテスト・CI |
| [Puppeteer](https://pptr.dev/) | プログラムによる自動化 |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | アクセシビリティスナップショット |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | 詳細なブラウザー診断 |
| [Browser MCP](https://browsermcp.io/) · [Chrome MCP Server](https://github.com/hangwin/mcp-chrome) | 既存ブラウザー向け MCP |
| [Nanobrowser](https://github.com/nanobrowser/nanobrowser) | ブラウザー内 Agent UI |

## ガイドと保守

[Agent skill](dev/skills/browser-key-automation/SKILL.md) · [Operation tree](dev/skills/browser-key-automation/references/operation-tree.md) · [Ensure](dev/skills/browser-key-automation/references/ensure-workflows.md) · [Virtual input](dev/skills/browser-key-automation/references/virtual-mouse.md) · [Capture & CDP](dev/skills/browser-key-automation/references/debugger-and-element-capture.md)

拡張 UI は 20 言語、README は 10 言語版です。[プライバシー](PRIVACY.md) · [開発構成](dev/README.md)。作者が保守し、外部からの貢献や Pull Request は受け付けていません。
