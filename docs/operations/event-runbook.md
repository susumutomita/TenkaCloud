# イベント運用 Runbook

Issue #2407。TenkaCloud で 1 回のイベント (Battle / Challenge) を運営する運営者向けの手順書。作問者でなくても、この文書だけで前日準備から撤収まで通せることを目標にする。キャパシティ運用の詳細は [dynamodb-event-capacity.md](./dynamodb-event-capacity.md)、デプロイ手順の詳細は [DEPLOYMENT_GUIDE.md](../../DEPLOYMENT_GUIDE.md)、問題ごとの当日運用は各問題の `OPERATOR.md` (catalog repo) に委ねる。

## 前提: どのモードで動かすか

イベント規模で運用モードを決める。デプロイ手順そのものは DEPLOYMENT_GUIDE.md にあるので、ここでは「どれを選ぶか」だけ確認する。

| モード | 起動 | 何が立つか | 向いている規模 |
| --- | --- | --- | --- |
| Lite (単一テナント、デフォルト) | `make deploy` / Console から `lite-pipeline.yaml` | 2 スタック (`ProblemDeployBackendStack` + `TenkaCloudLiteStack`)。Tenant Admin Console + Participant Portal。`tenantId="local"` 固定 | 主催者 1 人 / 1 イベント |
| SaaS (マルチテナント) | `make deploy-saas` (`scripts/install.sh`) | SBT ControlPlane + Bootstrap + pooled Tenant + 各 SPA hosting。System Admin 招待あり | 複数テナント / 常設運用 |

- Lite / SaaS は AWS の 1 分 tick (EventBridge `rate(1 minute)`) で採点する。
- 環境切替は `make deploy ENV=production` のように `ENV` で行う (`infrastructure/environments/<env>/.env` を読む)。

## Lite launcher のライフサイクルと再ビルド方針 (Issue #2760)

Console 版 Lite (`lite-pipeline.yaml`) は launcher stack を作った時点では何もデプロイしない。CodeBuild の **Start build** を押した 1 回のビルドだけが `make deploy` / `make destroy` / `make destroy-all` を実行する。launcher が用意するのは CodeBuild の起動口だけであり、TenkaCloud 本体 (Lite stacks) の作成・更新・削除は毎回そのビルドが行う。この手動開始は取り残した手作業ではなく、課金の発生する操作を明示的なスイッチの先に置くための意図的な設計であり、launcher / build / destroy の責務境界とパラメータ別の再ビルド影響は [`infrastructure/templates/README.md`](../../infrastructure/templates/README.md#cloudformation-console-lite-mode-deployment-pipeline) に集約してある。

デフォルトの運用モデルはイベント単位の一時環境です。

```text
イベント準備
  ↓
launcher stack 作成
  ↓
CodeBuild Start build (ACTION=deploy)
  ↓
TenkaCloud Lite 環境作成
  ↓
manifest の immutable candidate でリハーサル
  ↓
より新しい main / branch を試す場合は development / unreleased 表示を確認
  ↓
リハーサル完了後、通過した RepoRef / ProblemsRepoRef の完全な commit SHA を記録・固定
  ↓
本番開催 (原則、再ビルドしない)
  ↓
終了後: ACTION=destroy-all (完全撤去) または ACTION=destroy (通常撤去)
  ↓
launcher stack 削除
```

常設利用を禁止するものではないが、イベントごとに launcher を作り直し、終了後に destroy することをデフォルトの運用として推奨する。同じ launcher をイベントをまたいで使い回すこと自体は可能(CodeBuild は毎回両 repo を re-clone するため)だが、本番前の ref 固定と撤去のタイミングが曖昧になりやすいので、イベントごとの新規 launcher を推奨する。launcher の初期値、認定状態、既知の制限は [`release/tenkacloud-release.md`](../../release/tenkacloud-release.md) を正本とし、candidate / unverified を certified と読み替えない。

### 再ビルドケース別の方針

| ケース | 内容 | 方針 |
| --- | --- | --- |
| A. TenkaCloud 本体のみ更新 (UI / API / CDK 修正) | `RepoRef` の指す branch へ push された変更 | `RepoRef` が同じ branch なら Start build の再実行で最新 commit が反映される (差分は CFn UPDATE)。`main` を選ぶと development / unreleased と表示される。本番直前に `main` の最新を無条件で当てず、リハーサル後は完全な commit SHA へ固定する |
| B. Problem Catalog へ問題を追加・修正 | `metadata.json` 追加、`template.yaml` 修正、portal component 追加、flag / scoring rule 変更 | 問題を追加しただけなら Start build の再実行で catalog / portal が更新される。community catalog (core 問題) の provenance は event 作成時に pin されないため、再ビルド後は**既存 event の picker にも新しい catalog がそのまま反映される**。問題テンプレートを変更した場合、既に deploy 済みの team の problem stack へ反映するには、その team に対する deploy を再実行する — 健全な stack には in-place `UpdateStack` が、終端状態 (`CREATE_FAILED` 等) の stack には delete + recreate が自動で選択される (`classifyDeployAction`, `infrastructure/lib/problem-deploy/handlers/cfn-deploy-handler/create-stack.ts`)。開催中の問題変更は原則非推奨 — 参加者間の公平性を壊しうる |
| C. 独自 Problem Repo の ref 変更 | `ProblemsRepoRef` の変更 | 推奨はイベントごとに launcher stack を作成し、`ProblemsRepoRef` は検証済みの完全な commit SHA へ固定すること。イベント途中で ref を変更しない。一時的な override (Start build with overrides) は launcher のデフォルト値を変えないので、恒久的に固定したい場合は launcher stack を Update stack する |
| D. 管理者メール・capacity・backend 変更 | `TenantAdminEmail` / `DynamoReadCapacity` / `DynamoWriteCapacity` / `ControlDataBackend` など | パラメータごとの override 可否・既存データへの影響は [`infrastructure/templates/README.md`](../../infrastructure/templates/README.md#cloudformation-console-lite-mode-deployment-pipeline) の表を参照。`ControlDataBackend` の切替は既存データを同期しないため特に注意する |

## 前日準備

前日までに次を全部潰しておく。当日に初めて触る要素をなくすのが目的。

### 1. デプロイと Outputs の確認

- 使うモードでデプロイが完了していること。Lite なら `tenkacloud-lite` / `tenkacloud-lite-problem-deploy` の 2 スタックが `CREATE_COMPLETE` / `UPDATE_COMPLETE`。
- 各スタックの Outputs から次を控える。
  - Participant Portal の URL (`tenkacloud-problem-deploy` / Lite は `tenkacloud-lite-problem-deploy`)。
  - Admin Console / Application Admin Console の URL。
  - `EventCapacityRunbookName` (キャパシティ変更に使う SSM Automation document 名)。
- `.env` に `TENANT_ADMIN_EMAIL` (Lite) または `SYSTEM_ADMIN_EMAIL` (SaaS)、`AWS_REGION`、`CDK_PARAM_DEPLOY_EXTERNAL_ID` が入っていること。

### 2. 競技アカウント (competitor account) の bootstrap 確認

各競技チームの AWS アカウントに問題スタックをデプロイするには、そのアカウント側で一度だけ `infrastructure/templates/competitor-bootstrap.yaml` を流し、IAM ロール `TenkaCloud-CompetitorDeploy-Role` を作っておく必要がある。

- このロールの信頼ポリシーは「`arn:aws:iam::<TenkaCloud アカウント>:root` からの `sts:AssumeRole`」を **`sts:ExternalId` 一致を条件に** 許可している (アカウント + ExternalId の 2 要素、Confused Deputy 対策)。
- 運営側の ExternalId は SSM SecureString に置き、`CDK_PARAM_DEPLOY_EXTERNAL_ID` で配線する。**ExternalId は常に必須** (省略した AssumeRole は禁止)。
- 前日に、テスト用に 1 アカウントぶんデプロイを流して AssumeRole が通ることを確認する。ここが通らないと当日の一括デプロイが全チーム落ちる。

### 3. 問題ごとの smoke test

出題する各問題について、捨てチーム用スタックを 1 個デプロイし、その問題の `OPERATOR.md` (catalog repo の `battles/<id>/OPERATOR.md` / `challenges/<id>/`) の「Before the event」に従って動作確認する。

- Battle の URL 系 Output はデフォルトで空文字 `""` になっている (参加者がエンドポイントを登録するまで採点が始まらない participant-action gate)。デプロイ直後にスコアが 0 なのは正常。
- 各問題の想定する登録手順 (例: `Ec2HostHint` を各スロットに貼る) と、採点エンジンが叩くヘルスパス (例: `/`、`/api/v1/apistatus`、`/meta` + `/score`) が 200 を返すことを確認する。
- 赤チーム (disruption) を持つ問題は、`OPERATOR.md` の smoke test スクリプトを 1 回流し、fault injection と revert が効くことを確認する。

### 4. キャパシティの事前スケール

参加者 portal の polling と採点 tick で read が支配的になる。throttle は participant 体験を直撃するので、**出てから上げるのではなく、イベント開始 30 分前に規模の目安どおり事前に上げる**。

- 対象は event-hot な 5 テーブル: `Deployments` / `Events` / `Teams` / `ProblemEndpoints` / `Disruptions`。
- 手順・規模別の目安値・課金感覚・戻し方は [dynamodb-event-capacity.md](./dynamodb-event-capacity.md) に集約してある。`EventCapacityRunbookName` の SSM Automation を `aws ssm start-automation-execution` で回す。
- 上げたら必ず撤収チェックリストで 1/1 に戻す (戻し忘れが唯一の課金爆死経路)。

### 5. 参加者ログイン鍵の確認

- 参加者は **チームごとのログイン鍵** で Participant Portal に入る (個人アカウントでも Cognito でもない)。鍵は 43 文字の base64url 文字列で、デプロイ時に発行され UI に一度だけ表示される。
- 鍵そのものが bearer トークンになる (毎 polling で `Authorization` に載る)。アイドル 6 時間で自動ログアウトする。
- 前日に、テストチームの鍵で実際にログインし、そのチームのデプロイと採点が portal に見えることを確認する。招待リンク `/login#invite=<鍵>` は鍵を prefill するが自動送信はしない (鍵が履歴に残らないよう hash は消える)。

## 当日タイムライン

| 時刻 | やること |
| --- | --- |
| T-60 分 | 全スタックの状態を再確認。Participant Portal / Admin Console が開くこと。前日から `.env` や ExternalId を変えていないこと |
| T-30 分 | キャパシティを規模の目安値に事前スケール (5 テーブル、[capacity runbook](./dynamodb-event-capacity.md))。scale-up は無制限なので余裕を持って上げる |
| T-15 分 | 参加者へ Participant Portal URL とチームログイン鍵を配布。各チームが問題スタックをデプロイ (または運営が一括デプロイ) |
| T-5 分 | 各チームがエンドポイントを登録し、採点が回り始めていることを Deployments のスコアで確認。まだ 0 のチームは登録漏れ (下の「スコアが止まった」参照) |
| T-0 | 競技開始。以降は disruption スケジュールを各問題の `OPERATOR.md` で把握しつつ部屋を監視 |
| 競技中 | キャパシティ panel (30 秒 polling) を監視。`Throttle 発生` (赤) が出たら即 1 段上げる。bulk deploy 直前は `Deployments` の write を一時的に 1 段上げる |
| 終了 | 採点を止める (イベント終了時刻を過ぎた round は tick が自動で skip する)。順位を確定 |
| 撤収 | 下の撤収チェックリスト |

- disruption の fire 時刻は問題ごとに違い、多くは `publicHint: false` (参加者に見えない)。運営は各問題の `OPERATOR.md` の赤チーム表で把握する。参加者には明かさない。
- `afterMinutes` など運営が調整可能なパラメータは各問題の `disruptions[].operatorEditable` に列挙されている。

## よくある障害と切り分け

### スコアが止まった (特定チームだけ / 全チーム)

採点は 1 分ごとの EventBridge tick で、各チームの **実効エンドポイント URL** (`override ?? default`) を叩く。止まる原因は主に 4 つ。

1. **エンドポイント未登録** (特定チーム): Battle の default URL は空文字なので、参加者が override を登録するまで採点対象にならず、その tick は no-op になる。application-admin-console のイベント詳細、または Deployments のスコアで「0 のまま」のチームを特定し、`ProblemEndpoints` に override が入っているか確認する。→ 参加者にエンドポイント登録 (例: `Ec2HostHint` を各スロットに貼る) を促す。
2. **プローブ失敗** (特定チーム): 登録済みだがエンドポイントが 200 を返していない。全エンドポイントが OK の tick でしか加点しない問題が多い (`uptime-multi` / `uptime-flat`)。その問題の `OPERATOR.md` の smoke test コマンドで当該チームの URL を叩き、アプリが落ちていないか、disruption が刺さっていないかを確認する。
3. **キャパシティ throttle** (全チーム): event-hot 5 テーブルが 1/1 のまま参加者が増えると、tick の read (`Events` / `Teams` / `ProblemEndpoints`) や score write (`Deployments`) が throttle して採点が詰まる。キャパシティ panel の `Throttle 発生` (赤) を確認し、[capacity runbook](./dynamodb-event-capacity.md) で上げる。**全チームのスコアが同時に止まったらまずこれを疑う**。
4. **イベントが active でない** (全チーム): 開始前 (未来スケジュール) または終了後の round は tick が意図的に skip する。イベント定義の開始 / 終了時刻を確認する。

### デプロイ失敗 (問題スタックが競技アカウントに立たない)

デプロイは `DeployCreateRequested` イベント → `DeployCreateStateMachine` → CFn デプロイ handler が競技アカウントに AssumeRole して CFn CreateStack する。ジョブは `Deployments` テーブルに 1 行ずつ記録され、`status` / `failureReason` が入る。まずそこを見る。

- **AssumeRole / ExternalId 不一致** (`AccessDenied`): 競技アカウントの `TenkaCloud-CompetitorDeploy-Role` の信頼ポリシーが、運営アカウントか ExternalId で弾いている。競技アカウントで `competitor-bootstrap.yaml` が正しい `TenkaCloudAccountId` + `ExternalId` で流されているか、運営側の ExternalId SSM SecureString が一致するかを確認する。ExternalId ローテーション中の取りこぼしは 1 世代前のパラメータで自動リトライされるが、それでも落ちるなら値ズレ。
- **CFn CreateStack 失敗**: スタックが `CREATE_FAILED` / `ROLLBACK_COMPLETE` などの terminal 状態。`failureReason` (= `StackStatusReason`) を読む。terminal 状態のスタックは delete してから再作成される。競技アカウント側の CloudFormation イベントを直接見ると根本原因 (権限 / リソース上限 / テンプレートエラー) が分かる。
- **テンプレート / メタデータ不備**: `metadata.json is not valid JSON`、`cfnParameters` が文字列でない、問題側の ExternalId パラメータが 16 文字未満、S3 上のテンプレート object が空、などは handler が明示メッセージを出す。作問側の問題なので該当問題の catalog を確認する。
- **一括デプロイが全チーム落ちる**: 個別要因でなく bootstrap / ExternalId の配線ミス。前日に 1 アカウントで AssumeRole を確認していれば当日は起きにくい。

### 参加者ログイン不可

Participant Portal のログインはチームログイン鍵そのものを bearer にする (参加者側に Cognito / JWT はない)。失敗の切り分けは次のとおり。

- **鍵が空**: フロントが `EMPTY_TEAM_LOGIN_KEY` を出し、リクエストは飛ばない。→ 鍵を入力してもらう。
- **鍵の形式が不正** (43 文字の base64url でない): DynamoDB を引く前に **401**。コピー&ペーストで前後に空白 / 改行が混ざっている、鍵が途中で切れている、を疑う。
- **形式は正しいがチームが見つからない**: 鍵がローテーション / TTL 失効した、または撤収でスタックが消えて Deployments テーブルの sparse GSI2 行が消えた、などで **401** (`PortalAuthError`)。→ 有効な鍵を再発行 / 再配布する。デプロイをテスト中に消していないか確認する。サーバ側には `portal.login.unauthorized` の構造化ログ (reason = `no_rows` / `all_deleted` / `no_live_sample`) が出るので、CloudWatch で原因を切り分けられる (Issue 2675)。
- **バックエンド到達不能**: フロントが `BACKEND_UNREACHABLE`。Participant Portal のバックエンド (`tenkacloud-problem-deploy`) が生きているか、URL / runtime-config が正しいかを確認する。
- 鍵の保存方式はバックエンドで異なる (デフォルト DynamoDB は **Deployments テーブル**の sparse GSI2 `TEAMKEY#<鍵>` に平文で索引、SQL 経路は SHA-256 ハッシュのみ。Teams テーブル側の平文 index は Issue 2674 で削除済みで、鍵は再配布用の属性としてのみ残る)。どちらでも「鍵 = そのチームの認証情報」なので、鍵の配布経路は限定する。

## 撤収チェックリスト

イベント終了後、上から順に。**キャパシティの戻しと問題スタックの削除は必須**。

- [ ] 順位を確定し、必要なら Deployments のスコア履歴 (`EVENT#...` 行) を控える。
- [ ] **キャパシティを 1/1 に戻す** (event-hot 5 テーブル)。[capacity runbook](./dynamodb-event-capacity.md) の scale-down。scale-down はテーブルあたり 1 日の回数制限があるので、細かく下げず一発で 1/1 に戻す。上げっぱなしの放置が唯一の課金爆死経路。
- [ ] **各チームの問題スタックを削除**: `aws cloudformation delete-stack --stack-name <チームスタック名>`。問題によっては参加者が作った managed リソース (Lambda / ECS / App Runner / ALB / ECR / SG など) がスタック外に残る (例: microservice-migration-battle)。各問題の `OPERATOR.md` の「After the event」に従い、`${NamePrefix}` prefix / `TenkaCloud:NamePrefix` タグで掃く。
- [ ] Battle 問題のログイン鍵は TTL で自動失効するが、早期に無効化したい場合はデプロイを削除する。
- [ ] **Lite はデフォルトでイベントごとに撤去する**(Issue #2760): 完全削除は `make destroy-all` (Console 経由なら CodeBuild を **Start build with overrides** で `ACTION=destroy-all` を指定して再実行)。通常の `make destroy` / `ACTION=destroy` でも、デフォルトの `RetainDataTables=false` なら DynamoDB テーブルは stack とともに削除される。履歴を残す場合はデプロイ時（または destroy 前の再デプロイ時）に `RetainDataTables=true` を指定し、残る provisioned capacity 課金を理解した上で `destroy` を使う。常設運用(イベントをまたいで同じ環境を稼働させ続ける)は default ではなく明示的な選択であり、その場合はこのチェックリストの本項目をスキップしてよい。SaaS は `make destroy-saas` (`scripts/cleanup.sh`、部分削除からでも冪等)。
- [ ] **destroy 後の残存確認**: CloudFormation で `tenkacloud-lite` / `tenkacloud-lite-problem-deploy` の 2 スタックが `DELETE_COMPLETE` になっていること。`RetainDataTables=true` でデプロイしてから `ACTION=destroy` を使った場合だけ、`RemovalPolicy.RETAIN` の DynamoDB テーブルが意図的に残る — 次にこの launcher から再デプロイする前に `ACTION=destroy-all` で完全削除するか、残ったテーブルを手動で消しておく(消し忘れは孤立テーブルとして課金され続ける、`scripts/lib/retained-tables.ts` の警告対象)。
- [ ] **launcher stack の削除**: 本体 2 スタックの撤去を確認したら `tenkacloud-lite-launcher` を削除し、CodeBuild プロジェクト・IAM Role・launcher 専用ロググループも消す。次のイベントは新しい launcher stack を作るのがデフォルト運用(同じ launcher の使い回しも可能だが、上の再デプロイ注意点を踏まえる)。

## リハーサル振り返り

イベント後のドライラン振り返り項目 (実イベントでの気づきの反映) は #2405 で別途扱う。実イベントを 1 回通してから、この Runbook に不足していた切り分け手順を追記すること。

## 参照

- [dynamodb-event-capacity.md](./dynamodb-event-capacity.md) — イベント中のキャパシティ運用の詳細手順
- [DEPLOYMENT_GUIDE.md](../../DEPLOYMENT_GUIDE.md) — Lite / SaaS の具体的なデプロイ手順
- [docs/local-play.md](../local-play.md) — AWS なしのローカル動作確認 (`make local`)
- `infrastructure/templates/README.md` — 競技アカウント側の bootstrap 手順
- 各問題の `OPERATOR.md` (catalog repo `battles/<id>/OPERATOR.md`) — 問題ごとの当日運用・赤チーム・撤収
