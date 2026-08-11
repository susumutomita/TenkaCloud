# TenkaCloud — 競技者向け事前セットアップ

このディレクトリは、TenkaCloud から問題を deploy される側 (= 競技者) の AWS アカウントで
事前に 1 回だけ流す CloudFormation テンプレートを置く。

## `competitor-bootstrap.yaml`

### これは何か

TenkaCloud の Deploy Lambda が、競技者 AWS アカウントへ問題 CFn (`problems/<id>/template.yaml`) を
deploy するために使う **IAM Role** を作るテンプレート。
trust policy は TenkaCloud control-plane アカウント ID + ExternalId に限定し、
それ以外の主体からの AssumeRole を拒否する。

### セットアップ手順

#### 1. TenkaCloud 運営者から以下を受け取る

- **TenkaCloudAccountId**: TenkaCloud の control-plane が動く AWS アカウント ID (12 桁)
- **ExternalId**: テナント固有の External ID (16 文字以上の secret)

#### 2. 競技者 AWS アカウントでテンプレートを deploy

CLI で実行する場合は次の通りです。

```bash
aws cloudformation deploy \
  --template-file infrastructure/templates/competitor-bootstrap.yaml \
  --stack-name tenkacloud-competitor-bootstrap \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
      TenkaCloudAccountId=123456789012 \
      ExternalId=share-this-secret-with-tenkacloud
```

Console から流す場合は CFn →「スタックの作成」→ テンプレート yaml を upload →
パラメータ入力 →「IAM 権限変更を承認」にチェックして実行します。

#### 3. 出力された RoleArn を TenkaCloud 運営者に共有

deploy 完了後、CFn Outputs に表示される `RoleArn` を TenkaCloud 運営者に伝える。
TenkaCloud 側はこの ARN と ExternalId を用いて AssumeRole し、問題 CFn を本アカウントへ
展開できるようになる。

### 付与される権限

作成される Role には AWS managed policy **`AdministratorAccess`** を付与します。

これは意図的な設計判断です (Issue #721)。以前はサービスごとにスコープを絞った
least-privilege ポリシーを使っていましたが、新しい問題テンプレートを追加するたびに
必要な権限 (hello-world Challenge の `ssm:PutParameter` / microservice-migration-battle
の `scheduler:*` など) が足りず `CREATE_FAILED` → `ROLLBACK_COMPLETE` になる
「権限のもぐらたたき」が常態化していました。競技者はこの bootstrap を deploy する
時点で TenkaCloud が自アカウント内で操作することに同意しており、trust はすでに
下表の多層防御 (defense-in-depth) で絞られているため、`AdministratorAccess` に
切り替えて IAM のもぐらたたきを解消し、新しい問題テンプレートが bootstrap を
再発行させずに deploy できるようにしています。

| 層                          | 内容                                                          |
| ---------------------------- | -------------------------------------------------------------- |
| Trust policy                 | TenkaCloud アカウント ID + ExternalId の 2 要素に限定           |
| ConsoleViewerRole (運営側)   | `tc-*` スコープのみ (PR #710)                                   |
| MaxSessionDuration           | 1 時間 (3600 秒)                                                |
| 撤回                         | 競技者がこの stack を削除すれば AssumeRole は即時に拒否される  |

### 撤回 / クリーンアップ

このスタックを削除すると Role も消える ⇒ TenkaCloud からの AssumeRole が即時に拒否される。

#### 競技後の片付け (推奨)

競技を終えたら、 必ず stack を削除してください。 残したままにすると TenkaCloud
運営側が AssumeRole 可能な状態が継続します (= 攻撃面 + コスト両面でクリーンに
保つため)。

##### 方法 A: CLI で 1 行削除 (推奨)

```bash
aws cloudformation delete-stack --stack-name tenkacloud-competitor-bootstrap
# 削除完了を待つ場合 (option):
aws cloudformation wait stack-delete-complete --stack-name tenkacloud-competitor-bootstrap
```

##### 方法 B: AWS Console から削除

1. AWS Console > CloudFormation > スタック一覧
2. `tenkacloud-competitor-bootstrap` を選択
3. 「削除」→「スタックの削除」を確認

Console / CLI どちらの経路でも結果は同じ (= IAM Role が即時消える)。 Issue #840 は
Participant Portal 側に「環境を片付ける」button を追加して同操作を 1-click 化する
予定ですが、 現状は上記いずれかを競技者ご自身で実行してください。

#### 即時撤回 (競技中の trust 取り消し)

万が一 External ID が漏れた場合などは、 競技中でも上記コマンドで stack を削除して
trust を即時撤回できます。 削除後はあらためて生成した External ID で再 deploy
すれば trust が復旧します。

### セキュリティ上の前提

- **External ID は secret として扱う**。Confused Deputy 攻撃を防ぐため、TenkaCloud 運営者と
  競技者だけが知っている値である必要がある。
- TenkaCloud の Deploy Lambda は CloudTrail に AssumeRole 履歴を残す。競技者は自身の
  CloudTrail でその AssumeRole / 後続の CFn / EC2 操作を監査できる。
- スタック削除で権限を即時撤回できるので、競技終了後はスタックを消すと安全。

## CloudFormation console Lite mode deployment pipeline

### 概要

`lite-pipeline.yaml` は、手元に Bun / CDK を入れずに Lite mode を deploy するための単一
CloudFormation テンプレートです。テンプレート自体は TenkaCloud 本体を作らず、**CodeBuild
プロジェクトを 1 つ**作ります。スタック作成後に「Start build」を押すと、CodeBuild が public
な TenkaCloud repo と問題カタログ repo を `git clone` し、`make deploy` で Lite mode stack を
作ります。`infrastructure/environments/<env>/.env` はビルド中に `TenantAdminEmail` から
自動生成されます。

TenkaCloud は public OSS なので **GitHub connection は不要**（CodeBuild が直接 clone する）。
CodePipeline も使いません。問題カタログは Git submodule ではなく `ProblemsRepoUrl`
パラメータで選ぶので、第三者は自分のカタログ repo を指定して deploy できます。

> CloudFormation の `templateURL` は Amazon S3 URL のみ対応です。GitHub raw URL を直接渡す
> Launch Stack ボタンは `TemplateURL must be a supported URL` になるため、README では
> **Upload a template file** 手順を正式手順にしています。

#### Deploy リンク: バッジを配布しないという記録された意思決定

Issue #2760 は CloudFormation Quick Create URL / Deploy to AWS badge の追加を求めていたが、
上記の制約（`templateURL` は Amazon S3 URL のみ）により、GitHub でホストする OSS リポジトリ
からバッジ 1 つで launcher stack 作成まで進める経路は存在しない。検討した配布先は次の 3 つ。

1. **Amazon S3 に公開ミラーを置く**（Quick Create URL が使えるようになる）— 運営側が管理する
   公開 S3 バケットを常設する必要があり、ベンダーホスト型 SaaS ではない自己ホスト OSS
   プロジェクトの運用モデルに合わない。
2. **CloudFront 経由で配布する** — 同様に常設のホスティングインフラが要る。
3. **リポジトリのファイルをそのまま参照する**（現状の選択）— README からリポジトリ内の
   `lite-pipeline.yaml` へ直接リンクし、閲覧している ref のテンプレートをそのままダウンロード
   してもらう。追加のホスティングインフラも公開パイプラインも不要で、テンプレートは常に
   その ref のコードと一致する。

本プロジェクトは選択肢 3 を採用し、Quick Create バッジは提供しない。README の手順 1〜2
（ダウンロードして **Upload a template file**）が one-click 相当の正式手順です。この判断は
Open Question 7（配布先を S3 / CloudFront / GitHub Release のどれにするか）への回答でもあり、
GitHub Release アセットとしての配布も現時点では行っていない。

launcher の platform / catalog 初期値は、repo 直下の
[`release/tenkacloud-release.json`](../../release/tenkacloud-release.json) にある完全な commit SHA
と一致させる。人間向けの現在地は、同じ manifest から生成した
[`release/tenkacloud-release.md`](../../release/tenkacloud-release.md) を参照する。現在の pair は
**candidate / unverified** であり、immutable であることと認定済みであることは別です。stack
parameter のどちらかの ref に `main` を指定すると **development / unreleased**、manifest 以外の
組み合わせは **custom / unverified** として Output と build log に表示される。CodeBuild の
one-build override を使った場合、build log は実際の ref を分類するが、Output は stack に保存された
parameter の分類のままです。

### デプロイ手順

1. README の [Quickstart](../../README.md#quickstart) から `lite-pipeline.yaml` を download する
2. Console の CloudFormation で **Upload a template file** を選び、この yaml を upload する（スタック名は `tenkacloud-lite-launcher` ＝ ビルドが作る `tenkacloud-lite` スタックと衝突させない）
3. 下表のパラメータを入力する
4. 「IAM 権限変更を承認」にチェックしてスタックを作成する
5. スタックの `StartBuildConsoleUrl` 出力から CodeBuild プロジェクトを開き、**Start build** を押す（デプロイは 15-30 分程度）

| パラメータ | 必須 | 説明 |
| --- | --- | --- |
| `Environment` | 任意 | `development` / `staging` / `production`。対応する config.json / .env を使う |
| `Action` | 任意 | `deploy`（デフォルト）/ `destroy`（stack 削除。DynamoDB もデフォルトで削除）/ `destroy-all`（明示的に保持したデータとログを含む完全削除）。撤去は後述 |
| `TenantAdminEmail` | 必須 | Application Admin Console の初期ユーザー宛先 |
| `ProblemsRepoUrl` | 任意 | 載せる問題カタログ repo。デフォルトは公式 TenkaCloudChallenge。自分の fork を指定すれば自分の問題で deploy できる |
| `ProblemsRepoRef` | 任意 | カタログの branch / tag / 完全な commit SHA。デフォルトは release manifest の catalog commit |
| `RepoUrl` / `RepoRef` | 任意 | 本体 repo と branch / tag / 完全な commit SHA（デフォルトは release manifest の platform commit）。fork のときだけ上書き |
| `DeployExternalId` | 任意 | 競技者アカウントへ AssumeRole する場合のみ |
| `ControlDataBackend` | 任意 | `dynamodb`（デフォルト、全テーブル DynamoDB）/ `turso`（DynamoDB テーブルを一切 synth しない SQL backend）。既存 stack での切替は破壊的になりうる（下の再ビルド方針を参照） |
| `TursoDatabaseUrl` | `ControlDataBackend=turso` のときのみ必須 | Turso の `libsql://` database URL |
| `TursoAuthTokenParameterName` | `ControlDataBackend=turso` のときのみ必須 | Turso auth token を保持する SSM Parameter Store 名（SecureString。トークンの値そのものはこのパラメータに渡さない） |
| `DynamoReadCapacity` | 任意 | 全 DynamoDB テーブル + GSI に適用する provisioned read capacity（デフォルト 1、上限 200）。`turso` のときは無視される |
| `DynamoWriteCapacity` | 任意 | 同上の write capacity（デフォルト 1、上限 200） |
| `BunVersion` | 任意 | CodeBuild に install する Bun。デフォルトは repo toolchain と同じ `1.3.11` |
| `CodeBuildTimeoutMinutes` | 任意 | CodeBuild timeout。デフォルトは 90 分 |

完了後、Application Admin Console / Participant Portal の URL は `tenkacloud-lite` /
`tenkacloud-lite-problem-deploy` スタック（= ビルドが作る本体）の CloudFormation **Outputs**
に出ます。

> **自分の問題で deploy する場合:** [TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge)
> を fork し（`scripts/new-problem.ts`・schema・validation が同梱）、そこで作問してから
> `ProblemsRepoUrl` に自分の fork を指定する。本体の fork は不要。

### launcher / build / destroy の責務境界

このテンプレート（launcher stack）が作るのは CodeBuild プロジェクト 1 つ + IAM Role + 専用
ロググループ（`LauncherLogGroup`）だけで、TenkaCloud 本体の stack（`tenkacloud-lite` /
`tenkacloud-lite-problem-deploy`）は一切作らない。本体の作成・更新・削除はすべて CodeBuild の
1 回のビルドが `make deploy` / `make destroy` / `make destroy-all` を実行することで行われ、
launcher stack 自体はビルドの起動口を用意するだけです。触るレバーは 3 段階に分かれる。

| レバー | 変わるもの | 効果が続く範囲 |
| --- | --- | --- |
| launcher stack の **Update stack** | `lite-pipeline.yaml` の Parameters が持つデフォルト値（= CodeBuild 環境変数の `Value`）を CFn UPDATE でその場変更する（置換なし） | 以後、override なしで Start build するたびに使われる |
| CodeBuild **Start build with overrides** | その 1 回のビルドだけ任意の環境変数を上書きする。launcher stack 自体は変更されない | その 1 ビルドのみ |
| CodeBuild **Start build**（override なし） | 何も変えず、launcher stack に保存されたデフォルト値どおりに実行する | — |

`RepoRef` をリハーサル後の commit SHA に固定する・`TenantAdminEmail` を恒久的に変えるなど「今後ずっと
この値にしたい」ときは launcher stack の Update stack を使う。`ACTION=destroy-all` の実行、
`Environment` を変えて同じ launcher から別イベントを動かす、といった単発の変更は Start build
with overrides で済ませ、launcher のデフォルト値は触らない。

### パラメータ別の再ビルド方針

各パラメータを変えたときに override だけで済むか、そして既存データ・環境にどう影響するかを
次に示す（「影響」欄は CDK / CLI の実装を確認した内容）。

| パラメータ | override で反映されるか | 既存データ・環境への影響 |
| --- | --- | --- |
| `Environment` | 可（その回だけ別 env で走らせられる） | 別の env 名は別のスタック名（development だけ suffix なし、他は `-<env>`）になり、同一 AWS アカウント内で並行する**別の Lite デプロイ**になる。1 つの launcher から複数イベントを並行運用する手段にもなるが、デフォルト運用はイベントごとに launcher を分けることを推奨する |
| `Action` | 可（むしろ override 前提） | `deploy` / `destroy` / `destroy-all` の選択そのもの。デフォルト値を `destroy` 系のまま launcher に保存すると、次の無指定 Start build が誤って撤去を実行するのでデフォルト値は `deploy` のままにする |
| `TenantAdminEmail` | 可 | 同じ email なら `ensureTenantAdminUser` が既存ユーザーを検出して **skip**（冪等）。別 email に変えて再実行すると、古いユーザーは削除・置換されず**新しい Tenant Admin がもう 1 人追加される**（重複作成） |
| `RepoUrl` / `RepoRef` | 可 | CodeBuild は branch / tag と完全な commit SHA の双方を fail-closed に取得する。manifest の初期値は不変だが、`main` / branch は再実行時に移動しうる。one-build override では build log が実 ref を分類し、CloudFormation Output は stack に保存した ref の分類のままになる。`cdk deploy` は差分を CFn UPDATE として適用する（stateful resource の置換が起きうる）。本番直前に `main` の最新を無条件で当てず、リハーサルを通過した完全な commit SHA へ固定する |
| `ProblemsRepoUrl` / `ProblemsRepoRef` | 可 | 同上でカタログ・portal 資材が再ビルドされる。community catalog（= 「core」問題）の provenance は event 作成時に `{source:"core"}` としてしか記録されず、内容の digest は pin されない。そのため再ビルド後は**既存 event の問題 picker にも新しい catalog がそのまま反映される**。Problem Pack 経由の問題だけは `packId` / `packVersion` / `contentDigest` が event 作成時に不変 pin される（`infrastructure/lib/problem-pack/event-pin.ts` の `createEventSnapshot` / `resolveDeploymentProvenance`）ので、pack を更新しても既存 event の解決済み provenance は変わらない |
| `DeployExternalId` | 可 | AssumeRole の trust に影響する。競技者側 `competitor-bootstrap.yaml` の ExternalId と一致させる必要がある |
| `ControlDataBackend` | 可（ただし極めて破壊的） | `dynamodb` ⇔ `turso` の切替を既にデータが入っている stack に対して行うと、**切替後は空のバックエンドから始まり旧データは同期されない**（#2677 で dual-write bridge は廃止済み）。詳細は [`docs/running-costs.md`](../../docs/running-costs.md) の「Migrating an existing stack」を参照 |
| `TursoDatabaseUrl` / `TursoAuthTokenParameterName` | 可 | `ControlDataBackend=turso` のときのみ意味を持つ。値を誤ると turso 接続失敗で deploy が fail する |
| `DynamoReadCapacity` / `DynamoWriteCapacity` | 可 | `DynamoDbLowCapacity` aspect が対象テーブル + GSI の `ProvisionedThroughput` を書き換える。DynamoDB の Provisioned Throughput 変更は **CFn UPDATE（置換なし、データ消失なし）**。`ControlDataBackend=turso` のときは DynamoDB テーブル自体が synth されないため無視される |
| `BunVersion` / `CodeBuildTimeoutMinutes` | 可 | ビルド環境の設定のみで、デプロイ済みリソースには影響しない |

**開催中の再ビルドは原則非推奨。** 特に `ProblemsRepoRef` / `RepoRef` / `ControlDataBackend` の
変更は、開催中の event に対して参加者間の公平性やデータ整合性を壊しうる。緊急修正が必要な場合は
影響範囲を確認し、対応内容・時刻・対象チームを event log に残す。当日の運用フローは
[`docs/operations/event-runbook.md`](../../docs/operations/event-runbook.md) を参照。

**同じ launcher から destroy 後に再デプロイすること自体は可能。** デフォルトの
`RetainDataTables=false` でデプロイした stack は、`ACTION=destroy` でも DynamoDB テーブルを削除する。
履歴を残す場合は、デプロイ時（または destroy 前の再デプロイ時）に
`RetainDataTables=true` を指定する。この場合、CloudFormation が自動生成した物理名のため次の deploy
とは衝突しないが、**前回の RETAIN テーブルは孤立したまま残り、課金され続ける**
（`scripts/lib/retained-tables.ts` が警告するのはこの孤立分）。再デプロイの前に
`ACTION=destroy-all` で完全削除するか、孤立テーブルを手動で削除すること。

### 撤去 (teardown)

このデプロイは **3 つの独立したスタック**を作る: `tenkacloud-lite-launcher`（このテンプレ ＝
CodeBuild プロジェクト）と、ビルドが作る `tenkacloud-lite` / `tenkacloud-lite-problem-deploy`
（本体）。launcher を消しても本体は残るので順番に撤去する。

**推奨（CodeBuild から）:** CodeBuild プロジェクトで **Start build with overrides** を選び、
環境変数 `ACTION` に `destroy-all` を入れて実行する。CodeBuild は本体 2 スタックが所有する
DynamoDB テーブルと問題デプロイ用ログを物理 ID で特定して完全削除し、続けて 2 スタックを正しい
順序（cross-stack 参照の都合で `tenkacloud-lite` → `tenkacloud-lite-problem-deploy`）で削除する。
その後 `tenkacloud-lite-launcher` スタックを削除すれば CodeBuild プロジェクト、IAM Role、
launcher のロググループも消える。DynamoDB 履歴を残すには、先に
`RetainDataTables=true` でデプロイし、その後 `ACTION=destroy` を使う。

> **既存 launcher の更新:** `destroy-all` を追加する前のテンプレートで作成した launcher は、
> CloudFormation の **Update stack** から最新版の `lite-pipeline.yaml` をアップロードして更新して
> から実行する。旧 buildspec は未知の `ACTION` を deploy として扱うため、旧 launcher に
> `ACTION=destroy-all` を直接指定してはいけない。最新版は未知の値を fail closed する。

**手動（Console から）:** CloudFormation で **`tenkacloud-lite` を先に削除** → DELETE_COMPLETE
を待って **`tenkacloud-lite-problem-deploy`** を削除 → 最後に `tenkacloud-lite-launcher`。逆順
だと `Export ... cannot be deleted as it is in use` で止まる。デフォルトの
`RetainDataTables=false` なら DynamoDB テーブルも stack とともに消える。
`RetainDataTables=true` でデプロイしていた場合だけテーブルが残るため、名前の前方一致で
手動削除せず、完全削除には上の `ACTION=destroy-all` を使う。

### コストの注意

問題テンプレート (`problems/**/template.yaml`) は AWS 無料枠 0 円に収めているが、この
デプロイは CodeBuild (build-minute 課金) を使うため厳密な 0 円ではない（月数回のデプロイで
1 ドル未満）。使い終えたら `ACTION=destroy-all` と launcher スタック削除まで完了させる。
`RetainDataTables=true` でデプロイした場合、`ACTION=destroy` だけでは保持された DynamoDB の
provisioned capacity 課金は止まらない。

## マルチクラウド（非 AWS）の team 認証情報セットアップ

AWS 以外（Sakura / Azure / GCP）の問題を deploy するには、運営者が機能フラグを有効化し、team
ごとのクラウド認証情報を登録します。問題 picker は登録済み provider と連動し、有効化していない
provider の問題は「近日対応」のまま選べません（Issue 2167）。

### 1. 機能フラグを ON にする

`.env`（`infrastructure/environments/<env>/.env`）に `CDK_PARAM_FEATURES='{"nonAwsRuntime":true}'`
を設定して deploy します（デフォルト OFF。Issue 2230 で S3 上の `runtime-config.json`
手編集は不要になりました）。Application Admin Console の Competitor Accounts ページに
Team Cloud Credentials パネルが現れます。

### 2. provider 側で認証情報を作る

運営者は SSM を直接触りません。下記で作った値をパネルに貼り、パネルが API 経由で暗号化保存
（SSM SecureString）します。

| provider | 作り方 | パネルに入れる JSON |
| --- | --- | --- |
| Sakura | コントロールパネルで API キーを発行する | `{accessToken, accessTokenSecret}` |
| Azure | `az ad sp create-for-rbac` で Entra アプリと RBAC を作成する | `{azureTenantId, clientId, clientSecret, subscriptionId, resourceGroup}` |
| GCP | `gcloud` で Workload Identity プールとサービスアカウントを作成する（keyless） | `{wifAudience, serviceAccountEmail, projectId, location, artifactBucket}` |

### 3. 登録して使う

パネルで provider と team slug を選び、上記 JSON を貼って「登録 / 更新」します。登録後、event
作成の問題 picker でその provider の問題が選択可能になります。鍵を更新するときは同じ team に
登録し直すと上書きされ、不要になったら「失効」で削除できます。secret は登録時に送るだけで、
一覧 / status には表示されません。

GCP の `artifactBucket`（任意 field、Issue #2745）は Terraform blueprint zip を upload する
team 所有の GCS bucket 名です。事前に `gcloud storage buckets create` で作成し、登録した
`serviceAccountEmail` に書き込み権限（`roles/storage.objectAdmin` 等）を付与してください。
platform の CDK が作る bucket ではなく、team 自身が作成・課金・保持ポリシーを管理する bucket です。
未登録のまま `gcp/infra-manager` 問題を deploy しようとすると、materializer が
「register artifactBucket」という診断で fail-closed します。

## 関連

- [`/problems/README.md`](../../problems/README.md) — 問題カタログ規約
- [`/problems/battles/security-battle-royale/template.yaml`](../../problems/battles/security-battle-royale/template.yaml) — 実際に deploy される問題 CFn の例
