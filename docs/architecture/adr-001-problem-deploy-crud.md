# ADR-001: 問題 Deploy を CRUD × Step Functions で再設計する

- **Status**: Proposed (2026-05-05)
- **Supersedes**: 既存 `ProblemDeployBackendStack` の `DeployApiGateway` (専用 HTTP API + 単一 Cognito JWT authorizer) と `DeployWorkerLambda` (1 event = 1 CFn deploy) 構成
- **Related issues**: #458 (publish 経路統一)、#459 (cross-account federation)

## Context

`ProblemDeployBackendStack` は **(a) 専用 HTTP API + 別 Cognito JWT authorizer** + **(b) 1 event = 1 Lambda invocation = 1 CFn deploy** という単発前提で書かれている。本構造は現状次の問題を抱える。

- 単一 User Pool 信頼で multi-tenant SaaS (pooled / silo) と整合しない (#458)
- `install.sh` が `ProblemDeployBackendStack` を deploy していない (operator が手動で env を export する設計になっている)
- 1 deploy = 1 イベント = 1 Lambda 起動なので bulk operation が不可能 (operator は GameDay で N 問 × M チームを捌く)
- Lambda 15 分 timeout の壁がある。CFn deploy は 5〜30 分かかるので Lambda 起動中に CFn が終わらないと「成功したのに Lambda 落ちた」状態になる。

## Decision

問題 Deploy を **CRUD 4 操作 × Step Functions の batch 処理** として再設計する。

### 1. publish 経路は tenant API + tenant Cognito + EventBridge → Step Functions

```
[application-admin-console (ログイン済)]
        ↓ POST /deployments/{operation}  with tenant Cognito JWT
[TenantTemplateStack の REST API]
        ↓ Lambda が events:PutEvents を呼ぶ
[EventBridge bus (= ControlPlaneStack.eventBusArn)]
        ↓ EventBridge Rule (detail-type で分岐)
[Step Functions State Machine (operation ごとに 1 つ)]
        ↓ 各 (problem × account) を Map iterator で処理
[CFn API (cross-account AssumeRole 経由)]
```

専用 HTTP API + 別 Cognito の構成は廃止。tenant 自身の Cognito で認可する (= SBT の Control Plane → Application Plane と同型)。

**Lambda は EventBridge に publish し、Step Functions は EventBridge Rule で event-driven に起動する**。Step Functions は EventBridge Rule の Target として直接設定可能 ([ドキュメント](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-amazon-eventbridge.html))。tenant API Lambda が StartExecution を直叩きせず EventBridge を中継する理由は次の 4 点。

1. **疎結合の seam を残す**: 将来の audit log / Slack 通知 / 監視 subscriber が同じ event を listen できる
2. **SBT の既存パターンとの整合**: ControlPlane → ApplicationPlane の `onboardingRequest` event 中継と同じ形を維持
3. **Replay / archive**: EventBridge archive で event を後から replay できる
4. **権限境界の整理**: tenant API Lambda は `events:PutEvents` だけ持てば良く、`states:StartExecution` 権限を渡す必要がない

EventBridge detail-type は operation ごとに分ける (`DeployCreateRequested` / `DeployUpdateRequested` / `DeployDeleteRequested`)。Read は同期応答が必要なので EventBridge を経由せず、tenant API Lambda が直接 cross-account `cloudformation:DescribeStacks` を fan-out する。

### 2. CRUD 4 操作を 3 つの event-driven state machine + 1 つの sync Lambda で表現する

| 操作 | 用途 | API | 経路 | 内部 |
|---|---|---|---|---|
| **Create** | 新規 deploy (複数問題 × 複数アカウント) | POST /deployments/bulk-create | EventBridge (`DeployCreateRequested`) → `BulkCreateStateMachine` | Map → AssumeRole → CFn CreateStack → .sync |
| **Read** | 状況確認 (cross-account fan-out aggregation) | GET /deployments | sync Lambda (cross-account `cloudformation:DescribeStacks` fan-out) | EventBridge 経由しない (同期応答が必要) |
| **Update** | template の更新を既 deploy に push | POST /deployments/bulk-update | EventBridge (`DeployUpdateRequested`) → `BulkUpdateStateMachine` | Map → AssumeRole → CFn UpdateStack → .sync |
| **Delete** | cleanup | POST /deployments/bulk-delete | EventBridge (`DeployDeleteRequested`) → `BulkDeleteStateMachine` | Map → AssumeRole → CFn DeleteStack → .sync |

3 つの state machine は同じ shape の Map iterator を持つ。違いは inner step の CFn API (CreateStack / UpdateStack / DeleteStack) だけ。各 state machine 専用の EventBridge Rule を 1 つ立て、Target を該当 state machine に設定する。

### 3. Spec cap で size 問題を回避する

API request 時に Zod で次のように cap する。

- 1 リクエスト最大 500 entries (= problems × accounts)
- 個別軸: max 10 problems × max 50 accounts (操作上の現実的上限)

これを超える運用は複数バッチに分割する。実装側は size を考慮しない。

### 4. 失敗時は continue + summary

state machine の Map state に `Catch` で per-item 失敗を吸収。最後に `{ ok: N, failed: M, errors: [...] }` を返す。1 アカウントの IAM 不備で全 batch が止まる挙動は避ける (GameDay 想定)。

### 5. 並列度は MaxConcurrency: 10 を default

完全 sequential (1 並列) は 500 entry × 5 min = 41 時間で非現実的。`MaxConcurrency: 10` で 4 時間程度。Step Functions の同時実行 quota (1,000) には遠く及ばない。

### 6. State の所在: CFn が source of truth、DDB は participant 体験用のみ

- **deploy 状態** (PENDING / IN_PROGRESS / CREATE_COMPLETE / FAILED) → **CFn 自身が持つ**。`describe-stacks` で取得。
- **deploy 履歴** (誰がいつ batch を投げたか) → **Step Functions execution history** (Standard で 1 年保持)。
- **stack の所在カタログ** (operator UI の「自テナントの deploy 一覧」) → **CFn stack の Tag** (`TenkaCloud:TenantId`, `BatchId`, `ProblemId`)。Tag filter で逆引き。
- **participant 体験用 state** (teamLoginKey、displayTeamName、将来のスコア) → **DDB `ParticipantSessions` テーブル** (現 `Deployments` テーブルから deploy 状態列を全部削除して縮小・改称)。

つまり **既存 `Deployments` DDB の deploy 状態列 (status / failureReason / stackOutputs) は全廃止**。CFn が持っているものを DDB に複製しない。

### 7. 既存 stack / Lambda の整理

| Construct | 扱い |
|---|---|
| `ProblemDeployBackendStack.DeployApiGateway` | **削除** (専用 HTTP API 廃止) |
| `ProblemDeployBackendStack.DeployApiLambda` | tenant API から呼び出される **「StartExecution + 入力 validation」薄 Lambda** にダイエット |
| `ProblemDeployBackendStack.DeployWorkerLambda` | **廃止** (Step Functions が直接 CFn を呼ぶ) |
| `ProblemDeployBackendStack.StatusUpdaterLambda` | **廃止** (CFn 自身が状態保持、polling は不要) |
| `ProblemDeployBackendStack.DeploymentsTable` | **`ParticipantSessions` に改称 + 縮小** (deploy 状態列を全部削除、teamLoginKey / displayTeamName 等のみ残す) |
| `ProblemDeployBackendStack.ParticipantPortalLambda` / `ParticipantPortalHosting` | **継続** (本 ADR と独立) |
| `bin/infrastructure.ts` の `CDK_PARAM_DEPLOY_USER_POOL_ID` 周り | **削除** |
| `application-admin-console` の `deployApiBaseUrl` / `useDeployApiClient` / `isDeployApiConfigured` | **削除** (`apiBaseUrl` に統合) |
| `runtime-config.json.deployApiUrl` | **削除** (`apiUrl` のみ) |
| `install.sh` の `cdk deploy` リスト | `ProblemDeployBackendStack` を **追加** |

## Consequences

### 良くなること

- multi-tenant SaaS と整合する認可 (pooled / silo どちらの tenant も自身の Cognito で deploy 操作)
- bulk operation が UI 1 click で N 問 × M アカウントに飛ばせる
- Lambda 15 分 timeout の壁が消える (Step Functions `.sync` で CFn 完了を待つ)
- DDB schema が participant state だけになって責務が明確
- Step Functions Console から「ある batch が今どこまで進んでるか」「どの item で失敗したか」が GUI で見える
- `make deploy` 1 発で Deploy 機能まで通る (`ONE_PASS_AWS` invariant 達成)

### コスト・トレードオフ

- Step Functions Standard の課金 (state transition 単価。500 entry × 4 transition ≈ 2,000 transitions ≈ $0.05 / batch)。GameDay 規模では無視できる
- 既存 `Deployments` DDB に蓄積された deploy 履歴データは migration 不可 (CFn が持ってるから捨てる、もしくは read-only で保持して新規はそちらに書かない)
- 4 つの state machine + 関連 IAM Role が CFn template を太らせる (resource 数 +20 くらい)

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

- △ multi-account portfolio 共有が AWS native でできる
- ❌ 学習コストと運用ノウハウが増える (Service Catalog 自体の権限 / ポートフォリオ管理)
- ❌ tenant 拡張可能な問題カタログ (DDB) と Service Catalog 製品の二重管理になる

→ Step Functions Standard が決定打。CodeBuild は将来「問題テンプレを動的生成してから deploy」が必要になったときの escape hatch として残す (現時点では使わない)。

## Migration plan

PR 単位で以下を分割実装する。各 PR が `INVARIANT_PR_SHIPS_WORKING_INCREMENT` を満たすこと。

1. **PR-1: ADR commit** (本 PR)
2. **PR-2: tenant API に Cognito authorizer + 空 routes 追加**。実 Lambda 配線はまだ。Single deploy だけ動く形で旧 DeployApiGateway と並存
3. **PR-3: BulkCreateStateMachine + EventBridge Rule (`DeployCreateRequested`) + tenant API Lambda が `events:PutEvents`** 配線。`POST /deployments/bulk-create` で起動。旧 single-deploy と並存
4. **PR-4: BulkDeleteStateMachine + EventBridge Rule (`DeployDeleteRequested`) + bulk-delete API**。旧 DELETE と並存
5. **PR-5: GET /deployments の sync Lambda (cross-account DescribeStacks fan-out)**
6. **PR-6: BulkUpdateStateMachine + EventBridge Rule (`DeployUpdateRequested`) + bulk-update API**
7. **PR-7: 旧 DeployApiGateway / DeployWorkerLambda / StatusUpdaterLambda 廃止 + DDB 縮小 (Deployments → ParticipantSessions 改称)**
8. **PR-8: install.sh に ProblemDeployBackendStack を追加 + frontend cleanup (`deployApiBaseUrl` 撤去等)**

PR-2 から PR-6 までは旧経路と並存し、PR-7 で旧経路を一気に廃止する。これで途中の各 PR が main に merge されても production が壊れない。

## Open questions (本 ADR の scope 外)

- **Cross-account federation の保存場所** (#459) — 競技者アカウントごとの ExternalId / RoleName / region をどこに持つか。Step Functions の入力に含めるための前提なので、本 ADR の実装着手前に #459 を ADR-002 として別途決定する必要がある。
- **Problem catalog の DDB schema** (built-in repo + 拡張 DDB ハイブリッド、可視範囲モデル) — 本 ADR は「problem には S3 上の CFn template URL がある」を所与としている。問題カタログ自体の data model は別 ADR (ADR-003 予定)。
- **Read state machine vs sync Lambda の選択** — Read は同期で済むので Lambda でも可だが、cross-account fan-out で 50 アカウントを叩くと数十秒かかる。Step Functions に揃えると一貫するが、逆に「単一ジョブの状態確認」の latency が悪化する。実装時に reassess する。

## References

- Issue #458 — Deploy 操作の publish 経路を SBT 同型 (tenant API + tenant Cognito) に統一する (本 ADR がスコープを拡張して supersede)
- Issue #459 — Cross-account federation の保存・管理 (ADR-002 で決める)
- CLAUDE.md — `ONE_PASS_AWS` invariant、`INVARIANT_AUTH_INJECTED_AT_INFRA_LAYER`
- `docs/architecture/harness.md` — 既存 invariant 群
