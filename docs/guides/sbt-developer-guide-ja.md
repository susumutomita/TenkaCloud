# SBT (SaaS Builder Toolkit) 開発ガイド 日本語版

## SBT とは

SBT は AWS CDK 上に構築されたマルチテナント SaaS アプリケーション開発キットです。Control Plane と Application Plane を一級概念として扱い、EventBridge でイベント駆動に連携します。

## アーキテクチャ概要

```
┌─────────────────────┐         ┌──────────────────────────┐
│   Control Plane     │         │   Application Plane      │
│                     │         │                          │
│  ┌───────────────┐  │         │  ┌────────────────────┐  │
│  │ CognitoAuth   │  │         │  │ CoreApplicationPlane│  │
│  │ (認証)         │  │         │  │                    │  │
│  └───────────────┘  │         │  │ ScriptJob          │  │
│  ┌───────────────┐  │  Event  │  │ (CodeBuild で実行)  │  │
│  │ ControlPlane  │──┼──Bridge─┼──│                    │  │
│  │ (テナント管理) │  │         │  │ provisioning.sh    │  │
│  │ (API Gateway) │  │         │  │ deprovisioning.sh  │  │
│  └───────────────┘  │         │  └────────────────────┘  │
│  ┌───────────────┐  │         │  ┌────────────────────┐  │
│  │ Billing (任意) │  │         │  │ あなたの SaaS アプリ │  │
│  └───────────────┘  │         │  └────────────────────┘  │
└─────────────────────┘         └──────────────────────────┘
```

## セットアップ手順

### 1. CDK プロジェクト作成

```bash
mkdir my-saas && cd my-saas
cdk init app --language typescript
npm install @cdklabs/sbt-aws
```

### 2. Control Plane を定義する (`lib/control-plane.ts`)

```typescript
import * as sbt from '@cdklabs/sbt-aws';
import { Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class ControlPlaneStack extends Stack {
  public readonly regApiGatewayUrl: string;
  public readonly eventManager: sbt.IEventManager;

  constructor(scope: Construct, id: string, props?: any) {
    super(scope, id, props);

    const cognitoAuth = new sbt.CognitoAuth(this, 'CognitoAuth', {
      enableAdvancedSecurityMode: false, // テスト用
      setAPIGWScopes: false,            // テスト用
    });

    const controlPlane = new sbt.ControlPlane(this, 'ControlPlane', {
      auth: cognitoAuth,
      systemAdminEmail: 'admin@example.com', // ← 実際のメールアドレスに変更
    });

    this.eventManager = controlPlane.eventManager;
    this.regApiGatewayUrl = controlPlane.controlPlaneAPIGatewayUrl;
  }
}
```

**作られるもの:**

- API Gateway（テナント管理 REST API）
- Cognito User Pool（管理者認証）
- Lambda 関数群（テナント CRUD）
- EventBridge バス（イベント配信）
- DynamoDB テーブル（テナント情報）

**初回デプロイ後、`systemAdminEmail` に仮パスワードが届きます。**

### 3. Application Plane を定義する (`lib/app-plane.ts`)

```typescript
import * as sbt from '@cdklabs/sbt-aws';
import * as cdk from 'aws-cdk-lib';
import { PolicyDocument, PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';

export interface AppPlaneProps extends cdk.StackProps {
  eventManager: sbt.IEventManager;
}

export class AppPlaneStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: AppPlaneProps) {
    super(scope, id, props);

    // テナント作成時に実行するジョブ
    const provisioningJob = new sbt.ProvisioningScriptJob(
      this, 'provisioningJob', {
        permissions: new PolicyDocument({
          statements: [new PolicyStatement({
            actions: ['cloudformation:*', 's3:*'],
            resources: ['*'],
            effect: Effect.ALLOW,
          })],
        }),
        script: `
echo "テナント作成開始: $tenantId (tier: $tier)"
# ここにテナント用リソースの作成処理を書く
export tenantStatus="created"
echo "完了"
`,
        environmentStringVariablesFromIncomingEvent: ['tenantId', 'tier'],
        environmentVariablesToOutgoingEvent: {
          tenantData: ['tenantStatus'],
        },
        eventManager: props.eventManager,
      }
    );

    // テナント削除時に実行するジョブ
    const deprovisioningJob = new sbt.DeprovisioningScriptJob(
      this, 'deprovisioningJob', {
        permissions: new PolicyDocument({
          statements: [new PolicyStatement({
            actions: ['cloudformation:*', 's3:*'],
            resources: ['*'],
            effect: Effect.ALLOW,
          })],
        }),
        script: `
echo "テナント削除開始: $tenantId"
# ここにテナント用リソースの削除処理を書く
export registrationStatus="deleted"
echo "完了"
`,
        environmentStringVariablesFromIncomingEvent: ['tenantId'],
        environmentVariablesToOutgoingEvent: {
          tenantRegistrationData: ['registrationStatus'],
        },
        eventManager: props.eventManager,
      }
    );

    new sbt.CoreApplicationPlane(this, 'CoreApplicationPlane', {
      eventManager: props.eventManager,
      scriptJobs: [provisioningJob, deprovisioningJob],
    });
  }
}
```

### 4. エントリポイント (`bin/cdk.ts`)

```typescript
import * as cdk from 'aws-cdk-lib';
import { ControlPlaneStack } from '../lib/control-plane';
import { AppPlaneStack } from '../lib/app-plane';

const app = new cdk.App();
const controlPlaneStack = new ControlPlaneStack(app, 'ControlPlaneStack');
new AppPlaneStack(app, 'AppPlaneStack', {
  eventManager: controlPlaneStack.eventManager,
});
```

### 5. デプロイ

```bash
npm run build
cdk bootstrap          # 初回のみ
cdk deploy ControlPlaneStack AppPlaneStack
```

## ScriptJob の仕組み

`ScriptJob` は SBT の中核コンポーネントです。EventBridge イベントを受信して CodeBuild でシェルスクリプトを実行します。

```
EventBridge イベント受信
      ↓
Step Functions が起動
      ↓
CodeBuild プロジェクト実行
  ├── 入力: イベントの detail から環境変数を抽出
  ├── 実行: script に書いた bash を実行
  └── 出力: export した変数を EventBridge に返却
      ↓
完了イベントを EventBridge に発行
```

### ScriptJob のパラメータ

| パラメータ | 型 | 説明 |
|---|---|---|
| `script` | string | 実行する bash スクリプト |
| `permissions` | PolicyDocument | CodeBuild に付与する IAM 権限 |
| `environmentStringVariablesFromIncomingEvent` | string[] | イベントの detail から抽出する変数名 |
| `environmentVariablesToOutgoingEvent` | object | 完了イベントの detail に含める変数名 |
| `scriptEnvironmentVariables` | object | 固定の環境変数 |
| `eventManager` | IEventManager | イベント管理インスタンス |

### 入力変数の流れ

```json
// EventBridge イベントの detail:
{
  "tenantId": "abc-123",
  "tier": "basic"
}
```

↓ `environmentStringVariablesFromIncomingEvent: ['tenantId', 'tier']`

```bash
# CodeBuild 内で環境変数として使える:
echo $tenantId  # → abc-123
echo $tier      # → basic
```

### 出力変数の流れ

```bash
# スクリプト内で export:
export tenantStatus="created"
export tenantS3Bucket="my-bucket-abc123"
```

↓ `environmentVariablesToOutgoingEvent: { tenantData: ['tenantStatus', 'tenantS3Bucket'] }`

```json
// 完了イベントの detail:
{
  "jobOutput": {
    "tenantData": {
      "tenantStatus": "created",
      "tenantS3Bucket": "my-bucket-abc123"
    }
  },
  "tenantId": "abc-123"
}
```

## EventBridge イベント定義

### テナントオンボーディング要求

Control Plane がテナント作成時に発行します。

```json
{
  "source": "controlPlaneEventSource",
  "detail-type": "onboardingRequest",
  "detail": {
    "tenantId": "guid",
    "tenantName": "テナント名",
    "email": "admin@tenant.com",
    "tier": "basic",
    "tenantStatus": "In progress",
    "tenantRegistrationId": "guid"
  }
}
```

### プロビジョニング成功

Application Plane がテナント作成完了時に発行します。

```json
{
  "source": "applicationPlaneEventSource",
  "detail-type": "provisionSuccess",
  "detail": {
    "jobOutput": {
      "tenantData": { "tenantStatus": "created", "...": "..." },
      "tenantRegistrationData": { "registrationStatus": "..." }
    },
    "tenantId": "guid"
  }
}
```

### テナントオフボーディング要求

Control Plane がテナント削除時に発行します。

```json
{
  "source": "controlPlaneEventSource",
  "detail-type": "offboardingRequest",
  "detail": { /* テナントオブジェクト全体 */ }
}
```

### デプロビジョニング成功

Application Plane がテナント削除完了時に発行します。

```json
{
  "source": "applicationPlaneEventSource",
  "detail-type": "deprovisionSuccess",
  "detail": {
    "jobOutput": {
      "tenantData": {},
      "tenantRegistrationData": { "registrationStatus": "deleted" }
    },
    "tenantRegistrationId": "guid"
  }
}
```

## カスタムイベントの追加

SBT は標準イベント（onboarding/offboarding）以外にカスタムイベントも登録できます。

```typescript
// 独自イベントを定義
const problemDeployEvent = eventManager.createCustomEvent(
  'problem.deploy.requested',
  'tenkacloud.problem-service'
);

// そのイベントで動く ScriptJob を作成
const problemDeployJob = new sbt.ScriptJob(this, 'ProblemDeployJob', {
  incomingEvent: problemDeployEvent,
  outgoingEvent: {
    success: eventManager.createCustomEvent('problem.deploy.completed', 'tenkacloud'),
    failure: eventManager.createCustomEvent('problem.deploy.failed', 'tenkacloud'),
  },
  script: '...',
  permissions: new PolicyDocument({ /* ... */ }),
  environmentStringVariablesFromIncomingEvent: ['problemId', 'teamId'],
  eventManager: eventManager,
});
```

## 認証プロバイダー

`CognitoAuth` は `IAuth` インタフェースの実装です。他の認証プロバイダー（Auth0 等）も `IAuth` を実装すれば差し替え可能です。

```typescript
// Cognito（標準）
const auth = new sbt.CognitoAuth(this, 'CognitoAuth');

// 将来的に別のプロバイダーに差し替え可能
// const auth = new MyCustomAuth(this, 'CustomAuth');

const controlPlane = new sbt.ControlPlane(this, 'ControlPlane', {
  auth: auth,
  systemAdminEmail: 'admin@example.com',
});
```

## Billing プロバイダー（任意）

課金管理が必要な場合、`MockBillingProvider`（テスト用）または独自の `IBilling` 実装を追加できます。

```typescript
const billing = new sbt.MockBillingProvider(this, 'MockBilling');

const controlPlane = new sbt.ControlPlane(this, 'ControlPlane', {
  auth: cognitoAuth,
  systemAdminEmail: 'admin@example.com',
  billing: billing, // ← 任意
});
```

## テナント操作の CLI テスト

デプロイ後、以下の流れでテナント操作をテストできます。

```bash
# 1. 管理者パスワードを設定（メールで届いた仮パスワードを使用）
PASSWORD='仮パスワード'

# 2. Cognito からトークンを取得
CLIENT_ID=$(aws cloudformation describe-stacks \
  --stack-name ControlPlaneStack \
  --query "Stacks[0].Outputs[?OutputKey=='ControlPlaneIdpClientId'].OutputValue" \
  --output text)

# 3. API エンドポイントを取得
API_ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name ControlPlaneStack \
  --query "Stacks[0].Outputs[?contains(OutputKey,'controlPlaneAPIEndpoint')].OutputValue" \
  --output text)

# 4. テナント作成
curl -X POST "${API_ENDPOINT}tenant-registrations" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{
    "tenantData": {
      "tenantName": "テスト企業",
      "email": "admin@test.com",
      "tier": "basic"
    },
    "tenantRegistrationData": {
      "registrationStatus": "In progress"
    }
  }'

# 5. テナント一覧取得
curl "${API_ENDPOINT}tenant-registrations" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}"

# 6. テナント削除
curl -X DELETE "${API_ENDPOINT}tenant-registrations/${REGISTRATION_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}"
```

## 設計原則

1. **テンプレートモデル**: ベストプラクティスに基づいた SaaS アプリの雛形を提供
2. **強力なアクセラレーター**: テナント管理の定型実装を自分で書かなくて済む
3. **独立したフットプリント**: Control Plane と Application Plane は補完的だが疎結合。片方だけでもデプロイ・運用可能
4. **価値を提供し、邪魔をしない**: ガイドラインと抽象化を提供するが、アプリの進化を妨げない

## 参考リンク

- [SBT GitHub リポジトリ](https://github.com/awslabs/sbt-aws)
- [SBT API リファレンス](https://github.com/awslabs/sbt-aws/blob/main/API.md)
- [AWS SaaS Reference Architecture (ECS)](https://github.com/aws-samples/saas-reference-architecture-ecs)
- [AWS Marketplace 統合ガイド](https://github.com/awslabs/sbt-aws/blob/main/docs/public/marketplace-integration.md)
