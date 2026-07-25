# お問い合わせフォームの同期

LP (`landing/`) のお問い合わせフォームは、 Google フォームをバックエンドにしています。
画面は LP 自身の HTML と CSS で描き、 送信だけを Google フォームの `formResponse`
エンドポイントへ直接 POST します。 サーバーもデータベースも持たずに、 回答の保存と
スプレッドシートへの蓄積、 メール通知、 集計が手に入ります。

設計判断の背景は
[ADR-052](../docs/architecture/adr-052-google-form-as-landing-form-backend.html)
にあります。

## なぜ同期が要るのか

送信先の質問には `entry.123456` という ID が振られていて、 この ID は Google が
採番します。 手書きできず、 フォームを編集するとズレます。 しかも送信は
`mode: "no-cors"` の POST なので応答を読めず、 ID がズレても失敗を検知できません。
つまり放置すると、 問い合わせが無音で消えます。

そこでフォーム定義を `sync.gs` に集約し、 同期のたびに ID を逆引きして
`landing/contact-form-config.json` を再生成します。 LP は実行時にこの JSON を読むため、
フォームを変更しても自動で追従します。

| ファイル | 役割 |
| --- | --- |
| `sync.gs` | フォーム定義の正本。 同期処理と Web アプリのエンドポイント |
| `appsscript.json` | Apps Script のマニフェスト。 実行権限と OAuth スコープ |
| `.clasp.json.example` | `clasp` のローカル設定の雛形。 実物は Git 管理外 |
| `../.github/workflows/form-sync.yml` | push とデプロイ、 同期、 設定の PR 作成 |
| `../landing/contact-form.js` | LP 側の設定検証と送信ペイロード組み立て |

## 初回セットアップ

### 1. Apps Script プロジェクトを用意する

対象の Google フォームに紐づくスクリプトを作り、 スクリプト ID を控えます。
ローカルから触る場合は `.clasp.json.example` をコピーして
`.clasp.json` を作り、 スクリプト ID を入れます。

```bash
cp form/.clasp.json.example form/.clasp.json
```

`clasp` の初回利用時は、 Google 側で Apps Script API を有効にしておく必要があります。

### 2. スクリプトプロパティを設定する

Apps Script エディタの「プロジェクトの設定」で、 次のプロパティを登録します。

| プロパティ | 必須 | 内容 |
| --- | --- | --- |
| `FORM_ID` | 必須 | 対象フォームの ID |
| `SYNC_TOKEN` | 必須 | CI から同期を呼ぶときの共有シークレット |
| `RESPONSE_SPREADSHEET_ID` | 任意 | 回答を溜めるスプレッドシートの ID |
| `NOTIFY_EMAILS` | 任意 | 送信通知の宛先。 カンマ区切り |

`RESPONSE_SPREADSHEET_ID` と `NOTIFY_EMAILS` は未設定でも同期は成立し、
その旨が実行結果に出ます。 黙って飛ばすことはしません。

### 3. Web アプリとしてデプロイする

`syncForm()` を CI から実行するために、 Web アプリとしてデプロイします。
アクセスは「全員」、 実行するユーザーは「自分」にします。 発行された URL
(`.../macros/s/<deploymentId>/exec`) を控えます。

`clasp run` ではなく Web アプリを選んでいるのは、 Google Cloud プロジェクトの
関連付けと API 実行可能デプロイという重い設定を避けるためです。

### 4. リポジトリシークレットを登録する

`form-sync` ワークフローは GitHub Environment `google-form` から次を読みます。

| シークレット | 内容 |
| --- | --- |
| `CLASPRC_JSON` | `~/.clasprc.json` の中身。 `clasp login` で作られる |
| `FORM_SCRIPT_ID` | Apps Script のスクリプト ID |
| `FORM_WEBAPP_URL` | Web アプリの `exec` URL |
| `FORM_SYNC_TOKEN` | `SYNC_TOKEN` と同じ値 |

## 運用

### まず dry run で計画を確かめる

既存のフォームには回答が溜まっています。 いきなり同期をかける前に、
`form-sync` ワークフローを手動実行して `dry_run` を有効にしてください。
フォームには一切触れずに、 どの質問を作成・更新・再作成するかという計画と、
現在の `entry` ID がジョブサマリーに出ます。

計画の `action` は 4 種類です。

| action | 意味 | デフォルトの扱い |
| --- | --- | --- |
| `create` | 定義にあってフォームに無い。 追加する | 実行する |
| `update` | 両方にある。 その場で更新する (`entry` ID は保たれる) | 実行する |
| `recreate` | タイトルは一致するがタイプが違う | 失敗させる |
| `orphan` | フォームにあって定義に無い。 手で足された質問 | 触らない |

`recreate` は再作成になるため `entry` ID が作り直され、 その質問の過去の回答列との
つながりも切れます。 意図した変更のときだけ `allow_type_change` を有効にしてください。

`orphan` はデフォルトでは放置します。 削除は回答列ごと失う破壊的操作なので、
消してよいと確認できたときだけ `allow_delete` を有効にしてください。

同期は最後に、 定義された質問を定義順に並べ替えます。 並べ替えは `entry` ID を
変えません。 定義に無い質問はそのまま後ろへ送られます。

### 本番の同期

`form/` 配下を変更して `main` にマージすると、 ワークフローが動きます。

1. `clasp push` でスクリプトを更新し、 同じ deployment ID へ再デプロイする
2. Web アプリ経由で `syncForm()` を実行し、 フォームを定義どおりにする
3. `entry` ID を逆引きして `landing/contact-form-config.json` を書き出す
4. 差分があれば PR を作る

PR はデフォルトでは自動マージしません。 内容を確認してからマージしてください。
完全自動で反映したい場合は、 リポジトリ変数 `FORM_SYNC_AUTO_MERGE` を `true` に
します。 マージすると Cloudflare Pages の Git 連携が LP を再配信します。

### 設定が無いあいだの LP の見え方

`landing/contact-form-config.json` が無い、 壊れている、 あるいは LP 側の入力欄と
フィールドの顔ぶれが食い違うときは、 インラインフォームを表示しません。
従来どおり Google フォームへのリンクだけが出て、 理由はブラウザのコンソールに
残ります。 送信できないフォームを見せるより安全なためです。

## 既知の落とし穴

- `curl` に `-X POST` を付けない。 Apps Script の Web アプリは 302 で GET 専用の
  応答 URL へ飛ばすため、 POST を強制するとリダイレクト先が 404 になる。
  `--data` だけを渡せば、 初回は POST、 リダイレクト後は GET になり正しく応答する
- `getDestinationType()` は回答先が未設定だと例外を投げる。 値を返さない。
  `sync.gs` では `try` で包んで未設定を判定している
- Web アプリは HTTP ステータスを選べない。 成否は本文の `ok` で判定する
- フォームが「ログイン必須」「回答は 1 人 1 回」「メールアドレスを収集する」の
  いずれかになっていると、 LP からの匿名 POST は Google 側で弾かれる。 しかも
  no-cors では弾かれたこと自体を検知できず、 送信が無音で消える。 `syncForm()` は
  同期のたびにこの 3 つを明示的に無効へ戻す。 それでも `setRequireLogin(false)` が
  失敗する場合は、 Workspace の管理コンソールで組織外からの回答が禁止されている。
  実行ログの WARN を確認する
