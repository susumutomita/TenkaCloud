# TenkaCloud Multi-Tenant Architecture Design

## アーキテクチャ概要

TenkaCloudは、AWS SaaS Factory EKS Reference Architectureをベースとした、マルチテナントSaaS競技プラットフォームです。

## サービス分離戦略

### 2-Plane Architecture

```
backend/
├── services/
│   ├── control-plane/     # テナント管理・認証・システム全体の管理
│   └── application-plane/ # ビジネスロジック（テナント毎に分離されて実行）
```

## Control Plane（コントロールプレーン）

テナント全体を横断的に管理する共有サービス群。すべてのテナントから利用される。

### サービス構成

#### 1. Registration Service（登録サービス）
- **責務**: 新規テナントのオンボーディング
- **主な機能**:
  - テナント自己登録フロー
  - 初期テナント設定
  - Kubernetesネームスペース作成
  - 認証プール（Cognito User Pool）の作成
  - テナント固有リソースのプロビジョニング

#### 2. Tenant Management Service（テナント管理サービス）
- **責務**: テナントライフサイクル管理
- **主な機能**:
  - テナント情報のCRUD操作
  - テナント状態管理（active/suspended/deleted）
  - テナント設定管理
  - リソース使用量追跡
  - テナント分離ポリシーの適用

#### 3. User Management Service（ユーザー管理サービス）
- **責務**: テナント内ユーザーの管理
- **主な機能**:
  - ユーザーのCRUD操作
  - ロール・権限管理
  - 認証・認可
  - セッション管理
  - テナント間のユーザー分離

#### 4. System Management Service（システム管理サービス）
- **責務**: プラットフォーム全体の管理・監視
- **主な機能**:
  - グローバル統計情報
  - システムヘルスチェック
  - プラットフォーム設定管理
  - 監査ログ
  - メトリクス収集

### データ管理
- **データストア**: DynamoDB（共有テーブル、テナントIDでパーティション）
- **分離方式**: テナントIDによる論理的分離

## Application Plane（アプリケーションプレーン）

テナント固有のビジネスロジックを実行するサービス群。テナント毎にネームスペースで分離。

### サービス構成

#### 1. Battle Service（バトル管理サービス）
- **責務**: クラウド対戦セッションの管理
- **主な機能**:
  - バトルセッションのCRUD
  - リアルタイムバトル進行管理
  - チーム対戦モード
  - 観戦モード（リアルタイム進捗配信）
  - バトル履歴・リプレイ

#### 2. Problem Service（問題管理サービス）
- **責務**: 競技問題の管理
- **主な機能**:
  - 問題ライブラリ管理
  - 問題作成・編集
  - Cloud Contest形式との互換性
  - 問題テンプレート管理
  - AI支援による問題生成

#### 3. Scoring Service（採点サービス）
- **責務**: インフラ構築の自動評価
- **主な機能**:
  - インフラ構築の自動検証
  - コスト最適化スコアリング
  - セキュリティベストプラクティス評価
  - パフォーマンス評価
  - 詳細フィードバック生成

#### 4. Leaderboard Service（リーダーボードサービス）
- **責務**: ランキング・統計管理
- **主な機能**:
  - グローバルランキング
  - カテゴリ別ランキング
  - チームランキング
  - 統計情報集計
  - スコア履歴管理

### データ管理

#### Silo Model（サイロモデル）
テナント毎に完全に分離されたデータストアを使用
- **対象**: Battle Service, Leaderboard Service
- **理由**: 高いパフォーマンス要求、データ分離の厳格性

#### Pooled Model（プールモデル）
共有データストアでテナントIDによりパーティション
- **対象**: Problem Service, Scoring Service
- **理由**: データの効率的な共有、問題テンプレートの再利用

## テナント分離戦略

### Namespace-per-Tenant Model

```
Kubernetes Cluster (EKS)
├── Namespace: control-plane
│   ├── registration-service
│   ├── tenant-management-service
│   ├── user-management-service
│   └── system-management-service
│
├── Namespace: tenant-{tenant-id-1}
│   ├── battle-service
│   ├── problem-service
│   ├── scoring-service
│   └── leaderboard-service
│
└── Namespace: tenant-{tenant-id-2}
    ├── battle-service
    ├── problem-service
    ├── scoring-service
    └── leaderboard-service
```

### ネットワーク分離
- **NGINX Ingress Controller**: テナントルーティング
- **Network Policy**: Namespaceレベルのネットワーク分離
- **Service Mesh（将来）**: より高度なトラフィック制御

## 認証・認可フロー

### テナント識別
1. ユーザーがランディングページでテナントを選択
2. テナント固有のCognito User Poolへリダイレクト
3. OAuth フローで認証
4. JWTトークンにテナントID含む

### マイクロサービス間認証
- JWTトークン検証
- テナントIDの抽出と検証
- サービス間通信の認可

## データパーティショニング

### DynamoDB テーブル設計

#### Control Plane Tables
```
tenants
- PK: tenantId
- Attributes: name, status, createdAt, config, ...

users
- PK: tenantId
- SK: userId
- Attributes: email, role, permissions, ...

system-config
- PK: configKey
- Attributes: value, ...
```

#### Application Plane Tables

**Silo Model (テナント毎)**
```
battles-{tenant-id}
- PK: battleId
- Attributes: name, status, teams, startTime, ...

leaderboard-{tenant-id}
- PK: category
- SK: score#userId
- Attributes: userName, score, rank, ...
```

**Pooled Model (共有)**
```
problems
- PK: tenantId
- SK: problemId
- Attributes: title, description, template, difficulty, ...

scoring-results
- PK: tenantId#battleId
- SK: userId#timestamp
- Attributes: score, feedback, metrics, ...
```

## デプロイメントフロー

### テナントオンボーディング
1. **Registration Service**: 新規テナント登録APIを受信
2. **Tenant Creation**: DynamoDBにテナントレコード作成
3. **User Pool Creation**: Cognito User Pool作成
4. **Namespace Provisioning**: Kubernetes Namespaceを作成
5. **Service Deployment**: Application Planeサービスをデプロイ
6. **DNS Configuration**: テナント固有のサブドメイン設定（オプション）
7. **Notification**: テナント管理者に完了通知

### CI/CDパイプライン
- **Control Plane**: 全テナント共通、ローリングアップデート
- **Application Plane**: テナント毎に独立したデプロイ、段階的ロールアウト

## スケーリング戦略

### Horizontal Pod Autoscaler (HPA)
- CPU/メモリ使用率ベース
- カスタムメトリクス（同時バトル数など）

### Cluster Autoscaler
- ノード数の自動調整
- テナント増加に応じたクラスター拡張

### データベーススケーリング
- DynamoDB Auto Scaling
- テーブル毎のキャパシティ管理

## マルチクラウド対応準備

### 抽象化レイヤー
```
backend/
├── services/
│   └── shared/
│       ├── cloud-abstraction/
│       │   ├── interfaces/
│       │   │   ├── IAuthProvider.ts
│       │   │   ├── IStorageProvider.ts
│       │   │   └── IComputeProvider.ts
│       │   │
│       │   └── providers/
│       │       ├── aws/
│       │       ├── gcp/
│       │       ├── azure/
│       │       └── localstack/
```

## セキュリティ考慮事項

### データ分離
- テナントIDによる厳格なデータアクセス制御
- Namespace分離によるワークロード分離
- Network Policyによるトラフィック制限

### 暗号化
- 転送時: TLS 1.3
- 保存時: DynamoDB暗号化、EBS暗号化

### 監査
- すべてのAPI呼び出しをログ記録
- テナント横断アクセスの検出・アラート

## フロントエンドアーキテクチャ（3層UI構造）

### UI分離戦略

TenkaCloudは、役割に応じて3つのUIアプリケーションを提供します。

```
frontend/
├── control-plane-app/    # プラットフォーム管理者用
├── admin-app/            # テナント管理者用
└── participant-app/      # 競技者用
```

### 1. Control Plane UI（プラットフォーム管理者用）

**対象ユーザー**: TenkaCloudプラットフォーム運営者

**主な機能**:
- テナント管理（作成・削除・一時停止）
- Application Planeデプロイ管理
  - 新しいバージョンのデプロイ
  - テナント毎のロールアウト制御
  - デプロイステータス監視
- グローバル統計ダッシュボード
  - 全テナントの利用状況
  - システムリソース使用率
  - パフォーマンスメトリクス
- プラットフォーム設定
- 監査ログビューア

**アクセス制御**:
- プラットフォーム管理者専用の認証
- テナントに依存しないグローバルアクセス

**技術スタック**:
- Next.js (App Router)
- サーバーサイド: Control Plane Services API

**URL構造**:
```
https://platform.tenkacloud.com/
├── /tenants              # テナント一覧
├── /tenants/:id          # テナント詳細
├── /deployments          # デプロイ管理
├── /statistics           # グローバル統計
└── /settings             # プラットフォーム設定
```

### 2. Admin UI（テナント管理者用）

**対象ユーザー**: 各テナントの管理者（企業の担当者、組織の運営者）

**主な機能**:
- バトルセッション管理
  - バトルの作成・編集・削除
  - バトル設定（時間制限、問題選択など）
  - リアルタイム進行状況モニタリング
- 問題管理
  - 問題ライブラリの閲覧
  - カスタム問題作成・編集
  - AI支援による問題生成
- チーム管理
  - チーム作成・メンバー管理
  - チーム招待
- ユーザー管理
  - テナント内ユーザーの追加・削除
  - ロール・権限設定
- 統計・レポート
  - テナント内ランキング
  - 参加者の進捗状況
  - バトル結果分析

**アクセス制御**:
- テナント固有のCognito User Pool
- Admin権限を持つユーザーのみアクセス可能
- テナント境界を越えたアクセス不可

**技術スタック**:
- Next.js (App Router)
- サーバーサイド: Application Plane Services API

**URL構造**:
```
https://{tenant-id}.tenkacloud.com/admin/
├── /battles              # バトル管理
├── /battles/new          # バトル作成
├── /battles/:id          # バトル詳細・編集
├── /problems             # 問題管理
├── /teams                # チーム管理
├── /users                # ユーザー管理
└── /analytics            # 統計・分析
```

### 3. Participant UI（競技者用）

**対象ユーザー**: バトルに参加する競技者

**主な機能**:
- バトル参加
  - 参加可能なバトル一覧
  - バトルへの参加登録
- 問題を解く
  - 問題の閲覧
  - クラウドリソースの構築
  - 提出・自動採点
- リアルタイムフィードバック
  - 現在のスコア
  - ランキング表示
  - AI コーチング（ヒント）
- 履歴・統計
  - 自分の過去のバトル履歴
  - スコア推移
  - 得意/不得意分野の分析
- リーダーボード
  - グローバルランキング
  - カテゴリ別ランキング
  - チームランキング

**アクセス制御**:
- テナント固有のCognito User Pool
- 競技者権限を持つユーザーがアクセス可能
- 自分のデータと公開データのみ閲覧可能

**技術スタック**:
- Next.js (App Router)
- サーバーサイド: Application Plane Services API
- WebSocket: リアルタイム更新（スコア、ランキング）

**URL構造**:
```
https://{tenant-id}.tenkacloud.com/
├── /                     # ダッシュボード
├── /battles              # バトル一覧
├── /battles/:id          # バトル参加画面
├── /battles/:id/problems/:problemId  # 問題を解く
├── /leaderboard          # リーダーボード
├── /history              # 自分の履歴
└── /profile              # プロフィール設定
```

### UI間の関係性

```
┌─────────────────────────────────────┐
│   Control Plane UI                  │
│   (プラットフォーム管理者)            │
│                                     │
│  - テナント管理                      │
│  - Application Planeデプロイ        │
│  - グローバル統計                    │
└─────────────────────────────────────┘
              │
              │ テナント作成・管理
              ▼
┌─────────────────────────────────────┐
│   Tenant {tenant-id}                │
│                                     │
│  ┌──────────────┐  ┌─────────────┐ │
│  │  Admin UI    │  │Participant  │ │
│  │ （管理者）    │  │    UI       │ │
│  │              │  │ （競技者）   │ │
│  │ - バトル作成 │  │ - バトル参加│ │
│  │ - 問題管理   │  │ - 問題を解く│ │
│  │ - ユーザー管理│  │ - スコア確認│ │
│  └──────────────┘  └─────────────┘ │
└─────────────────────────────────────┘
```

## Control PlaneからのApplication Planeデプロイメント

### デプロイメント管理機能

Control Plane UIは、Application Planeサービスのデプロイを管理します。

#### デプロイメントワークフロー

1. **新バージョンのビルド**
   - GitHub ActionsでDockerイメージをビルド
   - ECRにプッシュ
   - バージョンタグ付け

2. **デプロイ計画の作成**（Control Plane UI）
   - デプロイ対象のサービス選択
   - デプロイ対象のテナント選択
   - ロールアウト戦略の設定
     - 全テナント一斉
     - カナリアデプロイ（一部テナントで先行）
     - 段階的ロールアウト

3. **デプロイ実行**（Control Plane Backend）
   - Kubernetes APIを使用してテナント毎にデプロイ
   - ヘルスチェック
   - ロールバック機能

4. **デプロイ監視**（Control Plane UI）
   - リアルタイムステータス表示
   - 各テナントのデプロイ状態
   - エラーログの表示

#### デプロイメント管理サービス

Control Planeに新しいサービスを追加：

**Deployment Management Service**
- **責務**: Application Planeのデプロイ管理
- **主な機能**:
  - デプロイ計画の作成・管理
  - Kubernetesマニフェストの動的生成
  - テナント毎のデプロイ実行
  - ロールアウト戦略の実装
  - デプロイステータスの追跡
  - ロールバック機能

#### デプロイメントテーブル

```
deployments
- PK: deploymentId
- Attributes:
  - version: デプロイするバージョン
  - services: [battle-service, problem-service, ...]
  - targetTenants: [tenant-1, tenant-2, ...]
  - strategy: canary | rolling | all-at-once
  - status: pending | in-progress | completed | failed
  - createdAt, updatedAt

deployment-logs
- PK: deploymentId
- SK: timestamp#tenantId
- Attributes:
  - tenantId
  - status: success | failed | in-progress
  - logs: デプロイログ
  - errorMessage: エラーメッセージ（失敗時）
```

### Control Plane Service構成（更新）

```
backend/
└── services/
    └── control-plane/
        ├── registration/           # テナント登録
        ├── tenant-management/      # テナント管理
        ├── user-management/        # ユーザー管理
        ├── system-management/      # システム管理
        └── deployment-management/  # 🆕 デプロイ管理
```

## 次のステップ

1. Control Planeサービスの実装
   - Registration Service
   - Tenant Management Service
   - User Management Service
   - System Management Service
   - **Deployment Management Service** 🆕
2. Application Planeサービスの実装
   - Battle Service
   - Problem Service
   - Scoring Service
   - Leaderboard Service
3. フロントエンドアプリケーションの実装
   - Control Plane UI
   - Admin UI
   - Participant UI
4. Kubernetesマニフェストの作成
5. Terraformによるインフラ定義
6. CI/CDパイプラインの構築
