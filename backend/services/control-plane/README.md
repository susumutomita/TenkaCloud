# Control Plane Services

コントロールプレーンは、TenkaCloudプラットフォーム全体を管理する共有サービス群です。

## サービス一覧

### 1. Registration Service
- ディレクトリ: `registration/`
- 責務: 新規テナントのオンボーディング
- 主な機能:
  - テナント自己登録フロー
  - 初期テナント設定
  - Kubernetesネームスペース作成
  - 認証プール作成
  - テナント固有リソースのプロビジョニング

### 2. Tenant Management Service
- ディレクトリ: `tenant-management/`
- 責務: テナントライフサイクル管理
- 主な機能:
  - テナント情報のCRUD操作
  - テナント状態管理（active/suspended/deleted）
  - テナント設定管理
  - リソース使用量追跡
  - テナント分離ポリシーの適用

### 3. User Management Service
- ディレクトリ: `user-management/`
- 責務: テナント内ユーザーの管理
- 主な機能:
  - ユーザーのCRUD操作
  - ロール・権限管理
  - 認証・認可
  - セッション管理
  - テナント間のユーザー分離

### 4. System Management Service
- ディレクトリ: `system-management/`
- 責務: プラットフォーム全体の管理・監視
- 主な機能:
  - グローバル統計情報
  - システムヘルスチェック
  - プラットフォーム設定管理
  - 監査ログ
  - メトリクス収集

## アーキテクチャ

### デプロイメント
すべてのControl Planeサービスは、Kubernetes上の専用namespace `control-plane` にデプロイされます。

```
EKS Cluster
└── Namespace: control-plane
    ├── registration-service (Pod)
    ├── tenant-management-service (Pod)
    ├── user-management-service (Pod)
    └── system-management-service (Pod)
```

### データストア
- DynamoDB: テナント情報、ユーザー情報、システム設定
- パーティション戦略: テナントIDによる論理的分離

### 認証・認可
- すべてのControl Plane APIはJWT認証を必要とする
- システム管理者とテナント管理者で異なる権限レベル

## 技術スタック

- 言語: TypeScript (Node.js)
- フレームワーク: Express / Fastify
- データベース: DynamoDB
- 認証: Cognito + JWT
- コンテナ: Docker
- オーケストレーション: Kubernetes (EKS)

## 開発

各サービスディレクトリ配下に個別のREADME.mdがあります。
