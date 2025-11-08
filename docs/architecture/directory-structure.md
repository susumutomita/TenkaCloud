# TenkaCloud Directory Structure

TenkaCloudプロジェクトの完全なディレクトリ構造と各ディレクトリの役割を説明します。

## 全体構成

```
TenkaCloud/
├── backend/              # バックエンドサービス
├── frontend/             # フロントエンド（Next.js）
├── infrastructure/       # インフラストラクチャコード
├── problems/             # 問題定義
├── ai/                   # AI機能
├── docs/                 # ドキュメント
├── .github/              # GitHub Actions ワークフロー
├── .devcontainer/        # Dev Container設定
└── CLAUDE.md             # プロジェクト仕様書
```

## Backend Services

AWS SaaS Factory EKS Reference Architectureに基づく2-Plane構成

```
backend/
└── services/
    ├── control-plane/              # コントロールプレーン
    │   ├── registration/           # テナント登録サービス
    │   ├── tenant-management/      # テナント管理サービス
    │   ├── user-management/        # ユーザー管理サービス
    │   └── system-management/      # システム管理サービス
    │
    ├── application-plane/          # アプリケーションプレーン
    │   ├── battle-service/         # バトル管理サービス
    │   ├── problem-service/        # 問題管理サービス
    │   ├── scoring-service/        # 採点サービス
    │   └── leaderboard-service/    # リーダーボードサービス
    │
    └── shared/                     # 共有ライブラリ
        └── cloud-abstraction/      # マルチクラウド抽象化
            ├── interfaces/         # インターフェース定義
            └── providers/          # プロバイダー実装
                ├── aws/
                ├── gcp/
                ├── azure/
                └── localstack/
```

### Control Plane Services

| サービス | 責務 | デプロイ先 |
|---------|------|-----------|
| registration | テナント登録・オンボーディング | namespace: control-plane |
| tenant-management | テナントライフサイクル管理 | namespace: control-plane |
| user-management | ユーザー・権限管理 | namespace: control-plane |
| system-management | プラットフォーム管理・監視 | namespace: control-plane |

### Application Plane Services

| サービス | 責務 | データモデル | デプロイ先 |
|---------|------|------------|-----------|
| battle-service | バトルセッション管理 | Silo | namespace: tenant-{id} |
| problem-service | 問題管理 | Pooled | namespace: tenant-{id} |
| scoring-service | 自動採点 | Pooled | namespace: tenant-{id} |
| leaderboard-service | ランキング管理 | Silo | namespace: tenant-{id} |

## Frontend

```
frontend/
├── app/                  # Next.js App Router
│   ├── (auth)/          # 認証ページグループ
│   ├── (dashboard)/     # ダッシュボードページグループ
│   ├── (battle)/        # バトルページグループ
│   └── api/             # API Routes
│
├── components/          # Reactコンポーネント
│   ├── ui/             # 基本UIコンポーネント
│   ├── features/       # 機能別コンポーネント
│   │   ├── auth/
│   │   ├── battle/
│   │   ├── problem/
│   │   └── leaderboard/
│   └── layouts/        # レイアウトコンポーネント
│
├── lib/                # ユーティリティ・ヘルパー
│   ├── api/           # API クライアント
│   ├── hooks/         # カスタムフック
│   ├── utils/         # ユーティリティ関数
│   └── types/         # TypeScript型定義
│
└── styles/            # グローバルスタイル
```

## Infrastructure

```
infrastructure/
├── k8s/                           # Kubernetesマニフェスト
│   ├── base/                      # 共通設定
│   │   ├── namespace.yaml
│   │   ├── ingress.yaml
│   │   └── network-policy.yaml
│   │
│   ├── control-plane/             # コントロールプレーン
│   │   ├── registration/
│   │   ├── tenant-management/
│   │   ├── user-management/
│   │   └── system-management/
│   │
│   └── application-plane/         # アプリケーションプレーン
│       ├── battle-service/
│       ├── problem-service/
│       ├── scoring-service/
│       └── leaderboard-service/
│
└── terraform/                     # Terraformコード
    ├── modules/                   # 再利用可能モジュール
    │   ├── eks/                  # EKSクラスター
    │   ├── dynamodb/             # DynamoDBテーブル
    │   ├── cognito/              # Cognito User Pool
    │   └── networking/           # VPC・サブネット
    │
    └── environments/              # 環境別設定
        ├── dev/
        ├── staging/
        └── prod/
```

### Kubernetes構成

- **base/**: 全環境共通の設定（Ingress、NetworkPolicyなど）
- **control-plane/**: Control Planeサービスのマニフェスト
- **application-plane/**: Application Planeサービスのマニフェスト（テンプレート）

### Terraform構成

- **modules/**: 再利用可能なTerraformモジュール
- **environments/**: 環境別の変数とメイン設定

## Problems

```
problems/
├── templates/              # 問題テンプレート
│   ├── beginner/
│   ├── intermediate/
│   └── advanced/
│
└── examples/              # サンプル問題
    ├── aws/
    ├── gcp/
    └── azure/
```

### 問題定義形式

Cloud Contest形式との互換性を持つ問題定義ファイル

```yaml
# problem.yaml
name: "問題名"
description: "問題の説明"
difficulty: "beginner|intermediate|advanced"
cloud_provider: "aws|gcp|azure|multi"
time_limit: 3600  # 秒
scoring:
  max_score: 100
  criteria:
    - name: "機能性"
      weight: 40
    - name: "コスト最適化"
      weight: 30
    - name: "セキュリティ"
      weight: 30
```

## AI Features

```
ai/
├── problem-generator/     # AI問題生成
│   ├── prompts/          # プロンプトテンプレート
│   └── generators/       # 生成ロジック
│
├── scoring/              # AI採点システム
│   ├── validators/       # 検証ロジック
│   └── evaluators/       # 評価ロジック
│
└── coaching/             # AIコーチング
    ├── hints/           # ヒント生成
    └── feedback/        # フィードバック生成
```

## Documentation

```
docs/
├── architecture/         # アーキテクチャドキュメント
│   ├── multi-tenant-design.md
│   ├── directory-structure.md
│   └── data-model.md
│
├── api/                 # API仕様
│   ├── control-plane/
│   └── application-plane/
│
├── development/         # 開発ガイド
│   ├── setup.md
│   ├── coding-standards.md
│   └── testing.md
│
└── deployment/          # デプロイメントガイド
    ├── local.md
    ├── staging.md
    └── production.md
```

## 開発環境

```
.devcontainer/           # VS Code Dev Container設定
├── devcontainer.json
└── Dockerfile

docker-compose.yml       # ローカル開発環境
.env.example            # 環境変数テンプレート
```

## CI/CD

```
.github/
└── workflows/
    ├── control-plane-ci.yml     # Control Plane CI/CD
    ├── application-plane-ci.yml # Application Plane CI/CD
    ├── frontend-ci.yml          # Frontend CI/CD
    └── infrastructure-ci.yml    # Infrastructure CI/CD
```

## 設定ファイル

```
.
├── package.json              # ルートパッケージ（monorepo）
├── tsconfig.json            # TypeScript設定
├── .eslintrc.json           # ESLint設定
├── .prettierrc              # Prettier設定
└── jest.config.js           # Jest設定
```

## データフロー

```
┌─────────────┐
│  Frontend   │
│  (Next.js)  │
└──────┬──────┘
       │
       ├──────────────────────────────────┐
       │                                  │
       ▼                                  ▼
┌──────────────┐                 ┌────────────────┐
│ Control      │                 │ Application    │
│ Plane        │                 │ Plane          │
│ Services     │◄────────────────┤ Services       │
└──────┬───────┘                 └────────┬───────┘
       │                                  │
       ├──────────────┬───────────────────┤
       ▼              ▼                   ▼
  ┌─────────┐   ┌─────────┐        ┌─────────┐
  │DynamoDB │   │ Cognito │        │   S3    │
  │ (共有)  │   │         │        │         │
  └─────────┘   └─────────┘        └─────────┘
```

## ネームスペース戦略

```
EKS Cluster
├── control-plane (namespace)
│   ├── registration-service (pod)
│   ├── tenant-management-service (pod)
│   ├── user-management-service (pod)
│   └── system-management-service (pod)
│
├── tenant-org-1 (namespace)
│   ├── battle-service (pod)
│   ├── problem-service (pod)
│   ├── scoring-service (pod)
│   └── leaderboard-service (pod)
│
└── tenant-org-2 (namespace)
    ├── battle-service (pod)
    ├── problem-service (pod)
    ├── scoring-service (pod)
    └── leaderboard-service (pod)
```

## 参考リソース

- [AWS SaaS Factory EKS Reference Architecture](https://github.com/aws-samples/aws-saas-factory-eks-reference-architecture)
- [Multi-Tenant Design Document](./multi-tenant-design.md)
