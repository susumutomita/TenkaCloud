# ADR-011: SBT Control Plane と二層 Application Plane 構成

- **Status**: Accepted
- **Date**: 2026-04-13
- **Deciders**: susumutomita

## Context

これまでのテナントプロビジョニングは「ハリボテ」だった。`tenant-management` サービスが DynamoDB へ書き込み、EventBridge へイベントを流すところまでは実装されていたが、そのイベントを受けて実際にテナント用 AWS リソースを作成するコンポーネントが存在しなかった。

また、GameDay 競技環境のデプロイ（問題スタックのチーム配布）も `problem-service` がイベントを発行するだけで、実際に CloudFormation / CDK を実行する仕組みがなかった。

さらに TenkaCloud は以下の 3 つの関心事を持つため、Application Plane が二段構成になることが明らかになった。

1. **テナントアプリプロビジョニング** — テナント登録時に GameDay アプリ環境を自動構築する
2. **問題デプロイエンジン** — 競技開始時にチームごとの問題スタック（AWS リソース）を展開する

これらは異なるイベントで駆動され、異なるデプロイ対象を持つため、単一の Application Plane では表現しにくい。

## Decision

### 1. インフラは CDK + SBT で構築する

Terraform は Auth0 依存の問題や「デプロイ実行コンポーネント」の欠如が明らかになったため廃止し、`@cdklabs/sbt-aws` を使った CDK スタックに一本化する。SBT はコントロールプレーンの定型実装（Cognito, API GW, EventBridge, テナント管理 Lambda）を提供し、Application Plane の実行基盤（CodeBuild による任意スクリプト実行）も持つ。

### 2. Control Plane は SBT をそのまま使う

```
ControlPlaneStack
  ├── CognitoAuth        — テナント管理者認証
  └── ControlPlane (SBT) — テナント CRUD API + EventBridge バス
        └── eventManager  — 全イベントの中継点
```

`systemAdminEmail` など環境依存パラメータは CDK コンテキスト (`-c key=value`) で渡す。

### 3. Application Plane を二層に分ける

```
EventBridge バス (SBT が管理)
  │
  ├── tenant.provisioned
  │       ↓
  │   CoreApplicationPlane: TenantAppPlane
  │       └── ScriptJob → CodeBuild
  │                          └── テナント用 GameDay アプリ環境をデプロイ
  │
  └── problem.deploy.requested  ← カスタムイベント
          ↓
      CoreApplicationPlane: ProblemDeployPlane
          └── ScriptJob → CodeBuild
                             └── チームごとの問題スタックをデプロイ
                                 (CloudFormation / CDK)
```

SBT の `EventManager.createCustomEvent(detailType, source)` を使うことで、SBT が定義済みのテナントライフサイクルイベント以外の独自イベントも同一バスに登録できる。各 `CoreApplicationPlane` は `ScriptJob` を介して「どのイベントで何を実行するか」を差し替え可能な構造になっている。

### 4. クロスアカウント権限引き受け

問題デプロイのターゲットは TenkaCloud 管理アカウントとは**別のチーム用 AWS アカウント**になる。CodeBuild はデプロイ前に STS `AssumeRole` でそのアカウントの権限を引き受ける必要がある。

```
TenkaCloud 管理アカウント (CodeBuild)
  │
  └── sts:AssumeRole (ExternalId 付き)
        ↓
  チーム AWS アカウント
    └── IAM Role: tenkacloud-problem-deploy-role
          ├── Trust Policy: 管理アカウント ID からの AssumeRole を許可
          └── Permission: CloudFormation, S3, EC2 等（問題に必要なリソース）
```

**イベント payload に含める情報:**

```json
{
  "problemId": "...",
  "teamId": "...",
  "tenantId": "...",
  "targetRoleArn": "arn:aws:iam::TEAM_ACCOUNT_ID:role/tenkacloud-problem-deploy-role",
  "externalId": "eventId-accountId から自動生成"
}
```

**CodeBuild スクリプトの流れ:**

```bash
# 1. クロスアカウントの権限を取得
CREDS=$(aws sts assume-role \
  --role-arn "$TARGET_ROLE_ARN" \
  --role-session-name "tenkacloud-problem-deploy" \
  --external-id "$EXTERNAL_ID")

export AWS_ACCESS_KEY_ID=$(echo $CREDS | jq -r '.Credentials.AccessKeyId')
export AWS_SECRET_ACCESS_KEY=$(echo $CREDS | jq -r '.Credentials.SecretAccessKey')
export AWS_SESSION_TOKEN=$(echo $CREDS | jq -r '.Credentials.SessionToken')

# 2. チームアカウントに問題スタックをデプロイ
cdk deploy ProblemStack-$PROBLEM_ID-$TEAM_ID --require-approval never
```

`ExternalId` は ADR-009 の方針に従い `eventId + accountId` から生成し、不正な AssumeRole を防ぐ（Confused Deputy 対策）。

### 5. アプリ側との境界

| 層 | 担当 |
|---|---|
| `problem-service` | EventBridge に `problem.deploy.requested` を発行（`targetRoleArn` 含む） |
| `ProblemDeployPlane` (CDK) | イベントを受けて CodeBuild でクロスアカウントデプロイを実行 |
| `problem-service` | 完了イベント (`problem.deploy.completed`) を受けてステータス更新 |

アプリコードはイベントを投げたら終わりにでき、インフラ側の実行基盤とアプリ側のビジネスロジックが疎結合になる。

## Consequences

- **Good**: テナントプロビジョニングと問題デプロイの「ハリボテ」が解消される。EventBridge を中心に疎結合なイベント駆動アーキテクチャが整う。SBT のコンストラクトを使うことでテナント管理の定型実装を自分で書かずに済む。
- **Good**: Application Plane を二層に分けることで、テナントライフサイクルと問題デプロイの関心事が分離され、それぞれ独立してスケール・修正できる。
- **Bad**: CDK と SBT の習熟コストがかかる。SBT のコンストラクト内部ロジック（Lambda コードのハッシュ固定等）は上書きできないため、SBT の想定外のユースケースは自前実装が必要。
- **Tradeoff**: Terraform の既存モジュールは廃止。移行コストはあるが、CodeBuild 実行基盤を自前で整備するコストと比較すると SBT を使う方が小さい。

## References

- [infrastructure/cdk/lib/control-plane.ts](../../infrastructure/cdk/lib/control-plane.ts)
- [@cdklabs/sbt-aws README](https://github.com/awslabs/sbt-aws/blob/main/docs/public/README.ja.md)
- [SBT CoreApplicationPlane](https://github.com/awslabs/sbt-aws/blob/main/src/core-app-plane/core-app-plane.ts)
- [SBT EventManager](https://github.com/awslabs/sbt-aws/blob/main/src/utils/event-manager.ts)
- [ADR-009: AWS 問題デプロイメントエンジン](./009-application-admin-isolation-and-aws-deployment-engine.md)
