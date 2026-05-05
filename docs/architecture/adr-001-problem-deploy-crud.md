# ADR-001: 問題 Deploy を CRUD x Step Functions Distributed Map で実装する

- **Status**: Proposed (2026-05-05)
- **Requirements**: [`docs/requirements/problem-deploy.md`](../requirements/problem-deploy.md) の確定後に書き直し
- **Supersedes**: 既存 `ProblemDeployBackendStack` の `DeployApiGateway` (専用 HTTP API + 単一 Cognito JWT authorizer) と `DeployWorkerLambda` (1 event = 1 CFn deploy) 構成
- **Related issues**: #458 (publish 経路統一)、#459 (cross-account federation)

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

**Lambda は EventBridge に publish し、Step Functions は EventBridge Rule で event-driven に起動する**。Step Functions は EventBridge Rule の Target として直接設定可能 ([ドキュメント](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-amazon-eventbridge.html))。tenant API Lambda が StartExecution を直叩きせず EventBridge を中継する理由は次の 4 点。

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
- **stack の所在カタログ** (operator UI の「自テナントの deploy 一覧」) → **CFn stack の Tag** (`TenkaCloud:TenantId`, `BatchId`, `ProblemId`, `JobId`) を参照する。Tag filter で逆引きする
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

- Step Functions Distributed Map の課金: child execution 単価。750 件 × 4 transitions × $0.025/1000 ≈ $0.075/batch。GameDay 規模 (月 10 イベント) で月 $1 未満
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

### Phase 1: MVP (Walking Skeleton) — 1 PR で end-to-end 1 経路を通す

**PR-2 (MVP)**: 既存 UI の「Deploy 開始」ボタンを押すと、(問題 1 × アカウント 1) で Step Functions が起動して CFn deploy が成功するところまでを 1 PR で繋げる。

含める要素は次のとおり。

- `TenantTemplateStack` の REST API に Cognito authorizer + `POST /problems/{problemId}/deploy` route を追加 (要件 FR-2 Create の単発経路)
- 同 route が tenant API Lambda を呼ぶ。Lambda は Zod validate → `events:PutEvents` で `DeployCreateRequested` を発行
- EventBridge Rule (`source: tenkacloud.deploy`、`detail-type: DeployCreateRequested`) を作り、Target に `DeployCreateStateMachine` を設定
- `DeployCreateStateMachine` は Distributed Map (要件 FR-1 を満たすが MVP では `deployments` 配列の長さ 1 しか入らない)。Map iterator は `AssumeRole` → `CloudFormation:CreateStack` (`.sync`) → 完了レポート
- 競技者 IAM Role / ExternalId は `bin/infrastructure.ts` の env から渡す既存方式を流用 (#459 の解決前なのでハードコード気味、Phase 2 で改善)
- `application-admin-console` の `useDeployApiClient` を `useApiClient` に切り替え、既存 `DeployFormModal` から新経路を叩く
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

1. **PR-3: ADR-002 (Cross-account federation)** + 競技者アカウント登録 UI / DDB / SSM SecureString。Issue #459 の決着
2. **PR-4: ADR-003 (問題カタログ + 可視範囲) + `ProblemsTable` (DDB) + `ProblemTemplatesBucket` (S3) + 問題管理 API + UI**。FR-5 の authoring 基盤
3. **PR-5: bulk Create**。`POST /deployments` で `deployments[]` を 750 件まで受け取れるようにし、UI で「複数選択 → 一括 Deploy」を生やす。内部実装は PR-2 の Distributed Map をそのまま使う (entry 数だけ増える)
4. **PR-6: `DeployDeleteStateMachine` + Delete API + UI 「batch を Delete」**。FR-1 (event 終了時 bulk teardown) の経路
5. **PR-7: `DeployUpdateStateMachine` + Update API + UI**。FR-5 (authoring iteration) の単発 Update
6. **PR-8: `GET /deployments` の sync Lambda (cross-account DescribeStacks fan-out)**。FR-3 (operator が状況を画面で見る)
7. **PR-9: 失敗 item 再実行 UX**。FR-3 の「失敗した分だけ再実行」ボタン
8. **PR-10: `Deployments` → `ParticipantSessions` 改称 + deploy 状態列削除**。data model 整理

各 PR は依然 `INVARIANT_PR_SHIPS_WORKING_INCREMENT` を満たす。Phase 2 の各 PR は MVP の上に機能を「積み増す」形なので、merge ごとに operator から見える機能が 1 つ増える。

## Open questions (本 ADR の scope 外、後続で確定する)

- **Cross-account federation の保存場所** (#459) — 競技者アカウントごとの ExternalId / RoleName / region をどこに持つか。Step Functions の入力に含めるための前提なので、本 ADR の実装着手 (PR-4 以降) 前に #459 を ADR-002 として別途確定する必要がある
- **`org-shared` の "組織" の定義** (要件 Open Question 1) — tenant のグループか、tenant 内の team か、ACL 列か。問題カタログ実装 (PR-3) 前に ADR-003 で確定する
- **batch SLO の具体値** (要件 Open Question 4) — 並列度 50 で `~2h` という見積もりが要件として許容されるか、operator にフィードバックを取る
- **失敗 item 再実行 API の冪等性** — CFn `CreateStack` の `AlreadyExists` をどう扱うか (成功扱い / 別エラー扱い)、再実行で stackName が衝突する場合の解決方針

## References

- [`docs/requirements/problem-deploy.md`](../requirements/problem-deploy.md) — 本 ADR が満たすべき要件 (FR-1〜6 / NFR-1〜4 / Acceptance Criteria)
- Issue #458 — Deploy 操作の publish 経路を SBT 同型 (tenant API + tenant Cognito) に統一する (本 ADR がスコープを拡張して supersede)
- Issue #459 — Cross-account federation の保存・管理 (ADR-002 で決める)
- CLAUDE.md — `ONE_PASS_AWS` invariant、`INVARIANT_AUTH_INJECTED_AT_INFRA_LAYER`
- `docs/architecture/harness.md` — 既存 invariant 群
- AWS docs: [Step Functions Distributed Map](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-asl-use-map-state-distributed.html)
- AWS docs: [EventBridge → Step Functions Rule](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-amazon-eventbridge.html)
