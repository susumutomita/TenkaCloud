# TenkaCloud フルプラットフォーム完成 設計書

> Historical Plan
> この文書は 2026-02-09 時点の設計計画です。現行仕様の正本ではありません。現在のアーキテクチャ境界は [`docs/architecture/harness.md`](../architecture/harness.md) と [`docs/architecture/architecture.md`](../architecture/architecture.md) を参照してください。
> 特に `EKS`, `ECS`, `RDS`, `NAT Gateway` を Control Plane / tenant Application Plane の前提にする記述は、現行の `INVARIANT_SERVERLESS_ONLY` では採用しません。

## 概要

TenkaCloud のメインパス（テナント作成→ Application Plane 自動プロビジョニング→問題デプロイ→バトル→自動採点→リーダーボード）を完成させ、100 問の構築型問題を登録する。

## 決定事項

| 項目 | 決定 |
|------|------|
| スコープ | フルパス（テナント→プロビジョニング→問題→バトル→採点→リーダーボード） |
| デプロイ先 | LocalStack + AWS 同時進行 |
| IaC パターン | SBT（SaaS Builder Toolkit）準拠、`@cdklabs/sbt-aws` CDK constructs |
| 問題数 | 100 問、6 カテゴリ × 4 難易度に均等分布 |
| 問題タイプ | 構築型のみ（脆弱な環境は作らない） |
| 生成方法 | 手書きコア 18 問 + AI バリエーション 82 問 |
| セキュリティ | cfn-lint + checkov で全テンプレート自動検証 |

## アーキテクチャ

### SBT 準拠のイベントフロー

```
Control Plane                    EventBridge                 Application Plane
     │                               │                            │
     │  TenantOnboardingRequest ──▶  │  ──▶ ProvisioningScriptJob │
     │                               │       (CodeBuild/StepFn)   │
     │                               │                            │
     │  ◀── TenantProvisionSuccess   │  ◀──  export variables     │
     │  (tenant status → ACTIVE)     │                            │
```

### CDK スタック構成

```typescript
// infrastructure/cdk/lib/control-plane-stack.ts
const controlPlane = new sbt.ControlPlane(this, 'ControlPlane', {
  auth: auth0Auth,
  systemAdminEmail: props.adminEmail,
});

// infrastructure/cdk/lib/app-plane-stack.ts
const provisioningJob = new sbt.ProvisioningScriptJob(this, 'Provisioning', {
  eventManager,
  script: fs.readFileSync('./scripts/provision-tenant.sh', 'utf8'),
  environmentStringVariablesFromIncomingEvent: ['tenantId', 'tier', 'tenantName'],
  environmentVariablesToOutgoingEvent: {
    tenantData: ['tenantNamespace', 'tenantDbPrefix', 'tenantEndpoint'],
  },
  permissions: provisioningPolicy,
});

new sbt.CoreApplicationPlane(this, 'AppPlane', {
  eventManager,
  scriptJobs: [provisioningJob, deprovisioningJob],
});
```

### provision-tenant.sh の処理

1. K8s Namespace 作成（`kubectl create ns tenant-${tenantId}`）
2. Helm で Application Plane サービス群をデプロイ
3. DynamoDB テーブルにテナントプレフィックス設定
4. DNS レコード作成
5. 変数を export して `TenantProvisionSuccess` に載せる

### AWS 構成

```
Route 53 (*.tenkacloud.io)
  └─ ALB (Application Load Balancer)
       ├─ /control/*  → Control Plane (ECS/EKS)
       ├─ /{tenant}/* → Application Plane (EKS)
       └─ /api/*      → Backend Services (EKS)
```

### テナント分離（SBT Pool + Bridge モデル）

| リソース | 分離モデル | 理由 |
|---------|-----------|------|
| DynamoDB | Pool | 単一テーブル設計（GSI で効率的なクエリ） |
| S3 (問題データ) | Pool | プレフィックス分離 (`tenants/{tenantId}/`) |
| Lambda | Pool | 共有コンピュート、テナント ID でスコープ |
| S3 (Premium) | Silo | プレミアムティアのみ専用バケット |

## バトル・採点・リーダーボード

### バトルライフサイクル

```
作成(DRAFT) → 公開(OPEN) → 開始(RUNNING) → 終了(FINISHED) → アーカイブ(ARCHIVED)
```

### 採点フロー（構築型）

```
参加者の AWS アカウント
  ↓ AssumeRole (クロスアカウント)
Scoring Service
  ↓ AWS SDK で状態チェック
  ├─ S3 バケットの暗号化設定は正しいか？
  ├─ Security Group のルールは適切か？
  ├─ IAM ポリシーは最小権限か？
  └─ etc.
  ↓
スコア計算 (criteria × weight)
  ↓
DynamoDB に保存 → SSE でリアルタイム配信
```

### リーダーボード

- DynamoDB に `TENANT#xxx|LEADERBOARD#battle-id` として保存
- 個人ランキング + チームランキング
- バトル終了 N 分前にフリーズ（競技性確保）
- SSE で参加者・観客にリアルタイム配信

## 100問の設計

### 分布マトリックス

| カテゴリ | Easy | Medium | Hard | Expert | 計 |
|---------|------|--------|------|--------|-----|
| Architecture | 4 | 4 | 4 | 4 | 16 |
| Security | 4 | 4 | 4 | 4 | 16 |
| Cost | 4 | 4 | 4 | 4 | 16 |
| Performance | 4 | 4 | 4 | 4 | 16 |
| Reliability | 4 | 4 | 4 | 4 | 16 |
| Operations | 5 | 5 | 5 | 5 | 20 |

### カバーする AWS サービス

EC2, S3, Lambda, EKS, ECS, RDS, DynamoDB, CloudFront, Route53, IAM, VPC, ALB, WAF, KMS, CloudWatch, SNS, SQS, Step Functions, API Gateway, Secrets Manager

### 生成パイプライン

1. **手書きコア（18 問）**: 各カテゴリ 3 問、CloudFormation テンプレート付き
2. **AI バリエーション展開（82 問）**: コア問題をベースに対象サービス・条件を変えて生成
3. **自動検証**: cfn-lint + checkov で全テンプレートスキャン
4. **DB 投入**: 検証パスした問題を一括インポート

## ワークストリーム

### WS1: Infrastructure（IaC + デプロイパイプライン）

- CDK スタック作成（SBT ControlPlane + CoreApplicationPlane）
- EKS クラスター + VPC + ALB の Terraform/CDK
- CI/CD パイプライン（GitHub Actions → AWS デプロイ）
- LocalStack E2E テスト環境

### WS2: Backend Core（バトル・採点・リーダーボード）

- Battle Service: 競技セッション管理、参加者登録、チーム管理
- Scoring Service: クロスアカウント AssumeRole、AWS SDK 状態検証、スコア計算
- Leaderboard Service: DynamoDB 集計、SSE リアルタイム配信、フリーズ機能

### WS3: Frontend（参加者フロー + リアルタイム更新）

- 参加者ダッシュボード（バトル参加→問題閲覧→進捗確認）
- SSE でリアルタイムスコア更新
- リーダーボード表示

### WS4: Problem Generation（100問作成）

- 手書きコア問題 18 問
- AI バリエーション展開 82 問
- cfn-lint + checkov 自動検証
- 一括インポートスクリプト

### WS5: Integration（テナント→App Plane プロビジョニング）

- EventBridge イベント契約の実装
- ProvisioningScriptJob + provision-tenant.sh
- DeprovisioningScriptJob + deprovision-tenant.sh
- E2E フロー検証

## 実装フェーズ

### Phase 1: 縦串1本（LocalStack で E2E 通す）

1. CDK スタック作成（SBT の ControlPlane + CoreApplicationPlane）
2. provision-tenant.sh でテナントリソース作成
3. 問題 1 つを手書きで作成→デプロイ→採点が動く
4. `make e2e` で LocalStack 上のフルパスを検証
5. **成果物**: テナント作成→問題表示→採点→スコア表示が 1 本で通る

### Phase 2: AWS デプロイ + バトル機能

1. CDK を AWS 実環境にデプロイ（EKS クラスター + ALB）
2. Battle Service 完成（ライフサイクル管理、参加者登録）
3. Scoring Service 完成（AssumeRole でクロスアカウント検証）
4. Leaderboard Service 完成（リアルタイム SSE 配信）
5. **成果物**: AWS 上でバトルが開催できる状態

### Phase 3: 100問 + 仕上げ

1. 各カテゴリ 3 問 = 18 問を手書き（CloudFormation テンプレート付き）
2. AI バリエーション展開で 82 問生成
3. cfn-lint + checkov で全問自動検証
4. CI/CD パイプライン完成（GitHub Actions → AWS デプロイ）
5. **成果物**: 100 問が登録された本番稼働可能な状態

## リファレンス

- [AWS SaaS Builder Toolkit (sbt-aws)](https://github.com/awslabs/sbt-aws)
- [SBT Developer Guide](https://github.com/awslabs/sbt-aws/blob/main/docs/public/README.md)
- `reference/eks/` - EKS Reference Architecture（SBT 統合済み）
- `docs/design/phase2-sbt-tenant-isolation.md` - テナント分離設計
