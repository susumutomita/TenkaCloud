# Phase 2: SBT パターンによるテナント分離設計

## 概要

AWS SaaS Builder Toolkit (SBT) のパターンを TenkaCloud に適用し、マルチテナント分離を実現する。

## 現状分析

### 現在のアーキテクチャ

```
┌─────────────────────────────────────────────────────────────────┐
│                        Control Plane                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐   │
│  │   Next.js    │───▶│   DynamoDB   │───▶│ Provisioning     │   │
│  │   (Auth0)    │    │   (テナント)  │    │ Lambda           │   │
│  └──────────────┘    └──────────────┘    └──────────────────┘   │
│                             │                     │              │
│                        DynamoDB Stream       EventBridge         │
│                                                   │              │
│                                          TenantOnboarding        │
└─────────────────────────────────────────────────────────────────┘
```

### SBT パターン

```
Control Plane                              Application Plane
┌──────────────┐                          ┌──────────────────────┐
│ Tenant       │  onboardingRequest       │ Provisioning Job     │
│ Management   │─────────────────────────▶│ (CodeBuild/Lambda)   │
│ API          │                          │                      │
│              │  provisionSuccess        │ テナント固有リソース  │
│              │◀─────────────────────────│ の作成               │
└──────────────┘                          └──────────────────────┘
                     EventBridge
```

## 設計方針

### テナント分離モデル: Pool + Bridge

TenkaCloud は **Pool Model** を基本とし、特定要件を持つテナントには **Bridge Model** で Silo 化する。

| リソース | 分離モデル | 理由 |
|---------|-----------|------|
| DynamoDB | Pool | 単一テーブル設計（GSI で効率的なクエリ） |
| S3 (問題データ) | Pool | プレフィックス分離 (`tenants/{tenantId}/`) |
| Lambda | Pool | 共有コンピュート、テナント ID でスコープ |
| S3 (Premium) | Silo | プレミアムティアのみ専用バケット |

### イベント契約

SBT 標準フォーマットに準拠する。

```typescript
// Control Plane → Application Plane
interface TenantOnboardingEvent {
  source: "tenkacloud.control-plane";
  "detail-type": "TenantOnboarding";
  detail: {
    tenantId: string;
    tenantName: string;
    tier: "FREE" | "PRO" | "ENTERPRISE";
    slug: string;
    timestamp: string;
  };
}

// Application Plane → Control Plane
interface TenantProvisionedEvent {
  source: "tenkacloud.application-plane";
  "detail-type": "TenantProvisioned";
  detail: {
    tenantId: string;
    status: "COMPLETED" | "FAILED";
    resources: {
      s3Prefix?: string;
      dedicatedBucket?: string;
    };
    timestamp: string;
  };
}
```

## 実装計画

### Step 1: Application Plane Lambda の作成

EventBridge から `TenantOnboarding` イベントを受信し、テナントリソースをプロビジョニングする Lambda を作成。

```
backend/services/application-plane/tenant-provisioner/
├── src/
│   └── handler.ts
├── package.json
└── tsconfig.json
```

**処理フロー:**

1. `TenantOnboarding` イベント受信
2. テナントティアに応じたリソース作成
   - FREE/PRO: S3 プレフィックス作成（Pool）
   - ENTERPRISE: 専用 S3 バケット作成（Silo）
3. `TenantProvisioned` イベント発行
4. Control Plane が `provisioningStatus` を `COMPLETED` に更新

### Step 2: EventBridge ルールの追加

```hcl
# infrastructure/terraform/modules/tenant-provisioner/main.tf

resource "aws_cloudwatch_event_rule" "tenant_onboarding" {
  name           = "${var.name_prefix}-tenant-onboarding"
  event_bus_name = var.event_bus_name
  event_pattern = jsonencode({
    source      = ["tenkacloud.control-plane"]
    detail-type = ["TenantOnboarding"]
  })
}

resource "aws_cloudwatch_event_target" "tenant_provisioner" {
  rule           = aws_cloudwatch_event_rule.tenant_onboarding.name
  event_bus_name = var.event_bus_name
  target_id      = "tenant-provisioner"
  arn            = aws_lambda_function.tenant_provisioner.arn
}
```

### Step 3: Provisioning Lambda の更新

既存の Provisioning Lambda を更新し、`TenantProvisioned` イベントの受信処理を追加。

```typescript
// 既存: DynamoDB Stream → provisioningStatus = "PROVISIONING"
// 追加: TenantProvisioned イベント受信 → provisioningStatus = "COMPLETED"
```

### Step 4: テナントスコープアクセス（IAM）

Application Plane のサービスがテナントデータにアクセスする際、IAM ポリシーでスコープを制限。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::tenkacloud-data/tenants/${aws:PrincipalTag/tenantId}/*"
    }
  ]
}
```

## ファイル構成（追加予定）

```
backend/services/application-plane/
└── tenant-provisioner/
    ├── src/
    │   ├── handler.ts          # EventBridge ハンドラー
    │   ├── provisioners/
    │   │   ├── pool.ts         # Pool モデルプロビジョニング
    │   │   └── silo.ts         # Silo モデルプロビジョニング
    │   └── types.ts
    ├── package.json
    └── tsconfig.json

infrastructure/terraform/modules/
└── tenant-provisioner/
    ├── main.tf
    ├── variables.tf
    └── outputs.tf
```

## LocalStack でのテスト手順

```bash
# 1. テナント作成（Control Plane）
aws --endpoint-url=http://localhost:4566 dynamodb put-item \
  --table-name TenkaCloud-local \
  --item '{
    "PK": {"S": "TENANT#test-tenant"},
    "SK": {"S": "METADATA"},
    "id": {"S": "test-tenant"},
    "name": {"S": "Test Tenant"},
    "tier": {"S": "ENTERPRISE"},
    "provisioningStatus": {"S": "PENDING"}
  }'

# 2. Provisioning Lambda がトリガーされ TenantOnboarding イベント発行

# 3. Tenant Provisioner Lambda が受信し、Silo リソース作成

# 4. TenantProvisioned イベント発行

# 5. provisioningStatus = "COMPLETED" に更新
```

## 次のステップ

1. [x] tenant-provisioner Lambda の実装
2. [x] Terraform モジュールの作成
3. [x] EventBridge ルールの追加
4. [ ] LocalStack でのテスト（E2E フロー検証）
5. [x] 完了イベント受信処理の追加（provisioning-completion Lambda）

## 実装済みコンポーネント

### Application Plane

- `backend/services/application-plane/tenant-provisioner/`
  - EventBridge から `TenantOnboarding` イベントを受信
  - Pool/Silo モデルでリソースをプロビジョニング
  - `TenantProvisioned` イベントを発行

### Control Plane

- `backend/services/control-plane/provisioning/`
  - DynamoDB Stream から TENANT# レコード変更を検知
  - `TenantOnboarding` イベントを発行
  - provisioningStatus を PENDING → PROVISIONING に更新

- `backend/services/control-plane/provisioning-completion/`
  - EventBridge から `TenantProvisioned` イベントを受信
  - provisioningStatus を PROVISIONED または FAILED に更新

### Terraform モジュール

- `infrastructure/terraform/modules/tenant-provisioner/`
- `infrastructure/terraform/modules/provisioning-completion/`
