# PR Tab Grouper

GitHub で Pull Request を出すと、その PR タブを自動で Chrome のタブグループにまとめる拡張機能です。
Dia Browser のタブ自動グループ化を、GitHub の PR に絞って Chrome で再現したものです。

## できること

- **自分の PR ページを開いたら自動でグループ化** — `gh pr create` で作って URL を開いた場合でも、Web UI から作った場合でも動く
- **PR を作った瞬間に、開いている自分の PR タブも集める** — compare ページから PR を作ると、同じウィンドウの自分の PR タブをまとめてそのグループへ寄せる
- **自分の PR だけを対象にする** — レビュー中の他人の PR は巻き込まない（設定で全 PR を対象にもできる）
- **まとめ方を選べる** — 「My PRs」1 グループに集約 / リポジトリごとにグループを分ける
- **手動でまとめる** — ツールバーアイコン → 「開いている PR タブを今すぐまとめる」／「このタブをグループに入れる」
- **自分のオープン PR を全部開く** — GitHub 上の自分の open PR を取得して、未オープンのものを開いてグループ化
- **バックグラウンドで自分の PR を定期取得** — 1 分ごとに一覧を取得して、件数バッジ・状態通知・PR 判定に使う
- **ブラウザでサインイン** — トークンを手で貼らずに、GitHub の画面で承認するだけで接続できる（Device Flow）

## インストール

ビルド不要です。

1. `chrome://extensions` を開く
2. 右上の「デベロッパーモード」を ON
3. 「パッケージ化されていない拡張機能を読み込む」でこのディレクトリを選択

Chrome 111 以上が必要です（`chrome.tabGroups` / `chrome.storage.session` / `scripting` の `world: "MAIN"`）。

**コードを更新したら `chrome://extensions` でこの拡張のリロードボタンを押してください。** service worker
は再読み込みしないと古いコードのまま動きます。開いている GitHub のタブには、リロード時に新しい
content script を自動で入れ直すので、タブを 1 枚ずつ再読み込みする必要はありません。

## 使い方

インストール後は放置で動きます。自分の PR ページを開くと `My PRs` という紫のタブグループができて、
そこに PR タブが入ります。

ツールバーのアイコンをクリックすると設定と手動実行ができます。

| 設定 | 既定値 | 説明 |
| --- | --- | --- |
| 自動グループ化 | ON | 自動でのグループ化をまとめて停止できる |
| 自分の ID | `yuyakinjo` | GitHub のログイン名。**これが判定の基準**。空にするとページの `meta[name="user-login"]` から推定する |
| まとめ方 | 1 つのグループに集約 | `repo` にするとリポジトリ (`owner/repo`) ごとにグループを分ける |
| グループ名 | `My PRs` | 集約モードでのグループ名 |
| 色 | パープル | 新規グループの色 |
| 自分が作者の PR だけまとめる | ON | OFF にすると開いた PR すべてが対象 |
| PR 作成時に、開いている自分の PR タブも集める | ON | PR を作った瞬間だけ他のタブも寄せる |
| グループを折りたたんだ状態で作る | OFF | 新規グループを畳んだ状態で作る |

「バックグラウンド取得」を開くと定期取得の設定があります。

| 設定 | 既定値 | 説明 |
| --- | --- | --- |
| バックグラウンドで定期取得する | ON | GitHub と未接続のときは自動的に停止します |
| 取得間隔 | 1 分 | 1〜60 分。`chrome.alarms` の下限が 1 分 |
| アイコンにオープン PR 件数を出す | ON | 要対応（要修正 / CI 失敗 / コンフリクト）があると赤くなる |
| レビュー・CI の状態が変わったら通知する | ON | 変化したときだけ。初回取得では通知しない |
| 取得のたびにタブをまとめ直す | OFF | ON にすると 1 分ごとに `gather` 相当を実行する |

### グループ化されないとき

ポップアップの「判定結果を見る」を開くと、そのタブについて **作者を誰だと判定したか / 自分の ID を何だと
思っているか / どこから取得したか** が表示されます。だいたいここで原因が分かります。

- 作者が「取得できませんでした」→ タブのタイトルがまだ確定していない可能性。ページを再読み込みする
- 自分の ID が違う → 「自分の ID」欄を直す
- 判定は合っているのにグループに入らない → 拡張機能をリロードしていない可能性

## GitHub と接続する

定期取得・PR 一覧・「自分のオープン PR を全部開く」には GitHub の認証が必要です。
自動グループ化だけなら接続しなくても動きます。

方法は 2 つあり、**ブラウザ認証のほうが推奨**です。

### ブラウザ認証（Device Flow・推奨）

ポップアップ →「GitHub アカウント」→「GitHub で接続する」→ GitHub の画面で承認、で完了します。
トークンをコピペする必要はありません。

8 桁の確認コードは**拡張機能が入力欄に流し込みます**。GitHub の承認ページは入力欄が 1 文字ずつ
8 個に分かれていて `?user_code=` を付けても埋まらないため、タブを開いたあとに
`chrome.scripting.executeScript` で入力しています（`world: "MAIN"` を先に試し、駄目なら
`ISOLATED`）。UI が変わって自動入力が効かなくなった場合も、**コードはクリップボードに
コピー済み**なので ⌘V で貼れます。

初回だけ **OAuth App の Client ID** が要ります（1 分で作れます）。

1. [github.com/settings/applications/new](https://github.com/settings/applications/new) で OAuth App を作る
   （名前・URL は何でもよい。Device Flow ではコールバック URL を使いません）
2. 作成後の画面で **Enable Device Flow** にチェックして Update application
3. 表示された **Client ID** を接続画面に貼る

> **なぜ Client ID が要るのか** — 通常の OAuth（認可コードフロー）はトークン交換に
> `client_secret` が必要ですが、拡張機能はコードを配る以上 secret を隠せません。
> Device Flow は secret を使わない前提の方式（`gh` CLI と同じ）なので、サーバーを持たずに
> 完結できます。Client ID は公開してよい値です。
>
> 拡張機能に共通の Client ID を同梱していないのは、それが「作者の OAuth App 経由で
> 全ユーザーが認可する」形になるためです。自分の App を使えば、認可の記録も取り消しも
> 自分の手元に残ります。

接続を取り消すときは、ポップアップの「接続を解除する」（拡張機能側のトークンを消す）と、
[GitHub の Authorized OAuth Apps](https://github.com/settings/applications)（GitHub 側の認可を取り消す）
の両方を行ってください。

### Personal Access Token

手貼りしたい場合はこちら。「GitHub アカウント」→「かわりに Personal Access Token を貼る」。

- classic token なら `repo` スコープ
- fine-grained token なら対象リポジトリの **Pull requests: Read**

### トークンの保存場所

どちらの方法でも、トークンは `chrome.storage.local` に**平文で**保存されます。
これは拡張機能の制約で、Chrome には拡張機能向けの暗号化ストレージがありません。
気になる場合は `public_repo` スコープで接続するか、接続せずに使ってください。

## 仕組み

「その PR が自分のものか」= **PR の作者 === 自分の ID** の判定です。作者の取得は確実な順に試します。

0. **定期取得した自分の PR 一覧**（GitHub と接続しているとき）
   GitHub 自身が「これはあなたの PR です」と答えたものなので最も確実です。一覧に載っている PR は
   タイトルも DOM も読まずに自分の PR と確定します。
1. **タブのタイトル**（未接続のときの主経路）
   GitHub の PR ページのタイトルは
   `<PR タイトル> by <ログイン名> · Pull Request #<番号> · <owner>/<repo>`
   という形式なので、ここからログイン名を取り出します。`chrome.tabs` の `tab.title` で読めるため
   **DOM にも content script にも依存せず**、GitHub のリニューアルに強いのが利点です。
   タイトル中の `#<番号>` が URL の PR 番号と一致するかまで確認しているので、PR タイトルに
   紛らわしい文字列が入っていても誤判定しません。
2. **ページの DOM** — content script が読み取ります。作者リンクのテキストは
   `表示名 (ログイン名)` という形式なので、テキストではなく `href` / `data-hovercard-url` から
   ログイン名を取ります。セレクタは [src/lib/extract.js](src/lib/extract.js) に集約。
3. **キャッシュ** — 一度判定した PR は `chrome.storage.local` に覚えます（最大 300 件）
4. **ページへの再注入** — 拡張機能のインストール前から開いていたタブには content script が
   入っていないので、「今すぐまとめる」時だけ `chrome.scripting.executeScript` で読み取ります
5. **REST API 単発** — 接続時、1〜4 がすべて失敗したときだけ

これとは別に、**compare ページ → PR ページの遷移**を `chrome.tabs.onUpdated` で見ています。
これが取れたときは「たった今自分が PR を作った」以外ありえないので、作者が読めなくても自分の PR と
断定し、同時に他の PR タブも集めます。

> 補足: 当初は `.gh-header-meta a.author` などの旧セレクタを使っていましたが、現行の GitHub は
> PR ページが React 化されていてこれらの要素は存在しません。そのため DOM に依存しない
> タイトル経路を主にしています。

### バックグラウンド取得

GitHub と接続すると、自分のオープン PR を定期的に取得します。

```
chrome.alarms (既定 1 分)
  -> GraphQL で viewer.pullRequests(states: OPEN) を 1 リクエスト
     -> prIndex に保存（ポップアップの一覧）
     -> prCache に mine:true を書く（グループ化の判定が確定する）
     -> バッジ更新（件数 / 要対応があれば赤）
     -> 前回との差分だけ通知
```

- **なぜ `setInterval` ではないのか** — MV3 の service worker は常駐せず、数十秒アイドルだと停止します。
  `setInterval` はそこで消えるので、service worker を起こしてくれる `chrome.alarms` を使います。
- **なぜ GraphQL なのか** — レビュー状況・CI・コンフリクトまで **1 リクエスト**で取れるためです。
  REST の検索 API だと一覧しか取れず、状態を知るには PR ごとに追加リクエストが要ります。
  GraphQL が通らないトークン（SSO 未認可など）のときは自動的に REST 検索へフォールバックします
  （この場合は一覧だけで、状態のラベルと通知は出ません）。
- **API 上限** — GraphQL は 5,000 ポイント/時。1 分間隔なら 60 リクエスト/時なので十分余裕があります。
- **通知が出る条件** — 前回との差分のみです。`承認された` / `修正がリクエストされた` / `CI が失敗した` /
  `コンフリクトした` / `クローズ・マージされた`。初回取得と、新しく現れた PR（＝自分が作った直後）では
  通知しません。同じ失敗が続いている間も再通知しません。

## ファイル構成

```
manifest.json
src/
  background.js        service worker。判定・グループ操作・PR 作成の検知
  content.js           github.com 上での PR ページ検知（SPA 遷移にも追従）
  popup.html/.js/.css  設定 UI・手動実行・PR 一覧・判定結果の表示
  auth.html/.js/.css   サインイン画面（独立したタブで開く）。確認コードの自動入力もここ
  lib/
    api.js             GitHub API（GraphQL / REST）
    auth.js            Device Flow によるサインイン
    cache.js           PR ごとの判定結果キャッシュ
    extract.js         DOM からの作者名抽出（content script と executeScript の共通コード）
    github.js          URL / タイトルのパース
    settings.js        設定の既定値と読み書き
    sync.js            定期取得・バッジ・通知
tools/make-icons.mjs   アイコン生成（依存なし・`node tools/make-icons.mjs`）
icons/                 生成済み PNG
```

## 制限事項

- **github.com のみ**。GitHub Enterprise Server は未対応（`manifest.json` の `host_permissions` と
  `src/lib/github.js` の `GITHUB_HOST` にホストを足せば対応できます）
- タブグループは**ウィンドウ単位**なので、別ウィンドウの PR タブは別グループになります
- ピン留めタブと**シークレットウィンドウは対象外**
- タイトル経路は GitHub のタイトル書式（英語の `by ... · Pull Request #N`）に依存します
- 取得間隔の下限は 1 分です（`chrome.alarms` の仕様。これより短くはできません）
- 定期取得はトークンが見える範囲の PR だけが対象です。権限のない private リポジトリの PR は出てきません
- ブラウザ認証には OAuth App の Client ID が 1 つ必要です（`client_secret` は不要）
- OAuth App の **Expire user access tokens** を有効にすると 8 時間でトークンが失効します。
  `refresh_token` にはまだ対応していないので、無効のまま作成してください
- 確認コードの自動入力は GitHub の DOM に依存します（失敗してもクリップボードから貼れます）
- GitHub の OAuth スコープは読み取り専用の `repo` を提供していないため、private を含めると
  書き込み権限も一緒に付きます。避けたい場合は `public_repo` か、fine-grained PAT を使ってください

## 開発

ビルドステップはありません。コードを直して `chrome://extensions` でリロードするだけです。

```sh
node tools/make-icons.mjs   # アイコンの再生成
```
