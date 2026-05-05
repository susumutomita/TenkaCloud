# ADR-001: 問題 Deploy を CRUD x Step Functions Distributed Map で実装する

- **Status**: Proposed (2026-05-05)
- **Requirements**: [`docs/requirements/problem-deploy.md`](../requirements/problem-deploy.md) (Approved)
- **Supersedes**: 既存 `ProblemDeployBackendStack` の `DeployApiGateway` (専用 HTTP API + 単一 Cognito JWT authorizer) と `DeployWorkerLambda` (1 event = 1 CFn deploy) 構成
- **Related issues**: Issue 458 (publish 経路統一)、Issue 459 (cross-account federation)

## Context

要件文書 [`docs/requirements/problem-deploy.md`](../requirements/problem-deploy.md) で確定した要件と、現状実装の `ProblemDeployBackendStack` のギャップを埋めるための設計判断を本 ADR で記録する。

要件側の主要な制約 (本 ADR の Decision を駆動するもの) は次のとおり。

- **FR-1**: 1 batch あたり 750 stacks (= Challenge: 25 チーム × 30 問) を扱える bulk operation 必須
- **FR-2**: CRUD 4 操作すべて要る (Update は問題作成 iteration 用途)
- **FR-3**: 失敗時は部分 retry のみ。operator はデバッグできない
- **FR-5**: 問題カタログ (S3 template + DDB metadata + 可視範囲)
- **NFR-1**: operator は AWS 専門知識を持たない
- **NFR-2**: operator は TenkaCloud 自社 AWS account を一切触らない
- **NFR-3**: 競技者アカウントは野良 AWS account の可能性あり (= AWS Organizations 単位の共有が使えない)

## Decision

### 1. publish 経路は tenant API + tenant Cognito + EventBridge → Step Functions

```text
[application-admin-console (ログイン済)]
        ↓ POST /deployments/{operation}  with tenant Cognito JWT
[TenantTemplateStack の REST API]
        ↓ Lambda が events:PutEvents を呼ぶ
[EventBridge bus (= ControlPlaneStack.eventBusArn)]
        ↓ EventBridge Rule (detail-type で分岐)
[Step Functions State Machine (operation ごとに 1 つ)]
        ↓ Distributed Map で各 (problem × account) を並列処理
[CFn API (cross-account AssumeRole 経由)]
```

専用 HTTP API + 別 Cognito の構成は廃止 (NFR-2 と整合)。tenant 自身の Cognito で認可する (= SBT の Control Plane → Application Plane と同型)。

**Lambda は EventBridge に publish し、Step Functions は EventBridge Rule で event-driven に起動する**。Step Functions State Machine は EventBridge Rule の **native target** として設定可能 ([AWS docs: EventBridge Targets](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-targets.html#eb-console-targets))。仕組みは EventBridge Rule に専用 IAM Role (`states:StartExecution` 権限) を持たせ、event 受信時に EventBridge がその Role を assume して `StartExecution` を呼ぶ。Lambda 中継は不要 (CDK では `aws-events-targets.SfnStateMachine` で 1 行)。tenant API Lambda が StartExecution を直叩きせず EventBridge を中継する理由は次の 4 点。

1. **疎結合の seam を残す**: 将来の audit log / Slack 通知 / 監視 subscriber が同じ event を listen できる
2. **SBT の既存パターンとの整合**: ControlPlane → ApplicationPlane の `onboardingRequest` event 中継と同じ形を維持
3. **Replay / archive**: EventBridge archive で event を後から replay できる
4. **権限境界の整理**: tenant API Lambda は `events:PutEvents` だけ持てば良く、`states:StartExecution` 権限を渡す必要がない

EventBridge detail-type は operation ごとに分ける (`DeployCreateRequested` / `DeployUpdateRequested` / `DeployDeleteRequested`)。Read は同期応答が必要なので EventBridge を経由せず、tenant API Lambda が直接 cross-account `cloudformation:DescribeStacks` を fan-out する。

### 2. CRUD 4 操作の API と State Machine 配置

要件 FR-2 で確定した 4 操作それぞれの実装方針。

| 操作 | API | 経路 | 内部 | 駆動要件 |
|---|---|---|---|---|
| **Create** | `POST /deployments` | EventBridge (`DeployCreateRequested`) → `DeployCreateStateMachine` (Distributed Map) | AssumeRole → CFn CreateStack → `.sync` で完了待ち | FR-1 (bulk 750)、FR-5 (authoring iteration では 1 件) |
| **Read** | `GET /deployments` | sync Lambda (cross-account `cloudformation:DescribeStacks` fan-out) | EventBridge を経由しない (同期応答が必要) | FR-3 (operator が UI で状況把握) |
| **Update** | `POST /deployments/update` | EventBridge (`DeployUpdateRequested`) → `DeployUpdateStateMachine` (Distributed Map) | AssumeRole → CFn UpdateStack → `.sync` | FR-5 (authoring iteration、通常 1 件) |
| **Delete** | `POST /deployments/delete` | EventBridge (`DeployDeleteRequested`) → `DeployDeleteStateMachine` (Distributed Map) | AssumeRole → CFn DeleteStack → `.sync` | FR-1 (event 終了時 bulk teardown)、FR-4 |

3 つの state machine (Create / Update / Delete) は同じ shape の Distributed Map iterator を持つ。違いは inner step の CFn API (`CreateStack` / `UpdateStack` / `DeleteStack`) だけ。各 state machine 専用の EventBridge Rule を 1 つ立て、Target を該当 state machine に設定する。

API は **bulk と単発を区別しない**。bulk request body は `{deployments: [{problemId, accountId, region, ...}]}`、単発は `deployments` 配列の長さが 1 のもの。authoring iteration (FR-5) では length=1、event preparation (FR-1) では length=750。state machine は同じものを iterator 1 件で回す。

### 3. Distributed Map で 750 件の bulk を扱う

要件 FR-1 が「1 batch = 750 stacks」を要求するので、Step Functions の **Standard Map** ではなく **Distributed Map** を使う。

| 観点 | Standard Map | Distributed Map | 750 件で必要か |
|---|---|---|---|
| 入力サイズ上限 | state input 256 KB | S3 経由なら無制限、in-memory でも 100K entries まで | ✅ Distributed Map 必須 (750 × 500 bytes = 375 KB は 256 KB 超過) |
| 並列度 | 40 | 10,000 | ✅ Distributed Map で並列化 |
| 子実行の分離 | 親 execution の history 内 | 各 item が独立 child execution | ✅ 失敗 item の再実行が容易 (FR-3) |
| 課金 | state transition のみ | child execution × state transition | △ コスト増だが許容 (後述) |

Distributed Map の child execution は `EXPRESS` workflow にできるが、CFn `.sync` は Standard が要るので **Standard child execution** を選ぶ。

並列度 (`MaxConcurrency`) は **default 50** とする。750 件を並列 50 で回すと、CFn 1 件 5〜10 分と仮定して `750 / 50 × 7.5 min ≈ 113 min ≈ 2 時間`。Acceptance Criteria の「1 hour 以内」目標とは届かないので、CFn template の最適化 (リソース数削減 / VPC 持ち込み) と併せて改善する。並列度を上げるとカウンターパート側 AWS account の API rate limit に当たる懸念があるため、operator が「並列度を上げる/下げる」設定はしない (`MaxConcurrency: 50` 固定)。

### 4. 失敗時は continue + summary、再実行 API で部分 retry

要件 FR-3 を満たすための具体実装。

- **Distributed Map の `ToleratedFailureCount` / `ToleratedFailurePercentage` を未設定** にする (= 失敗してもエラー扱いにせず、全 item を最後まで試す)
- 各 child execution の Catch で per-item 失敗を吸収。最後に親が `{ ok: N, failed: M, failedItems: [...] }` を返す
- 失敗 item の jobId を返り値に含めて、operator が同 batch を「失敗分だけ再実行」できるようにする
  - UI 上のボタンは「失敗した N 件を再実行」と表示
  - 内部的には `POST /deployments` で `{deployments: [失敗 item の subset]}` を再投げ
  - 新しい batchId が振られるが、stack は同じ namePrefix で CFn 側が冪等に扱う (CreateStack の `AlreadyExists` を成功扱いにする等)

### 5. 問題カタログ: S3 template + DDB metadata + 可視範囲

要件 FR-5 を実装するための data model。

- **CFn テンプレ実体**: S3 bucket に置く。バージョンごとに別 key (例: `tenants/{tenantId}/problems/{problemId}/v{N}.yaml`) もしくは S3 versioning 利用
- **問題メタデータ DDB** (新規 `Problems` テーブル):
  - `PK = TENANT#{ownerTenantId}`, `SK = PROBLEM#{problemId}`
  - 列: `title`, `description`, `templateS3Url`, `currentVersion`, `visibility` (`public` / `org-shared` / `private`), `createdAt`, `updatedAt`
  - GSI1: `PK = VISIBILITY#public`, `SK = PROBLEM#{problemId}` で全 tenant への横断 list
  - GSI2: `PK = ORG#{orgId}` (org-shared のための index、組織エンティティが確定後に活性化)
- **CFn deploy 時の template 取得**: state machine が `templateS3Url` を CFn `CreateStack` の `TemplateURL` parameter に渡す。CFn が S3 から fetch する経路を使う (Lambda が pre-fetch しない)

`org-shared` の "組織" 定義は Open Questions に残す (本 ADR では「将来 org-shared を扱うための GSI を予約」までしか書かない)。

### 6. State の所在: CFn が source of truth、DDB は participant 体験用 + 問題カタログのみ

要件 FR-4 (cleanup の保証範囲) との整合。

- **deploy 状態** (PENDING / IN_PROGRESS / CREATE_COMPLETE / FAILED) → **CFn 自身が持つ**。`describe-stacks` で取得する。
- **deploy 履歴** (誰がいつ batch を投げたか) → **Step Functions execution history** (Standard で 1 年保持)
- **stack の所在カタログ** (operator UI の「自テナントの deploy 一覧」) → **CFn stack の Tag** (`TenkaCloud:TenantId`, `BatchId`, `ProblemId`, `JobId`) を打つ。逆引きの実装は次の 2 通りで実装する。`cloudformation:DescribeStacks` 自体は tag filter をサポートしないため、(a) `resource-groups:GetResources` (Resource Groups Tagging API、tag filter ネイティブ対応) を使うか、(b) `cloudformation:ListStacks` で取得後 client-side filter する。MVP では同一 account なので 1 回の `ListStacks` 結果を tenantId tag で絞る (b) が単純。Phase 2 で cross-account になったら各 account で `GetResources` を fan-out (a) に切替検討
- **participant 体験用 state** (teamLoginKey、displayTeamName、将来のスコア) → **DDB `ParticipantSessions` テーブル** (現 `Deployments` テーブルを縮小・改称)
- **問題カタログ** → 上述 (5) の `Problems` DDB

つまり **既存 `Deployments` DDB の deploy 状態列 (status / failureReason / stackOutputs) は全廃止する**。CFn が持っているものを DDB に複製しない。

### 7. 既存 stack / Lambda の整理

| Construct | 扱い | 駆動要件 |
|---|---|---|
| `ProblemDeployBackendStack.DeployApiGateway` | **削除** (専用 HTTP API 廃止) | NFR-2 |
| `ProblemDeployBackendStack.DeployApiLambda` | **「StartExecution + 入力 validation」薄 Lambda** にダイエット (tenant API から呼ばれる) | FR-2 |
| `ProblemDeployBackendStack.DeployWorkerLambda` | **廃止** (Step Functions が直接 CFn を呼ぶ) | FR-1 (15min timeout の壁を消す) |
| `ProblemDeployBackendStack.StatusUpdaterLambda` | **廃止** (CFn 自身が状態保持、polling は不要) | FR-4 |
| `ProblemDeployBackendStack.DeploymentsTable` | **`ParticipantSessions` に改称 + 縮小** (deploy 状態列を全部削除、teamLoginKey / displayTeamName 等のみ残す) | FR-4 |
| `ProblemDeployBackendStack.ParticipantPortalLambda` / `ParticipantPortalHosting` | **継続** (本 ADR と独立) | - |
| `bin/infrastructure.ts` の `CDK_PARAM_DEPLOY_USER_POOL_ID` 周り | **削除** | NFR-2 |
| `application-admin-console` の `deployApiBaseUrl` / `useDeployApiClient` / `isDeployApiConfigured` | **削除** (`apiBaseUrl` に統合) | NFR-2 |
| `runtime-config.json.deployApiUrl` | **削除** (`apiUrl` のみ) | NFR-2 |
| `install.sh` の `cdk deploy` リスト | `ProblemDeployBackendStack` を **追加** | `ONE_PASS_AWS` invariant |
| `ProblemDeployBackendStack` 配下の **新規 construct**: `ProblemsTable` (DDB)、`ProblemTemplatesBucket` (S3)、3 つの State Machine (Create / Update / Delete) | **追加** | FR-1 / FR-2 / FR-5 |

## Consequences

### 良くなること (要件との対応)

- ✅ NFR-2 (operator が AWS account を触らない) — 認可は tenant 自身の Cognito で完結
- ✅ FR-1 (bulk 750 stacks) — Distributed Map で並列処理
- ✅ FR-3 (部分 retry) — 失敗 item を返す API で operator が単純に「再実行」できる
- ✅ FR-4 (cleanup の保証範囲) — CFn DeleteStack 成功までを responsibility に閉じ込め
- ✅ FR-5 (authoring iteration) — 単発 (length=1) も bulk と同じ API で扱える
- ✅ `ONE_PASS_AWS` invariant — `make deploy` 1 発で全動線が通る

### コスト・トレードオフ

- Step Functions Distributed Map の課金: child execution × state transition 単価。CFn `.sync` の wait loop で transition 数が膨らむため、1 child execution あたり ~8 transitions と見積もり。750 × 8 × $0.025/1000 ≈ $0.15/batch + 親の Distributed Map 自体の transition。月 10 イベントでも $2 未満なので許容
- 既存 `Deployments` DDB に蓄積された deploy 履歴データは migration 不可 (CFn が持ってるから捨てる、もしくは read-only で保持して新規はそちらに書かない)
- 新規 `Problems` DDB + S3 bucket + 3 つの state machine + EventBridge Rule で CFn template が +30 リソース程度太る
- 並列度 50 では Acceptance Criteria の「1 hour 以内」は未達 (~2h)。CFn template 最適化と組合せでカバー、達成できなければ SLO 緩和または並列度上げの検討

## Alternatives considered

### Alt-A: Lambda fan-out (SQS) で順次起動

- ❌ Lambda 15 分 timeout で CFn 完了待ちが詰まる
- ❌「Lambda 起動中に CFn が終わらないと別途 polling Lambda が要る」の罠

### Alt-B: CodeBuild で実行

- ❌ コンテナ起動 30 秒 × N の overhead
- ❌ 状態機械を bash で書くことになり、retry / 並列度の制御が貧弱
- △ 任意 script を実行できるのは利点だが、現スコープでは不要 (CFn API を呼ぶだけ)

### Alt-C: ECS Task / Fargate

- ❌ Container infra が増える (network / cluster / task definition の運用負荷)
- ❌ 起動 latency が deploy あたり 30〜60 秒上乗せ

### Alt-D: AWS Service Catalog

要件文書 (`docs/requirements/problem-deploy.md`) の「Service Catalog 採否の判断基準」セクションで詳細評価済み。

- ❌ NFR-3 (野良 AWS account 許容) で Service Catalog の AWS Organizations 単位 portfolio 共有が使えない
- ❌ NFR-2 (operator が AWS Console を見ない) で Service Catalog の主 UI が直接使えない
- △ provisioning engine 専用利用は技術的に可能だが、UI を SaaS 側で作る以上 Service Catalog のメリット (admin UI / portfolio 管理) が消える

→ Step Functions Distributed Map が決定打。

### Alt-E: Standard Map で並列起動 (本 ADR の前案)

- ❌ 256 KB 入力上限で 750 件が入らない (FR-1 違反)
- ❌ MaxConcurrency が最大 40

→ Distributed Map に切り替えた。

## Migration plan

実装の優先順位は **「まず MVP (Walking Skeleton) を 1 本通す → 動くことを確認してから多機能化」** とする。これは「実装はまず既存の Application 画面から Deploy 開始ボタンを押したら Step Functions が起動して問題が deploy される、を目指す」という運用方針。

### Phase 1a: MVP-0 — シェルで CFn deploy が通ることを確認する

**PR-1.5 (MVP-0)**: `scripts/deploy-battles.sh` (= 引数に問題フォルダを取り、順次 CFn deploy する shell script) と `make deploy-battles` ターゲットを追加し、AWS CLI セッションから「`problems/<id>/template.yaml` を CFn deploy → smoke 動作確認 → `make destroy-battles` で teardown」までできる状態を作る。

**狙い**: SaaS 配線 (Step Functions / EventBridge / tenant API / Cognito) を一切持ち込まず、**まず CFn template 自体と AWS 権限の正しさを smoke test する**。スクリプトとして deploy ロジックが固まれば、Phase 1b の orchestration はそのスクリプトをそのまま実行する形に乗せ替えるだけで済む。これは SBT の `BashJobRunner` (CodeBuild が provision-tenant.sh を実行する) と同じパターン。

含める要素は次のとおり。

- `scripts/deploy-battles.sh` (新規): 引数 1 個以上で問題ディレクトリ (`problems/battles/security-battle-royale` 等) を受け取り、各々を順次 `aws cloudformation deploy` で同一 account に deploy する。teamSlug は env か引数で受ける
- `scripts/destroy-battles.sh` (新規): 同じ引数で `aws cloudformation delete-stack` を順次呼ぶ
- `Makefile` に `deploy-battles` / `destroy-battles` ターゲットを追加 (内部で上のシェルを呼ぶ。default 引数は `problems/battles/security-battle-royale demo-team`)
- これは「開発者が deploy 機構を smoke test するためのツール」であり、operator UX には繋がらない (operator は引き続き旧 UI 経路を使う)

含めない要素 (Phase 1b 以降に倒す)。

- Step Functions / EventBridge / CodeBuild / tenant API / Cognito 関連の変更
- 既存 `ProblemDeployBackendStack` の構成変更 (= 旧経路はそのまま放置)
- frontend の変更
- bulk operation の並列化 (sequential ループのみ。並列化は Phase 2 の Distributed Map で扱う)

完了条件 (PR-1.5 の DoD) は次のとおり。

- `make deploy-battles` を流すと CFn stack が立ち、`security-battle-royale` の EC2 + nginx + Flask api + MySQL が動く (frontend URL が 200 を返す)
- `make destroy-battles` で stack が消える (`DeleteStack` が成功)
- 引数で複数問題を渡したときに順次 deploy される
- 両 target が developer の AWS CLI セッションで実行できる (operator は使わない)

### Phase 1b: MVP-1 — 既存 UI の Deploy ボタンを Step Functions 経路に切り替える

**PR-2 (MVP-1)**: 既存 UI の「Deploy 開始」ボタンを押すと、(問題 1 × **同一 TenkaCloud AWS account 内**) で Step Functions が起動して CFn deploy が成功するところまでを 1 PR で繋げる。**MVP-1 でも cross-account を持ち込まない** — TenkaCloud 自社 AWS account 内に CFn stack を立てるだけ。これで「publish 経路 → Step Functions → CFn」のパス自体が動くことを証明する。cross-account / AssumeRole / ExternalId は Phase 2 (PR-3 以降) で重ねる。

含める要素は次のとおり。

- `ProblemTemplatesBucket` (S3 bucket) を `ProblemDeployBackendStack` 配下に新規作成 (versioning + lifecycle で旧版 30 日保持)
- `install.sh` (= `make deploy`) に **repo の `problems/` ディレクトリ全体を `ProblemTemplatesBucket` へ sync する step** を追加 (`aws s3 sync problems/ s3://.../problems/`)。State Machine は `s3://.../problems/<id>/template.yaml` を CFn `TemplateURL` で参照する
- 既存問題 (`security-battle-royale`) は CFn UserData が GitHub から Git clone して app コード (Flask api / MySQL-init / frontend) を取得する作りなので、**MVP では `template.yaml` を S3 に置くだけで動く**。`RepoUrl` / `RepoRef` はデフォルト値 (public TenkaCloud repo) を使う。private repo / S3 直配信が必要な問題種別への対応は Phase 2 で検討 (Open question 5 として後述)
- `TenantTemplateStack` の REST API に Cognito authorizer + `POST /problems/{problemId}/deploy` route を追加 (要件 FR-2 Create の単発経路)
- 同 route が tenant API Lambda を呼ぶ。Lambda は Zod validate → S3 上の template URL を解決 → `events:PutEvents` で `DeployCreateRequested` を発行 (event detail に `templateUrl` を載せる)
- EventBridge Rule (`source: tenkacloud.deploy`、`detail-type: DeployCreateRequested`) を作り、Target に `DeployCreateStateMachine` を設定
- `DeployCreateStateMachine` は Distributed Map (要件 FR-1 を満たすが MVP では `deployments` 配列の長さ 1 しか入らない)。Map iterator は **同一 account 内で** `CloudFormation:CreateStack` (`TemplateURL` で S3 上の template を指す) を `.sync` で完了待ち → 完了レポート (AssumeRole なし)
- State Machine の execution role は CFn CreateStack / DescribeStacks を **同一 account 内のみ** に許可する単純な policy (cross-account は Phase 2 で追加)
- `application-admin-console` の `useDeployApiClient` を `useApiClient` に切り替え、既存 `DeployFormModal` から新経路を叩く
- DeployForm の `awsAccountId` 入力は MVP では使わない (= TenkaCloud 自社 account に固定)。input 自体は残しておくが値を Step Functions に渡さない、ような UI 上の degrade で十分
- 旧 `DeployApiGateway` (専用 HTTP API + 別 Cognito) は **同 PR で削除する** (旧経路と並存させない、=「動く 1 本」だけが残る状態にする)
- 旧 `DeployWorkerLambda` / `StatusUpdaterLambda` も同 PR で削除 (Step Functions が肩代わりするため)
- `install.sh` の `cdk deploy` リストに `ProblemDeployBackendStack` を追加
- frontend の `deployApiBaseUrl` / `isDeployApiConfigured` / `runtime-config.deployApiUrl` を削除

含めない要素 (Phase 2 に倒す)。

- 問題カタログ DDB / S3 (= 既存の repo `problems/<id>/template.yaml` をそのまま使う、`templateS3Url` は CFn template 直アップロードで代用)
- bulk operation (deployments 配列は length=1 固定)
- Update / Delete / Read fan-out
- 失敗時の部分 retry UX (失敗したら再投げのみ、UI は単純なエラー表示)
- ParticipantSessions DDB 改称 (現 `Deployments` テーブル名のまま、ただし deploy 状態列は使わない)

完了条件 (PR-2 の DoD) は次のとおり。

- `make deploy` 1 発で AWS 上の経路が立ち上がる
- application-admin-console から「Deploy」ボタン → 競技者アカウントに CFn stack が作られる
- operator は AWS Console / CLI を一切触らない

### Phase 2: 多機能化 (MVP が動いてから着手)

PR-2 の MVP が main に入ったら、要件の残りを順に実装する。順序は要件側の依存と Open questions 解決順に従う。

1. **PR-3: ADR-002 (Cross-account federation)** + 競技者アカウント登録 UI / DDB / SSM SecureString。Issue (#459) の決着
2. **PR-4: ADR-003 (問題カタログ + 可視範囲) + `ProblemsTable` (DDB) + `ProblemTemplatesBucket` (S3) + 問題管理 API + UI**。FR-5 の authoring 基盤
3. **PR-5: bulk Create**。`POST /deployments` で `deployments[]` を 750 件まで受け取れるようにし、UI で「複数選択 → 一括 Deploy」を生やす。内部実装は PR-2 の Distributed Map をそのまま使う (entry 数だけ増える)
4. **PR-6: `DeployDeleteStateMachine` + Delete API + UI 「batch を Delete」**。FR-1 (event 終了時 bulk teardown) の経路
5. **PR-7: `DeployUpdateStateMachine` + Update API + UI**。FR-5 (authoring iteration) の単発 Update
6. **PR-8: `GET /deployments` の sync Lambda (cross-account DescribeStacks fan-out)**。FR-3 (operator が状況を画面で見る)
7. **PR-9: 失敗 item 再実行 UX**。FR-3 の「失敗した分だけ再実行」ボタン
8. **PR-10: `Deployments` → `ParticipantSessions` 改称 + deploy 状態列削除**。data model 整理

各 PR は依然 `INVARIANT_PR_SHIPS_WORKING_INCREMENT` を満たす。Phase 2 の各 PR は MVP の上に機能を「積み増す」形なので、merge ごとに operator から見える機能が 1 つ増える。

## Open questions (本 ADR の scope 外、後続で確定する)

- **Cross-account federation の保存場所** (Issue (#459)) — 競技者アカウントごとの ExternalId / RoleName / region をどこに持つか。Step Functions の入力に含めるための前提なので、本 ADR の実装着手 (PR-4 以降) 前に Issue (#459) を ADR-002 として別途確定する必要がある
- **`org-shared` の "組織" の定義** (要件 Open Question 1) — tenant のグループか、tenant 内の team か、ACL 列か。問題カタログ実装 (PR-3) 前に ADR-003 で確定する
- **batch SLO の具体値** (要件 Open Question 4) — 並列度 50 で `~2h` という見積もりが要件として許容されるか、operator にフィードバックを取る
- **失敗 item 再実行 API の冪等性** — CFn `CreateStack` の `AlreadyExists` をどう扱うか (成功扱い / 別エラー扱い)、再実行で stackName が衝突する場合の解決方針
- **`ParticipantSessions` DDB の cleanup policy** — CFn `DeleteStack` 成功後、`teamLoginKey` / `displayTeamName` 等の participant 体験用 row はいつ削除するか。「競技履歴として保持」と「DeleteStack 成功イベントで cascade 削除」の 2 案を PR-10 で確定する
- **問題テンプレ依存ファイルの bundle 方式** (Phase 2) — 現在の問題 (`security-battle-royale`) は EC2 UserData の `git clone` で public TenkaCloud repo から app コード (Flask API / MySQL-init / frontend) を取ってくる作り。MVP では `template.yaml` だけ S3 に置けば動くが、private repo / 機密 / Lambda code zip 同梱が必要な問題が将来増えたとき、依存ファイル全体を S3 に bundle して UserData が `aws s3 cp` で取りに行く方式への切替が必要。問題種別ごとのテンプレ規約を整理する別 ADR で扱う

## References

- [`docs/requirements/problem-deploy.md`](../requirements/problem-deploy.md) — 本 ADR が満たすべき要件 (FR-1〜6 / NFR-1〜4 / Acceptance Criteria)
- Issue (#458) — Deploy 操作の publish 経路を SBT 同型 (tenant API + tenant Cognito) に統一する (本 ADR がスコープを拡張して supersede)
- Issue (#459) — Cross-account federation の保存・管理 (ADR-002 で決める)
- CLAUDE.md — `ONE_PASS_AWS` invariant、`INVARIANT_AUTH_INJECTED_AT_INFRA_LAYER`
- `docs/architecture/harness.md` — 既存 invariant 群
- AWS docs: [Step Functions Distributed Map](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-asl-use-map-state-distributed.html)
- AWS docs: [EventBridge → Step Functions Rule](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-amazon-eventbridge.html)
