# Browser Key Automation

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | 日本語 | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md) | [Русский](README.ru.md)

Browser Key Automation は、信頼された Agent や自動化プログラムが Manifest V3 拡張機能と API Key を使って、許可済みのローカル Chromium ブラウザーを操作するためのシステムです。

Key 認証、権限、ブラウザー参照、占有、ブラウザー操作は拡張機能が所有します。小さな Zig コンパニオン App は、ローカルルーティング、App が割り当てるブラウザー Instance 参照、ファイル保存、明示的に公開したネイティブ機能だけを提供します。

> 開発状況: 現在の unpacked 開発ビルドは Chrome/Chromium 138 以降を対象としています。Chrome ウェブストア版ではありません。

正式アイコンの設計が終わるまで Chrome Web Store 対応は一時停止しています。[GitHub Releases](https://github.com/BIOcanse/Browser-Key-Automation/releases) を使用してください。各 Release のダウンロードは `browser-key-automation-extension-v0.0.0.1.zip` と `browser-key-automation-local-app-v0.0.0.1.zip` の 2 つだけです。詳細は [GitHub Release 配布契約](docs/implementation/github-release-delivery.md)を参照してください。

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

## アーキテクチャ

```text
Agent / 自動化
        |
        | BKA_API_KEY + command
        v
Windows / Linux Zig コンパニオン App
        |
        | ローカル loopback route + App 割り当て InstanceRef
        v
MV3 offscreen transport
        |
        v
拡張機能 service worker
        |
        +-- Key 認証と権限
        +-- 占有と実行時参照
        +-- タブ、ページツリー、DOM、JavaScript、Artifact
        `-- オプションのプラットフォーム機能要求
```

業務状態の唯一の所有者は拡張機能です。コンパニオン App は Key データベースを保持せず、ブラウザー権限も決定しません。接続に成功した拡張機能ごとに App が Instance 参照を割り当てます。拡張機能自身が番号を生成・永続化することはありません。

主経路は通常の拡張機能権限を使用します。CDP/DevTools は並列のオプション機能として追加できますが、Chromium 自身のデバッグ確認を本プロジェクトが取り除くことはできません。

## クイックスタート

### 必要環境

- Chrome または互換 Chromium ブラウザー 138 以降
- Windows x86_64 または Linux x86_64 のコンパニオン App
- 同梱 CLI 用の Node.js 20 以降
- ソースから App をビルドする場合のみ Zig

### 1. 分割パッケージをビルド

```text
npm ci
npm run build:dev-package
```

3 つの独立したアーカイブが生成されます。

- `out/browser-key-automation-extension-dev.zip`
- `out/browser-key-automation-local-app-windows-x86_64-dev.zip`
- `out/browser-key-automation-local-app-linux-x86_64-dev.zip`

拡張機能とローカル App は意図的に別配布です。各アーカイブに `START-HERE.md` と `SHA256SUMS.txt` が含まれます。

`npm run build:github-release` は、検証済み中間パッケージを GitHub 用の 2 資産に集約します。拡張機能 ZIP が 1 つ、そして `windows-x86_64/` と `linux-x86_64/` の relay および共通 CLI・protocol・Agent skill を 1 部だけ含む App ZIP が 1 つです。

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

プラットフォーム別の `-dev` App 中間パッケージでは relay がアーカイブのルートにあります。その場合は同梱の `START-HERE.md` に従ってください。

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

## 開発

| コマンド | 目的 |
|---|---|
| `npm run generate` | command、UI、transport、capability、Freedom Point の投影を生成 |
| `npm run check:extension` | 再生成して全拡張機能 realm を型チェック |
| `npm run build` | 拡張機能と現在プラットフォームの Zig App をビルド |
| `npm run test:unit` | UI、Key、runtime、WebSocket、Zig の単体テスト |
| `npm run test:runtime` | 単体テストと分離 relay/Chromium 統合テスト |
| `npm run build:dev-package` | 拡張機能と両プラットフォーム App をパッケージ化 |
| `npm run build:github-release` | GitHub Releases で公開する正確な 2 つの ZIP を構築 |
| `npm run build:chrome-web-store:first-upload` | 一時停止中の ID 初期化成果物を構築。アイコン作業再開前はアップロードしない |
| `npm run test:dev-package-smoke` | アーカイブ階層、実行ファイル、ハッシュ、skill 参照を検証 |

分離統合テストは一時 port、profile、relay を使います。個人ブラウザー profile や既存の個人 App Instance に向けてはいけません。

## ドキュメント

- [ドキュメント索引](docs/README.md)
- [現在の決定](docs/decisions.md)
- [進捗と検証状況](docs/PROGRESS.md)
- [コマンド契約](docs/contracts/commands.md)
- [ページ操作ツリー](docs/design/page-information-tree.md)
- [Freedom Points](docs/design/freedom-points.md)
- [配布構造](docs/design/delivery-layout.md)
- [Agent skill](skills/browser-key-automation/SKILL.md)

旧 Cleaner/PageIR 案は `docs/historical/` にだけ保存され、現在の製品動作ではありません。
