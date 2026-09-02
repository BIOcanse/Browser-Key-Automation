# Browser Key Automation

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | 日本語 | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md) | [Русский](README.ru.md)

Browser Key Automation は、普段使っている Chromium ブラウザーを、信頼する Agent や自動化プログラム向けの Key スコープ制御面に変えます。拡張機能を一度インストールして Key を作成すれば、許可されたクライアントは別の自動化ブラウザーを起動せず、ログイン済みの既存タブをまたいで操作できます。

主経路は通常の拡張機能 API を使用し、CDP、WebDriver、remote-debugging スイッチ、`chrome.debugger` を使いません。インストール、サイトアクセス、一度だけ必要な **Allow User Scripts** 設定は引き続き Chromium が管理します。設定後の日常コマンドはデバッガーを接続せず、Chrome のデバッグ接続確認や警告バーも表示しません。

## Browser Key Automation を選ぶ理由

- **目の前のブラウザーをそのままシームレスに操作。** ユーザーの実際のログイン状態、Cookie、拡張機能、手動で到達したページ状態を保ちながら、いつでもタブを一覧、作成、選択、移動、再読み込み、終了できます。
- **ページ全体を Agent 向けの小さく明瞭なビューに。** キャッシュされた canonical 操作ツリーは全体構造を残したまま要求された枝だけを展開し、文書が変わるまで Key ごとの展開状態を保持します。深さ、範囲、部分ツリーの一時ビューはキャッシュ状態を変えません。
- **開いたデバッグ端点ではなく Key で信頼を区切る。** Root/Regular Key には明示的な権限、有効期限、再表示、無効化、失効があります。同一 Key の呼び出しは直列化され、異なる Key は独立して動けます。
- **接尾辞ひとつのネイティブクリック。** Windows の `dom.click.real` は拡張機能が得た要素座標とローカル App を組み合わせ、ページが合成 DOM 操作を拒否したときに OS レベルの左クリックを送ります。対象は存続し、可視・有効・遮蔽なしである必要があります。
- **ファイルを第一級の機能として扱う。** MHTML 保存、表示中 viewport の撮影、リソースの有界 Artifact 化とディスク保存、自己完結 HTML のアップロード、ローカル Web サーバーなしのデモ表示を直接行えます。
- **信頼された複数クライアントの協調。** Key はタブまたは全体を占有して不整合を防げます。別の許可済み Key は、明示的に元の占有を解放してから取得します。

### ワークフロー比較

接続モデルは 2026-09-01 時点で確認済みです。理論上の機能上限ではなく、通常の利用経路を比較しています。

| 選択肢 | 既存のログイン済み Chromium | 通常の制御経路 | 適した用途 |
| --- | --- | --- | --- |
| **Browser Key Automation** | 対応。許可された任意のタブを横断 | 通常の拡張機能 API + Key 認証。ローカル App はルーティング、ファイル、任意の `.real` クリックを追加 | デバッガーを接続しない長期 Agent 制御、選択的キャッシュツリー、統合ファイルフロー |
| [Playwright](https://playwright.dev/docs/api/class-browsertype)、[Puppeteer](https://pptr.dev/guides/browser-management)、[Selenium](https://www.selenium.dev/documentation/overview/) | 通常は自動化セッションを作成。既存 Chromium への接続経路もある | Playwright/CDP、Puppeteer/CDP、または WebDriver | 決定的テスト、クロスブラウザー検証、CI、成熟した locator とデバッグ環境 |
| [Playwright MCP 拡張機能](https://github.com/microsoft/playwright/tree/main/packages/extension#readme) | 対応。profile token で自身の以後の接続承認を省略可能 | Chrome の `debugger` 権限を宣言する拡張機能経由で Playwright を中継 | 選択した既存タブでの Playwright action と accessibility snapshot |
| [Chrome DevTools MCP](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect) | remote debugging の有効化またはデバッグ端点の公開後に対応 | DevTools/CDP。Chrome の auto-connect は各デバッグセッションで許可を要求 | Console、Network、Performance、memory などの深い DevTools 診断 |
| [Browser MCP](https://browsermcp.io/) | ユーザーが現在のタブを接続した後に対応 | 拡張機能 + ローカル MCP。明示的に接続した作業タブを対象とする | 選択した既存タブひとつへの小さな MCP 操作面 |
| [Chrome MCP Server](https://github.com/hangwin/mcp-chrome) | 対応。タブを横断 | 拡張機能 + native-messaging bridge。manifest は通常権限に加えて `debugger` を要求 | 広範なクロスタブ MCP、ネットワーク取得、ダウンロード、ファイルアップロード |
| [Nanobrowser](https://github.com/nanobrowser/nanobrowser) | 対応 | Puppeteer/CDP 上の統合ブラウザー Agent。ユーザーが LLM provider Key を指定 | provider-neutral な制御面ではなく、統合された multi-Agent UI |

Browser Key Automation は Playwright/Selenium のテストスイートや DevTools の深い診断を置き換えません。人が使っているブラウザーを低摩擦かつ権限付きで操作し、Agent が実務を完了するための明瞭な構造とファイル機能を提供する別の役割です。

> 開発状況: 現在の unpacked 開発ビルドは Chrome/Chromium 138 以降を対象としています。Chrome ウェブストア版ではありません。Store listing は準備中です。それまでは [GitHub Releases](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest) を使用してください。各 Release のダウンロードは `browser-key-automation-extension-v0.0.0.2.zip` と `browser-key-automation-local-app-v0.0.0.2.zip` の 2 つだけです。

## 主な機能

- ローカル管理画面で Root/Regular Key を作成、再表示、コピー、更新、無効化、失効できます。保存済みの完全な Key は一度限りではなく、後から再表示できます。
- 生のブラウザー ID の代わりに、実行時に拘束された `TabRef`、`DocumentRef`、`NodeRef`、`TreeRef`、`ArtifactRef` を使用します。
- キャッシュされたページ操作ツリーを探索できます。展開状態は Key ごとに保持され、文書が更新または置換されるまで、別ページへ移動して戻っても残ります。
- ツリーを展開せずにノードを検索し、深さ・同一親内の範囲・部分ツリーを一時ビューとして取得できます。有界 live DOM の読み取り、ノード説明、DOM 操作にも対応します。
- Chromium の **Allow User Scripts** を有効にすると、明示した `USER_SCRIPT` または `MAIN` world で JavaScript を実行できます。
- ナビゲーション、`interactive`、`complete`、DOM、テキスト条件を待機できます。
- 現在のページを MHTML で保存し、検証済みビューポート画像を取得し、有界 Artifact を転送し、ローカル HTTP サーバーなしで自己完結型 HTML デモを開けます。
- `dom.click.real` で Windows のネイティブ左クリックを送信できます。通常の `dom.click` とは独立した権限です。
- Key 単位でタブまたはグローバル範囲を占有できます。別の許可済み Key は、先に明示的に解放してから取得する必要があります。

正確なメソッド、schema、権限、エラーは Command Registry が正本です。`system.describe` は現在のビルドと呼び出し元 Key の実効権限を返します。

## クイックスタート

### 必要環境

- Chrome または互換 Chromium ブラウザー 138 以降
- Windows x86_64 または Linux x86_64 のコンパニオン App
- 同梱 CLI 用の Node.js 20 以降

### 1. 拡張機能と App をダウンロード

[最新の Release](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest) から 2 つの ZIP をダウンロードし、それぞれ別のディレクトリに展開します。

- 拡張機能: `browser-key-automation-extension-v0.0.0.2.zip`
- ローカル App: `browser-key-automation-local-app-v0.0.0.2.zip`

App ZIP には `windows-x86_64/`、`linux-x86_64/`、CLI、Agent skill が含まれます。ソースからのビルドは不要です。

### 2. 拡張機能を読み込む

1. 拡張機能アーカイブを完全に展開します。
2. `chrome://extensions` を開き、デベロッパーモードを有効にして **パッケージ化されていない拡張機能を読み込む** を選びます。
3. ルートに `manifest.json` が直接ある展開先ディレクトリを選びます。
4. 拡張機能の詳細で **Allow User Scripts** を有効にし、拡張機能を再読み込みします。このブラウザー管理のスイッチが必要なのは `js.execute` だけで、Key 管理、DOM、ページツリーは無効のままでも利用できます。
5. ツールバーから **Browser Key Automation** を開きます。完全に信頼する制御には Root Key、必要な権限だけに絞る場合は Regular Key を作成します。

初回インストール時だけローカル設定ページが開きます。更新や再読み込みで繰り返し開くことはありません。

### 3. コンパニオン App を起動

GitHub Release の App を展開し、現在のプラットフォーム用 relay を起動したままにします。

```text
# Windows
.\windows-x86_64\browser-key-relay.exe

# Linux
chmod +x ./linux-x86_64/browser-key-relay
./linux-x86_64/browser-key-relay
```

既定の endpoint は `127.0.0.1:32189` です。App が利用できない間、拡張機能は設定済みの公称 10 秒間隔で接続成功まで再試行します。互換 App が固定 endpoint を使用中なら、2 つ目を起動しないでください。

### 4. CLI を接続

展開したローカル App ディレクトリで実行します。

```text
node client/browser-key-cli.mjs instances
```

このコマンドに Key は不要です。0 instances は拡張機能が未接続であることを示します。複数ある場合は、現在有効な `relayEpoch/instanceNumber` を明示的に選択し、bearer Key を全 Instance に試してはいけません。

Key は argv ではなく環境変数で渡します。

```powershell
# PowerShell
$env:BKA_API_KEY = "bk1.<key-id>.<secret>"
node .\client\browser-key-cli.mjs call --method system.describe --schema-version 1 --params-json "{}"
```

```bash
# Bash
export BKA_API_KEY='bk1.<key-id>.<secret>'
node client/browser-key-cli.mjs call --method system.describe --schema-version 1 --params-json '{}'
```

CLI は Key を読む前に Instance を再列挙します。delivery が `unknown` なら本当に不明として扱い、副作用のあるコマンドを自動再試行しないでください。

## よく使うフロー

- ページ探索: `tabs.list` → `page.tree.open` → `page.tree.find` または `page.tree.expand.v2` → `page.tree.view.get`
- 同期待ち: `page.wait`。timeout 省略時は 10 秒で、条件が既に満たされていれば即時に返ります。
- ページ保存: `node client/browser-key-cli.mjs page-save --tab-ref <TabRef> --output ./page.mhtml`
- ビューポート取得: `node client/browser-key-cli.mjs page-shot --tab-ref <TabRef> --output ./page.png`
- デモを開く: `node client/browser-key-cli.mjs demo-open ./demo.html`
- 未知のコマンドを使う前に `skills/browser-key-automation/references/commands.registry.json` を確認してください。同梱 Agent skill にも同じ生成済み参照があります。

### ネイティブ `.real` クリック

`dom.click.real` は `dom.click` から独立した明示的機能です。Windows では、対象タブのアクティブ化とブラウザーウィンドウのフォーカスを Chromium に要求し、参照要素が生存・可視・有効・非遮蔽であることを検証してから、対応する Chromium コンテンツウィンドウへ 1 回のネイティブ左クリックを送るよう App に要求します。

`{ "status": "input_sent" }` は入力列が受理されたことだけを表し、Web サイトの業務処理完了を保証しません。必ず後からページを観察してください。不明または失敗したネイティブ入力を自動再送してはいけません。Linux App は現在 `native.input.click.v1` を公開しないため、ページ準備より前に `.real` が拒否されます。

## Key、権限、占有

- 外部 ID は Key だけです。Agent のブランド、プロセス、アカウント、socket、App Instance は追加の認可 ID ではありません。
- Root はすべての active 権限を動的に持ちます。Regular は明示的に選んだ権限だけを持ちます。
- JavaScript、通常 DOM 操作、ネイティブ `.real`、ネットワークアクセス、将来のデバッグ backend は並列権限です。1 つの付与が他を暗黙に付与することはありません。
- 同じ Key のコマンドは現在の拡張機能 runtime 内で直列化されます。異なる Key は独立 lane ですが、同じページへの効果は競合し得ます。
- 占有は Key が所有します。隠れた takeover、force、replace はなく、先に release、次に acquire が必要です。
- 完全な Key は拡張機能内に保存されます。信頼済み管理画面と、`keys.create` または `keys.reveal` を個別に許可された呼び出し元だけが受け取れます。通常の一覧や診断には含まれず、CLI は `BKA_API_KEY` または明示した環境変数からのみ読みます。

強力な Key はローカルブラウザー制御資格情報として扱い、信頼できる Agent や自動化にだけ渡してください。技術的な Key 権限は、支払い、投稿、メッセージ送信、アカウント変更、削除などの重要操作に対するユーザー許可の代わりにはなりません。

## ブラウザーとプラットフォームの境界

host access、制限ページ、file URL、**Allow User Scripts**、拡張機能の有効化、DevTools デバッグ確認は引き続き Chromium が管理します。Root でもこれらは回避できません。

Windows/Linux App はどちらもルーティングとファイル保存を提供します。Windows は現在のネイティブクリック backend も公開し、Linux はまだ公開しません。シークレットモードや Chromium 派生ブラウザーは、それぞれの profile と policy で検証が必要です。

Agent の接続：[Browser Key Automation skill](skills/browser-key-automation/SKILL.md)。

このプロジェクトは作者が保守します。外部からの貢献や Pull Request は受け付けていません。
