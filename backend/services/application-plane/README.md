# Application Plane Services

アプリケーションプレーンは、テナント固有のビジネスロジックを実行するサービス群です。テナント毎にネームスペースで分離されます。

## サービス一覧

### 1. Battle Service
- ディレクトリ: `battle-service/`
- 責務: クラウド対戦セッションの管理
- 主な機能:
  - バトルセッションのCRUD
  - リアルタイムバトル進行管理
  - チーム対戦モード
  - 観戦モード（リアルタイム進捗配信）
  - バトル履歴・リプレイ

### 2. Problem Service
- ディレクトリ: `problem-service/`
- 責務: 競技問題の管理
- 主な機能:
  - 問題ライブラリ管理
  - 問題作成・編集
  - Cloud Contest形式との互換性
  - 問題テンプレート管理
  - AI支援による問題生成

### 3. Scoring Service
- ディレクトリ: `scoring-service/`
- 責務: インフラ構築の自動評価
- 主な機能:
  - インフラ構築の自動検証
  - コスト最適化スコアリング
  - セキュリティベストプラクティス評価
  - パフォーマンス評価
  - 詳細フィードバック生成

### 4. Leaderboard Service
- ディレクトリ: `leaderboard-service/`
- 責務: ランキング・統計管理
- 主な機能:
  - グローバルランキング
  - カテゴリ別ランキング
  - チームランキング
  - 統計情報集計
  - スコア履歴管理

## アーキテクチャ

### デプロイメント
各テナント毎に専用のKubernetes namespaceを持ち、Application Planeサービスがデプロイされます。

```
EKS Cluster
├── Namespace: tenant-{tenant-id-1}
│   ├── battle-service (Pod)
│   ├── problem-service (Pod)
│   ├── scoring-service (Pod)
│   └── leaderboard-service (Pod)
│
└── Namespace: tenant-{tenant-id-2}
    ├── battle-service (Pod)
    ├── problem-service (Pod)
    ├── scoring-service (Pod)
    └── leaderboard-service (Pod)
```

### テナント分離
- Namespace分離: テナント毎に独立したKubernetes namespace
- Network Policy: Namespaceレベルでのネットワーク分離
- データ分離: テナントIDによるデータパーティション

### データストア

#### Silo Model（テナント毎のデータベース）
- Battle Service
- Leaderboard Service

完全に分離されたDynamoDBテーブルを各テナントに割り当て

#### Pooled Model（共有データベース）
- Problem Service
- Scoring Service

テナントIDでパーティションされた共有DynamoDBテーブル

## 技術スタック

- 言語: TypeScript (Node.js)
- フレームワーク: Express / Fastify
- データベース: DynamoDB
- リアルタイム通信: WebSocket (Socket.io)
- 認証: JWT（Control Planeから発行）
- コンテナ: Docker
- オーケストレーション: Kubernetes (EKS)

## 開発

各サービスディレクトリ配下に個別のREADME.mdがあります。
