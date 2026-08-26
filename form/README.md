# お問い合わせフォームの同期

> **削除済み:** このドキュメントが説明する自動化 (`.github/workflows/form-sync.yml`) は
> 削除されました。 push トリガーの dry run、 `make form-setup` 最後の dry run 起動、
> および下記「実同期の手順」の `gh workflow run form-sync ...` は現状すべて動きません。
> Apps Script のデプロイと `landing/contact-form-config.json` の再生成が必要な場合は、
> `form/sync.gs` のコメントにある手動手順 (`clasp push` -> `curl` で Web アプリを叩く) で
> 代替してください。 自動化を復活させる場合は、 本ドキュメントと `scripts/form/setup-run.ts`
> も合わせて更新します。

LP (`landing/`) のお問い合わせフォームは、 Google フォームをバックエンドにしています。
画面は LP 自身の HTML と CSS で描き、 送信だけを Google フォームの `formResponse`
エンドポイントへ直接 POST します。 サーバーもデータベースも持たずに、 回答の保存と
スプレッドシートへの蓄積、 メール通知、 集計が手に入ります。

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
| `../.github/workflows/form-sync.yml` | (削除済み) push とデプロイ、 同期、 設定の PR 作成を自動化していた workflow |
| `../landing/contact-form.js` | LP 側の設定検証と送信ペイロード組み立て |

## 質問の同一性はタイトルではなくアイテム ID

同期はスクリプトプロパティ `ITEM_IDS` に `key` とアイテム ID の対応表を持ちます。
これは同期が自動で書くので、 人が触る必要はありません。

対応表が無い状態 (= 既存フォームへの初回適用) でだけタイトルで突き合わせ、 一度
ID を記録した後はタイトルを変えても同じ質問を追い続けます。 タイトルを同一性に
すると、 文言を直しただけで質問が作り直されて `entry` ID が変わり、 送信が無音で
消えます。

## 初回セットアップ

新規に立ち上げる場合は `make form-setup` がここから下の作業をまとめて行います。
既存フォームをコード管理下に置く場合だけ、 先に「0. 既存フォームに適用するのか」を
読んでください。

```bash
make form-setup
```

このスクリプトが行うこと。

1. `clasp` と `gh` の存在と認証を確認する
2. 未ログインなら `clasp login` を促す (ブラウザでの Google 認可)
3. `form/.clasp.json` が無ければ Apps Script プロジェクトを作る (あれば再利用)
4. `clasp push` と Web アプリのデプロイを行い、 `exec` URL を組み立てる
5. Apps Script エディタで `bootstrap` を 1 回実行するよう促し、 その出力を受け取る
6. GitHub Environment `google-form` を作り、 4 つの secrets を書き込む
7. リポジトリ変数 `FORM_SYNC_ENABLED` を `true` にする
8. 初回の dry run (`form-sync`) を起動する

何度実行しても壊れません。 既存のスクリプト ID と `SYNC_TOKEN` は再利用し、
secrets は上書きされます。 `--repo owner/name` でリポジトリを、
`--environment <name>` で Environment を変えられます。 `--skip-workflow` を付けると
最後の dry run を起動しません。

人手が残るのは 2 か所だけで、 どちらも Google の認可が要るため自動化できません。

- `clasp login` のブラウザ認可
- エディタでの `bootstrap` の実行。 フォーム本体・回答スプレッドシート・
  `SYNC_TOKEN` はこの 1 回で作られる

`bootstrap` はスクリプトプロパティを書くため Google の認可が要り、 それを CI から
行うには GCP プロジェクトの関連付けと API 実行可能デプロイが必要になります。
`syncForm` を Web アプリ経由にしているのと同じ理由で、 そこは避けています。

`bootstrap` も冪等です。 特に `SYNC_TOKEN` は既にあれば作り直しません。 作り直すと
GitHub 側の secret と食い違い、 以後の同期がすべて認証エラーになります。

スクリプトは受け取った `formResponseUrl` を、 LP が実行時に使う検証器
(`landing/contact-form.js` の `parseConfig`) にそのまま通します。 組織ドメイン付きの
URL (`docs.google.com/a/<domain>/forms/...`) はここで弾かれるので、 secrets を書く前に
気づけます。

### 手作業で行う場合

### 0. 既存フォームに適用するのか、 新規に作るのかを決める

既存の Google フォームは GUI で作られており、 質問のタイトルが `sync.gs` の
`FORM_DEFINITION` と一致しているとは限りません。 一致しない場合、 初回の計画は
「定義側は全部 `create`、 既存の質問は全部 `orphan`」になります。 つまり既存
フォームをコード管理下に置くのではなく、 既存の質問の隣に別の質問セットを生やす
動きです。 回答スプレッドシートの列も分かれます。

先に dry run で現状を確認し、 どちらかを選んでください。

- **既存フォームに合わせる**: 実際の質問タイトルを見て `FORM_DEFINITION` の
  `title` をそれに書き換える。 既存の回答列が継続する。
- **新しいフォームを作る**: 新規フォームを作って `FORM_ID` に据え、 LP のリンクも
  そちらへ差し替える。 過去の回答は旧フォームに残す。

### 1. Apps Script プロジェクトを用意する

対象の Google フォームに紐づくスクリプトを作り、 スクリプト ID を控えます。
ローカルから触る場合は `.clasp.json.example` をコピーして
`.clasp.json` を作り、 スクリプト ID を入れます。

```bash
cp form/.clasp.json.example form/.clasp.json
```

`clasp` の初回利用時は、 Google 側で Apps Script API を有効にしておく必要があります。
CI は `@google/clasp` の 2.x に固定しているため、 `CLASPRC_JSON` も 2.x の
`clasp login` が作ったものを使ってください。 3.x は認証情報の形式が異なります。

### 2. スクリプトプロパティを設定する

Apps Script エディタの「プロジェクトの設定」で、 次のプロパティを登録します。

| プロパティ | 必須 | 内容 |
| --- | --- | --- |
| `FORM_ID` | 必須 | 対象フォームの ID |
| `SYNC_TOKEN` | 必須 | CI から同期を呼ぶときの共有シークレット |
| `RESPONSE_SPREADSHEET_ID` | 任意 | 回答を溜めるスプレッドシートの ID |
| `NOTIFY_EMAILS` | 任意 | 送信通知の宛先。 カンマ区切り |
| `ITEM_IDS` | 自動 | key とアイテム ID の対応表。 同期が書く |

`RESPONSE_SPREADSHEET_ID` と `NOTIFY_EMAILS` は未設定でも同期は成立し、
その旨が実行結果に出ます。 黙って飛ばすことはしません。

### 3. Web アプリとしてデプロイする

`syncForm()` を CI から実行するために、 Web アプリとしてデプロイします。
アクセスは「全員」、 実行するユーザーは「自分」にします。 発行された URL
(`.../macros/s/<deploymentId>/exec`) を控えます。

`clasp run` ではなく Web アプリを選んでいるのは、 Google Cloud プロジェクトの
関連付けと API 実行可能デプロイという重い設定を避けるためです。 その代わり
エンドポイントは匿名アクセス可能なので、 `SYNC_TOKEN` が唯一の防御です。
漏れた場合はプロパティを差し替えて再デプロイしてください。

### 4. リポジトリシークレットを登録する

`form-sync` ワークフローは GitHub Environment `google-form` から次を読みます。
どれかが欠けていると、 認証エラーではなく「何が足りないか」を名指しして止まります。

| シークレット | 内容 |
| --- | --- |
| `CLASPRC_JSON` | `~/.clasprc.json` の中身。 `clasp login` (2.x) で作られる |
| `FORM_SCRIPT_ID` | Apps Script のスクリプト ID |
| `FORM_WEBAPP_URL` | Web アプリの `exec` URL |
| `FORM_SYNC_TOKEN` | `SYNC_TOKEN` と同じ値 |

Environment に必須レビュアーを設定しておくと、 実同期の前に人の承認が挟まります。

## 運用

### push は必ず dry run

`form/` を変更して `main` にマージしたときの実行は、 **常に dry run** です。
フォームは変更されず、 計画と現在の `entry` ID だけがジョブサマリーに出ます。

実際にフォームを変更するのは、 `workflow_dispatch` で手動実行して `dry_run` の
チェックを外したときだけです。 `workflow_dispatch` はデフォルトブランチに存在する
ワークフローしか起動できないため、 このデフォルトが無いと、 ワークフローを追加した PR の
マージ自体が初回の本番同期になってしまいます。

さらに、 Google 側の準備が済むまでは push 実行そのものを止めています。 準備が
できたらリポジトリ変数 `FORM_SYNC_ENABLED` を `true` にしてください。 手動実行は
この変数に関係なく可能なので、 初回の dry run はいつでも打てます。

### 計画の読み方

| action | 意味 | デフォルトの扱い |
| --- | --- | --- |
| `create` | 定義にあってフォームに無い。 追加する | 実行する |
| `update` | 両方にある。 その場で更新する (`entry` ID は保たれる) | 実行する |
| `recreate` | 同じ質問だがタイプが違う | 実同期を止める |
| `orphan` | フォームにあって定義に無い。 手で足された質問 | 触らない |

サマリーには、 実同期を止める要因 (blocker) も出ます。

| blocker | なぜ止めるか | 解除方法 |
| --- | --- | --- |
| `type-change` | 作り直しになり `entry` ID が変わる。 過去の回答列との対応も切れる | `allow_type_change` |
| `required-orphan` | 定義に無い**必須**の質問が残っていると、 LP はその回答を送らないので Google が送信を丸ごと拒否する。 no-cors では拒否が見えず、 問い合わせが全滅する | `allow_delete` で消すか、 フォーム側で任意に変更する |
| `duplicate-title` | フォーム側にタイトルが重複した質問がある。 計画の読みが信用できない | 手で解消する |

`orphan` の削除は回答列ごと失う破壊的操作です。 消してよいと確認できたときだけ
`allow_delete` を有効にしてください。

同期は最後に、 定義された質問を定義順に並べ替えます。 並べ替えは `entry` ID を
変えません。 定義に無い質問はそのまま後ろへ送られます。

### 実同期の手順

1. `form-sync` を手動実行する (`dry_run` はデフォルトで有効)
2. ジョブサマリーで計画と blocker を確認する
3. blocker があれば定義かフォームを直し、 1 に戻る
4. `dry_run` を外して手動実行する。 フォームが定義どおりになる
5. `entry` ID を再取得した PR が作られるので、 内容を確認してマージする

PR はデフォルトでは自動マージしません。 なお、 この PR は `GITHUB_TOKEN` で作られる
ため CI が起動しません。 差分 (`entry` ID) を目視で確認してからマージしてください。
完全自動にしたい場合はリポジトリ変数 `FORM_SYNC_AUTO_MERGE` を `true` にしますが、
必須チェックがある場合は PAT / GitHub App token への差し替えが要ります。

マージすると Cloudflare Pages の Git 連携が LP を再配信します。

### 設定が無いあいだの LP の見え方

`landing/contact-form-config.json` が無い、 壊れている、 あるいは LP 側の入力欄と
設定が食い違うときは、 インラインフォームを表示しません。 従来どおり Google
フォームへのリンクだけが出て、 理由はブラウザのコンソールに残ります。 送信できない
フォームを見せるより安全なためです。

食い違いは項目の顔ぶれだけでなく、 入力欄の種類と選択肢まで見ています。
`sync.gs` の選択肢を 1 つ改名して LP を直し忘れると、 LP は古い文字列を送り続ける
ことになるので、 その場合もフォームを出しません。

## 既知の落とし穴

- `curl` に `-X POST` を付けない。 Apps Script の Web アプリは 302 で GET 専用の
  応答 URL へ飛ばすため、 POST を強制するとリダイレクト先が 404 になる。
  `--data` だけを渡せば、 初回は POST、 リダイレクト後は GET になり正しく応答する
- `getDestinationType()` は回答先が未設定だと例外を投げる。 値を返さない。
  `sync.gs` では `getDestinationId()` まで含めて `try` で包んでいる
- Web アプリは HTTP ステータスを選べない。 成否は本文の `ok` で判定する
- フォームが「ログイン必須」「回答は 1 人 1 回」「メールアドレスを収集する」の
  いずれかになっていると、 LP からの匿名 POST は Google 側で弾かれる。 しかも
  no-cors では弾かれたこと自体を検知できず、 送信が無音で消える。 `syncForm()` は
  同期のたびにこの 3 つを明示的に無効へ戻したうえで、 **設定し直した結果を読み戻して
  確認する**。 3 つのどれかが無効になっていない (または読み出せない) ときは同期を
  中止し、 何が満たせなかったかを本文の `error` に書く。 設定関数の例外だけでは
  判断しない。 個人アカウントでは `setRequireLogin(false)` が例外を返しつつ実際には
  ログイン不要、 ということがあるため、 判断材料は結果の状態だけにしている。
  中止された場合は Workspace の管理コンソールで組織外からの回答が禁止されていないか、
  フォームの設定画面でこの 3 つが無効かを確認する
- 読み出し側の関数名は設定側と揃っていない。 `setLimitOneResponsePerUser()` に対する
  読み出しは `hasLimitOneResponsePerUser()` で、 `getLimitOneResponsePerUser()` は
  存在しない。 fail closed の設計上、 名前を間違えると例外になり、 あらゆる同期が
  止まる

## 一度は人が確かめること

`sync.gs` は Google のランタイム内でしか動かず、 オフラインでテストできません。
LP 側のロジックはテストで固定していますが、 次の 2 点は実物でしか確認できません。
初回の実同期のあとに一度だけ通してください。

1. LP のフォームから送信し、 回答スプレッドシートに行が増えること
2. 通知メールが届くこと

公開 URL の形 (`docs.google.com/forms/d/e/...`) は `make form-setup` が
`bootstrap` の出力を LP の検証器へ通して確認するため、 目視の対象から外れています。
手作業でセットアップした場合だけ、 組織ドメイン付きの URL になっていないかを
確かめてください。
