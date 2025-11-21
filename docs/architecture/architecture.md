# TenkaCloud Platform Architecture Design Document v1.0

## 目次

1. [エグゼクティブサマリー](#1-エグゼクティブサマリー)
2. [プロジェクト概要](#2-プロジェクト概要)
3. [システムアーキテクチャ](#3-システムアーキテクチャ)
4. [技術スタック](#4-技術スタック)
5. [データベース設計](#5-データベース設計)
6. [マイクロサービス設計](#6-マイクロサービス設計)
7. [マルチテナント設計](#7-マルチテナント設計)
8. [マルチクラウド戦略](#8-マルチクラウド戦略)
9. [認証・認可設計](#9-認証認可設計)
10. [フロントエンド設計](#10-フロントエンド設計)
11. [バックエンド設計](#11-バックエンド設計)
12. [競技システム設計](#12-競技システム設計)
13. [問題管理システム](#13-問題管理システム)
14. [採点システム](#14-採点システム)
15. [インフラストラクチャ設計](#15-インフラストラクチャ設計)
16. [AI機能設計](#16-ai機能設計)
17. [セキュリティ設計](#17-セキュリティ設計)
18. [パフォーマンス設計](#18-パフォーマンス設計)
19. [デプロイメント戦略](#19-デプロイメント戦略)
20. [運用・監視設計](#20-運用監視設計)

---

## 1. エグゼクティブサマリー

### 1.1 ビジョン

TenkaCloud は、クラウド技術者のための常設・オープンソースの競技プラットフォームです。本プラットフォームは AWS GameDay 文化をルーツにした OSS 版クラウド天下一武道会として再構築しました。世界中のクラウド戦士たちが集い、技を磨き、腕を競い、学び合う場を提供します。

### 1.2 主要特徴

- **完全OSS実装**: 社内資産を含まず、ゼロから再設計
- **マルチクラウド対応**: AWS、GCP、Azure、OCI、LocalStack 対応
- **マルチテナントSaaS**: 常設・チーム対戦・観戦モード
- **拡張可能設計**: マイクロサービスアーキテクチャ
- **AI支援機能**: 問題生成・自動採点・コーチング

### 1.3 成功指標

| 指標 | 目標値 | 測定方法 |
|------|--------|----------|
| 同時接続テナント数 | 100+ | Kubernetes メトリクス |
| 問題プール | 100+ | 問題リポジトリカウント |
| レスポンスタイム | <200ms | APM ツール |
| 可用性 | 99.9% | アップタイムモニター |
| テストカバレッジ | 100% | CI/CD レポート |

---

## 2. プロジェクト概要

### 2.1 プロジェクト目標

1. **技術者育成**: クラウド技術者のスキル向上プラットフォーム
2. **コミュニティ形成**: 技術者同士の学び合いと競争の場
3. **標準化**: クラウドベストプラクティスの普及
4. **オープンソース**: 誰もが利用・貢献できるプラットフォーム

### 2.2 ステークホルダー

| ステークホルダー | 役割 | 要求事項 |
|-----------------|------|----------|
| プラットフォーム管理者 | システム全体の運営 | 管理機能、監視、スケーラビリティ |
| テナント管理者 | テナント内の管理 | ユーザー管理、イベント管理 |
| 競技者 | 競技への参加 | 使いやすいUI、リアルタイムフィードバック |
| 観戦者 | 競技の観戦 | リアルタイム進捗、リーダーボード |
| コントリビューター | OSS貢献 | クリーンコード、ドキュメント |

### 2.3 制約事項

- **ライセンス**: MIT License 準拠
- **既存資産**: 既存プロジェクトの直接コピー禁止（独自実装必須）
- **セキュリティ**: OWASP Top 10 対応必須
- **パフォーマンス**: 1000 同時ユーザー対応

---

## 3. システムアーキテクチャ

### 3.1 全体アーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│                         User Layer                          │
├─────────────────────────────────────────────────────────────┤
│  Browser    Mobile App    CLI Tool    API Client           │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                    Presentation Layer                       │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │Control Plane │  │ Application  │  │  Admin Portal  │  │
│  │     UI       │  │     UI       │  │                │  │
│  └──────────────┘  └──────────────┘  └────────────────┘  │
│         Next.js / React / Tailwind CSS                     │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                      API Gateway Layer                      │
├─────────────────────────────────────────────────────────────┤
│  Rate Limiting | Authentication | Routing | Load Balancing  │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                    Service Layer                            │
├──────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────┐  ┌─────────────────────────┐ │
│  │    Control Plane        │  │   Application Plane     │ │
│  ├─────────────────────────┤  ├─────────────────────────┤ │
│  │ • Tenant Service        │  │ • Battle Service        │ │
│  │ • Identity Service      │  │ • Challenge Service     │ │
│  │ • Registry Service      │  │ • Scoring Service       │ │
│  │ • Platform Service      │  │ • Leaderboard Service   │ │
│  └─────────────────────────┘  └─────────────────────────┘ │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │           Shared Services Layer                      │  │
│  ├─────────────────────────────────────────────────────┤  │
│  │ • Cloud Abstraction   • Event Bus                   │  │
│  │ • Notification        • Logging                     │  │
│  │ • Cache               • Queue                       │  │
│  └─────────────────────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                      Data Layer                             │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐     │
│  │ DynamoDB │ │PostgreSQL│ │  Redis   │ │    S3    │     │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘     │
└──────────────────────────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                 Infrastructure Layer                        │
├─────────────────────────────────────────────────────────────┤
│         Kubernetes (EKS/GKE/AKS) | Docker | Terraform       │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 2-Plane Architecture

#### Control Plane
- **役割**: プラットフォーム全体の管理と制御
- **特性**: 共有リソース、高可用性
- **コンポーネント**:
  - Tenant Management
  - Identity & Access Management
  - Platform Configuration
  - Billing & Usage Tracking

#### Application Plane
- **役割**: ビジネスロジックの実行
- **特性**: テナント分離、スケーラブル
- **コンポーネント**:
  - Battle Management
  - Challenge Execution
  - Scoring Engine
  - Leaderboard

### 3.3 データフロー

```mermaid
sequenceDiagram
    participant U as User
    participant UI as Frontend
    participant GW as API Gateway
    participant CP as Control Plane
    participant AP as Application Plane
    participant DB as Database

    U->>UI: Access Platform
    UI->>GW: API Request
    GW->>CP: Authenticate
    CP->>DB: Verify Credentials
    DB-->>CP: User Data
    CP-->>GW: JWT Token
    GW->>AP: Business Logic
    AP->>DB: Data Operation
    DB-->>AP: Result
    AP-->>GW: Response
    GW-->>UI: JSON Response
    UI-->>U: Display Result
```

---

## 4. 技術スタック

### 4.1 フロントエンド

| レイヤー | 技術 | バージョン | 用途 |
|---------|------|-----------|------|
| Framework | Next.js | 16.0.x | SSR/SSG対応 |
| Language | TypeScript | 5.x | 型安全性 |
| UI Library | React | 18.x | コンポーネント |
| Styling | Tailwind CSS | 4.x | ユーティリティCSS |
| State | Zustand | 5.x | 状態管理 |
| Form | React Hook Form | 7.x | フォーム管理 |
| Validation | Zod | 3.x | スキーマ検証 |
| Testing | Vitest | 2.x | ユニットテスト |
| E2E | Playwright | 1.x | E2Eテスト |

### 4.2 バックエンド

| レイヤー | 技術 | バージョン | 用途 |
|---------|------|-----------|------|
| Runtime | Bun | 1.x | 高速実行環境 |
| Framework | Fastify | 5.x | REST API |
| Language | TypeScript | 5.x | 型安全性 |
| O/Rマッパ | Prisma | 6.x | データベースアクセス |
| Validation | Zod | 3.x | スキーマ検証 |
| Queue | BullMQ | 5.x | ジョブキュー |
| WebSocket | Socket.IO | 4.x | リアルタイム通信 |
| Testing | Vitest | 2.x | ユニットテスト |
| API Doc | OpenAPI | 3.x | API仕様書 |

### 4.3 インフラストラクチャ

| カテゴリ | 技術 | 用途 |
|---------|------|------|
| Container | Docker | コンテナ化 |
| Orchestration | Kubernetes | コンテナオーケストレーション |
| Service Mesh | Istio | トラフィック管理 |
| IaC | Terraform | インフラ管理 |
| CI/CD | GitHub Actions | 自動化 |
| Registry | GitHub Container Registry | イメージ管理 |

### 4.4 データストア

| 種別 | 技術 | 用途 |
|------|------|------|
| NoSQL | DynamoDB | メインデータストア |
| RDB | PostgreSQL | リレーショナルデータ |
| Cache | Redis | キャッシュ・セッション |
| Object Storage | S3 | ファイルストレージ |
| Search | OpenSearch | 全文検索 |

### 4.5 認証・認可

| コンポーネント | 技術 | 用途 |
|---------------|------|------|
| IdP | Keycloak | SSO/OIDC |
| User Pool | AWS Cognito | ユーザー管理 |
| Token | JWT | セッショントークン |
| MFA | TOTP | 多要素認証 |

---

## 5. データベース設計

### 5.1 データモデル概要

```mermaid
erDiagram
    Tenants ||--o{ Users : has
    Tenants ||--o{ Battles : hosts
    Users ||--o{ Teams : belongs_to
    Teams ||--o{ BattleParticipations : participates_in
    Battles ||--o{ BattleParticipations : has
    Battles ||--o{ Challenges : includes
    Challenges ||--o{ Submissions : receives
    Users ||--o{ Submissions : makes
    Submissions ||--o{ Scores : generates
    Teams ||--o{ LeaderboardEntries : appears_in
```

### 5.2 DynamoDB テーブル設計

#### 5.2.1 Tenants Table
```yaml
TableName: TenkaCloud-Tenants
PartitionKey: tenantId (String)
SortKey: -
Attributes:
  - tenantId: String (UUID)
  - organizationName: String
  - plan: String (free|standard|premium)
  - status: String (active|suspended|deleted)
  - createdAt: String (ISO8601)
  - updatedAt: String (ISO8601)
  - metadata: Map
    - contactEmail: String
    - maxUsers: Number
    - features: StringSet
GlobalSecondaryIndexes:
  - GSI1:
      PartitionKey: status
      SortKey: createdAt
```

#### 5.2.2 Users Table
```yaml
TableName: TenkaCloud-Users
PartitionKey: userId (String)
SortKey: -
Attributes:
  - userId: String (UUID)
  - tenantId: String (Foreign Key)
  - email: String
  - username: String
  - roles: StringSet
  - status: String (active|inactive|deleted)
  - profile: Map
    - displayName: String
    - avatar: String
    - bio: String
  - createdAt: String (ISO8601)
  - lastLoginAt: String (ISO8601)
GlobalSecondaryIndexes:
  - GSI1:
      PartitionKey: tenantId
      SortKey: createdAt
  - GSI2:
      PartitionKey: email
      SortKey: -
```

#### 5.2.3 Battles Table
```yaml
TableName: TenkaCloud-Battles
PartitionKey: battleId (String)
SortKey: -
Attributes:
  - battleId: String (UUID)
  - tenantId: String
  - battleName: String
  - battleType: String (individual|team)
  - status: String (scheduled|active|completed|cancelled)
  - startTime: String (ISO8601)
  - endTime: String (ISO8601)
  - configuration: Map
    - maxTeams: Number
    - maxParticipantsPerTeam: Number
    - scoringRules: Map
    - allowedClouds: StringSet
  - metadata: Map
GlobalSecondaryIndexes:
  - GSI1:
      PartitionKey: tenantId
      SortKey: startTime
  - GSI2:
      PartitionKey: status
      SortKey: startTime
```

#### 5.2.4 Challenges Table
```yaml
TableName: TenkaCloud-Challenges
PartitionKey: challengeId (String)
SortKey: -
Attributes:
  - challengeId: String
  - title: String
  - category: String
  - difficulty: Number (0-2)
  - points: Number
  - timeLimit: Number (minutes)
  - description: String
  - requirements: List
  - hints: List
    - hintId: String
    - content: String
    - penalty: Number
  - answer: String (encrypted)
  - cloudProvider: String (aws|gcp|azure|multi)
  - template: Map
    - type: String (cloudformation|terraform|arm)
    - content: String
  - validation: Map
    - type: String (lambda|container)
    - code: String
GlobalSecondaryIndexes:
  - GSI1:
      PartitionKey: category
      SortKey: difficulty
```

#### 5.2.5 Submissions Table
```yaml
TableName: TenkaCloud-Submissions
PartitionKey: PK (battleId#challengeId)
SortKey: SK (teamId#timestamp)
Attributes:
  - submissionId: String
  - battleId: String
  - challengeId: String
  - teamId: String
  - userId: String
  - answer: String
  - status: String (pending|validating|correct|incorrect)
  - score: Number
  - validationResults: Map
  - submittedAt: String (ISO8601)
  - processedAt: String (ISO8601)
GlobalSecondaryIndexes:
  - GSI1:
      PartitionKey: teamId
      SortKey: submittedAt
```

#### 5.2.6 LeaderboardEntries Table
```yaml
TableName: TenkaCloud-LeaderboardEntries
PartitionKey: PK (battleId)
SortKey: SK (score#teamId)
Attributes:
  - battleId: String
  - teamId: String
  - teamName: String
  - totalScore: Number
  - rank: Number
  - completedChallenges: Number
  - lastUpdateAt: String (ISO8601)
  - breakdown: Map
    - challengeScores: Map
    - penalties: Number
    - bonuses: Number
GlobalSecondaryIndexes:
  - GSI1:
      PartitionKey: teamId
      SortKey: battleId
```

### 5.3 PostgreSQL スキーマ設計

#### 5.3.1 Event Logs Table
```sql
CREATE TABLE event_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    battle_id UUID,
    user_id UUID,
    event_type VARCHAR(50) NOT NULL,
    event_data JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    INDEX idx_tenant_created (tenant_id, created_at DESC),
    INDEX idx_battle_events (battle_id, created_at DESC)
);
```

#### 5.3.2 Audit Logs Table
```sql
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50),
    resource_id VARCHAR(100),
    changes JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    INDEX idx_tenant_audit (tenant_id, created_at DESC),
    INDEX idx_user_actions (user_id, created_at DESC)
);
```

### 5.4 Redis キー設計

```yaml
# セッション管理
session:{userId}:
  - jwt: String
  - tenantId: String
  - roles: Set
  - TTL: 24 hours

# リアルタイムバトル状態
battle:{battleId}:state:
  - participants: Hash
  - scores: SortedSet
  - events: List
  - TTL: battle duration + 1 hour

# キャッシュ
cache:leaderboard:{battleId}:
  - data: String (JSON)
  - TTL: 30 seconds

# レート制限
ratelimit:{userId}:{endpoint}:
  - count: Number
  - TTL: 1 minute
```

---

## 6. マイクロサービス設計

### 6.1 サービス一覧

| サービス名 | 責務 | 技術スタック |
|-----------|------|-------------|
| Tenant Service | テナント管理 | Fastify + DynamoDB |
| Identity Service | 認証・認可 | Fastify + Keycloak |
| Registry Service | サービス登録・発見 | Fastify + Redis |
| Battle Service | バトル管理 | Fastify + DynamoDB + WebSocket |
| Challenge Service | 問題管理 | Fastify + DynamoDB + S3 |
| Scoring Service | 採点処理 | Fastify + Lambda + SQS |
| Leaderboard Service | ランキング管理 | Fastify + Redis + DynamoDB |
| Notification Service | 通知配信 | Fastify + SNS/SES |
| Analytics Service | 分析・レポート | Fastify + OpenSearch |

### 6.2 Tenant Service

#### API エンドポイント
```yaml
POST   /api/v1/tenants                 # テナント作成
GET    /api/v1/tenants/{tenantId}      # テナント取得
PUT    /api/v1/tenants/{tenantId}      # テナント更新
DELETE /api/v1/tenants/{tenantId}      # テナント削除
GET    /api/v1/tenants                 # テナント一覧
POST   /api/v1/tenants/{tenantId}/suspend  # テナント停止
POST   /api/v1/tenants/{tenantId}/activate # テナント再開
```

#### データモデル
```typescript
interface Tenant {
  tenantId: string;
  organizationName: string;
  plan: 'free' | 'standard' | 'premium';
  status: 'active' | 'suspended' | 'deleted';
  limits: {
    maxUsers: number;
    maxBattles: number;
    maxChallenges: number;
    storageGB: number;
  };
  features: Set<string>;
  billing: {
    customerId: string;
    subscriptionId: string;
    nextBillingDate: Date;
  };
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
```

### 6.3 Identity Service

#### API エンドポイント
```yaml
POST   /api/v1/auth/login              # ログイン
POST   /api/v1/auth/logout             # ログアウト
POST   /api/v1/auth/refresh            # トークンリフレッシュ
POST   /api/v1/auth/mfa/setup          # MFA設定
POST   /api/v1/auth/mfa/verify         # MFA検証
GET    /api/v1/users/me                # 現在のユーザー情報
PUT    /api/v1/users/me                # プロフィール更新
POST   /api/v1/users/password/change   # パスワード変更
POST   /api/v1/users/password/reset    # パスワードリセット
```

#### JWT ペイロード
```typescript
interface JWTPayload {
  sub: string;        // userId
  tid: string;        // tenantId
  email: string;
  username: string;
  roles: string[];
  permissions: string[];
  iat: number;
  exp: number;
  jti: string;        // JWT ID
}
```

### 6.4 Battle Service

#### API エンドポイント
```yaml
POST   /api/v1/battles                      # バトル作成
GET    /api/v1/battles/{battleId}          # バトル詳細
PUT    /api/v1/battles/{battleId}          # バトル更新
DELETE /api/v1/battles/{battleId}          # バトル削除
POST   /api/v1/battles/{battleId}/start    # バトル開始
POST   /api/v1/battles/{battleId}/end      # バトル終了
POST   /api/v1/battles/{battleId}/join     # バトル参加
GET    /api/v1/battles/{battleId}/status   # バトル状態
WS     /ws/battles/{battleId}              # リアルタイム接続
```

#### WebSocket イベント
```typescript
// Client -> Server
interface ClientEvents {
  'join': { teamId: string; userId: string };
  'leave': { teamId: string; userId: string };
  'submit': { challengeId: string; answer: string };
  'request-hint': { challengeId: string; hintLevel: number };
}

// Server -> Client
interface ServerEvents {
  'participant-joined': { teamId: string; participant: User };
  'participant-left': { teamId: string; userId: string };
  'score-update': { teamId: string; score: number; rank: number };
  'challenge-completed': { teamId: string; challengeId: string };
  'battle-end': { results: LeaderboardEntry[] };
}
```

### 6.5 Challenge Service

#### API エンドポイント
```yaml
POST   /api/v1/challenges                   # 問題作成
GET    /api/v1/challenges/{challengeId}    # 問題詳細
PUT    /api/v1/challenges/{challengeId}    # 問題更新
DELETE /api/v1/challenges/{challengeId}    # 問題削除
GET    /api/v1/challenges                   # 問題一覧
POST   /api/v1/challenges/{challengeId}/deploy    # インフラデプロイ
POST   /api/v1/challenges/{challengeId}/validate  # 答え検証
GET    /api/v1/challenges/{challengeId}/resources # リソース情報
POST   /api/v1/challenges/import            # 問題インポート
```

#### Challenge Template Structure
```typescript
interface ChallengeTemplate {
  challengeId: string;
  metadata: {
    title: string;
    category: string;
    difficulty: 0 | 1 | 2;
    timeLimit: number;
    points: number;
  };
  infrastructure: {
    provider: 'aws' | 'gcp' | 'azure' | 'multi';
    template: {
      type: 'cloudformation' | 'terraform' | 'arm';
      content: string;
      parameters: Record<string, any>;
    };
  };
  validation: {
    type: 'lambda' | 'container' | 'api';
    endpoint?: string;
    code?: string;
    expectedResults: Record<string, any>;
  };
  hints: Array<{
    level: number;
    content: string;
    penaltyPoints: number;
  }>;
}
```

### 6.6 Scoring Service

#### API エンドポイント
```yaml
POST   /api/v1/scoring/evaluate            # 採点実行
GET    /api/v1/scoring/results/{submissionId} # 採点結果
POST   /api/v1/scoring/batch               # バッチ採点
GET    /api/v1/scoring/criteria            # 採点基準取得
POST   /api/v1/scoring/recalculate         # 再採点
```

#### Scoring Engine
```typescript
interface ScoringEngine {
  // Level 1: リソース検証
  validateResources(submission: Submission): ValidationResult;

  // Level 2: 設定検証
  validateConfiguration(submission: Submission): ConfigurationScore;

  // Level 3: パフォーマンス測定
  measurePerformance(submission: Submission): PerformanceScore;

  // Level 4: セキュリティ評価
  evaluateSecurity(submission: Submission): SecurityScore;

  // 総合スコア計算
  calculateTotalScore(results: ScoringResults): number;
}
```

---

## 7. マルチテナント設計

### 7.1 テナント分離戦略

#### 7.1.1 Namespace-per-Tenant Model
```yaml
# Control Plane (共有)
namespace: tenkacloud-control
  services:
    - tenant-service
    - identity-service
    - platform-service

# Application Plane (テナント別)
namespace: tenant-{tenantId}
  services:
    - battle-service
    - challenge-service
    - scoring-service
    - leaderboard-service
```

#### 7.1.2 データ分離
```yaml
Silo Model (完全分離):
  - Battles: テナント専用テーブル
  - Submissions: テナント専用テーブル
  - LeaderboardEntries: テナント専用テーブル

Pool Model (共有 + 論理分離):
  - Challenges: 共有テーブル + tenantId パーティション
  - Users: 共有テーブル + tenantId パーティション
```

### 7.2 テナントプロビジョニング

```typescript
class TenantProvisioner {
  async provisionNewTenant(request: TenantRequest): Promise<Tenant> {
    // 1. テナントレコード作成
    const tenant = await this.createTenantRecord(request);

    // 2. Kubernetes Namespace作成
    await this.createNamespace(tenant.tenantId);

    // 3. サービスデプロイ
    await this.deployServices(tenant.tenantId);

    // 4. データベース初期化
    await this.initializeDatabase(tenant.tenantId);

    // 5. IAMロール作成
    await this.createIAMRoles(tenant.tenantId);

    // 6. DNS設定
    await this.configureDNS(tenant);

    // 7. 初期ユーザー作成
    await this.createAdminUser(tenant);

    return tenant;
  }
}
```

### 7.3 テナントルーティング

```typescript
class TenantRouter {
  // HTTPヘッダーベース
  extractTenantFromHeader(request: Request): string {
    return request.headers['x-tenant-id'];
  }

  // JWTベース
  extractTenantFromJWT(token: string): string {
    const payload = jwt.decode(token);
    return payload.tid;
  }

  // サブドメインベース
  extractTenantFromDomain(host: string): string {
    // tenant1.tenkacloud.io -> tenant1
    const subdomain = host.split('.')[0];
    return subdomain;
  }
}
```

---

## 8. マルチクラウド戦略

### 8.1 クラウド抽象化層

```typescript
// Provider Interface
interface CloudProvider {
  // Compute
  createInstance(config: InstanceConfig): Promise<Instance>;
  deleteInstance(instanceId: string): Promise<void>;

  // Storage
  createBucket(name: string): Promise<Bucket>;
  uploadFile(bucket: string, key: string, data: Buffer): Promise<void>;

  // Network
  createVPC(config: VPCConfig): Promise<VPC>;
  createSecurityGroup(config: SGConfig): Promise<SecurityGroup>;

  // IAM
  createRole(config: RoleConfig): Promise<Role>;
  attachPolicy(roleId: string, policyId: string): Promise<void>;

  // Monitoring
  getMetrics(resourceId: string): Promise<Metrics>;
  createAlarm(config: AlarmConfig): Promise<Alarm>;
}
```

### 8.2 Provider実装

#### AWS Adapter
```typescript
class AWSProvider implements CloudProvider {
  private ec2: EC2Client;
  private s3: S3Client;
  private iam: IAMClient;

  async createInstance(config: InstanceConfig): Promise<Instance> {
    const params = {
      ImageId: this.mapToAMI(config.image),
      InstanceType: this.mapToInstanceType(config.size),
      SecurityGroupIds: config.securityGroups,
      SubnetId: config.subnet,
      Tags: this.mapTags(config.tags)
    };

    const result = await this.ec2.runInstances(params);
    return this.mapToInstance(result.Instances[0]);
  }

  private mapToAMI(image: string): string {
    const amiMap = {
      'ubuntu-22.04': 'ami-0123456789',
      'amazon-linux-2': 'ami-9876543210'
    };
    return amiMap[image];
  }
}
```

#### GCP Adapter
```typescript
class GCPProvider implements CloudProvider {
  private compute: Compute;
  private storage: Storage;
  private iam: IAM;

  async createInstance(config: InstanceConfig): Promise<Instance> {
    const instance = {
      name: config.name,
      machineType: this.mapToMachineType(config.size),
      disks: [{
        initializeParams: {
          sourceImage: this.mapToImage(config.image)
        }
      }],
      networkInterfaces: [{
        network: config.network,
        subnetwork: config.subnet
      }],
      labels: config.tags
    };

    const [operation] = await this.compute.instances.insert({
      project: this.projectId,
      zone: config.zone,
      requestBody: instance
    });

    return this.mapToInstance(operation);
  }
}
```

### 8.3 マルチクラウドデプロイメント

```yaml
# Terraform Configuration
module "compute" {
  source = "./modules/compute"

  providers = {
    aws = aws.primary
    google = google.primary
    azurerm = azurerm.primary
  }

  cloud_provider = var.cloud_provider
  instance_config = {
    name = "tenkacloud-instance"
    size = "medium"
    image = "ubuntu-22.04"
  }
}

# Provider Mapping
variable "provider_mapping" {
  default = {
    aws = {
      instance_types = {
        small  = "t3.small"
        medium = "t3.medium"
        large  = "t3.large"
      }
    }
    gcp = {
      machine_types = {
        small  = "e2-small"
        medium = "e2-medium"
        large  = "e2-standard-4"
      }
    }
    azure = {
      vm_sizes = {
        small  = "Standard_B1s"
        medium = "Standard_B2s"
        large  = "Standard_B4ms"
      }
    }
  }
}
```

---

## 9. 認証・認可設計

### 9.1 認証フロー

```mermaid
sequenceDiagram
    participant User
    participant Frontend
    participant Gateway
    participant Identity
    participant Keycloak
    participant Database

    User->>Frontend: Login Request
    Frontend->>Gateway: POST /auth/login
    Gateway->>Identity: Authenticate
    Identity->>Keycloak: Validate Credentials
    Keycloak-->>Identity: User Info + Roles
    Identity->>Database: Log Login Event
    Identity-->>Gateway: JWT Token
    Gateway-->>Frontend: Token + Refresh Token
    Frontend->>Frontend: Store in Secure Cookie
    Frontend-->>User: Redirect to Dashboard
```

### 9.2 RBAC (Role-Based Access Control)

```typescript
// Role Definitions
enum Role {
  PLATFORM_ADMIN = 'platform_admin',
  TENANT_ADMIN = 'tenant_admin',
  BATTLE_ORGANIZER = 'battle_organizer',
  COMPETITOR = 'competitor',
  SPECTATOR = 'spectator'
}

// Permission Definitions
interface Permission {
  resource: string;
  action: string;
  scope: 'platform' | 'tenant' | 'own';
}

// Role-Permission Mapping
const rolePermissions: Record<Role, Permission[]> = {
  [Role.PLATFORM_ADMIN]: [
    { resource: '*', action: '*', scope: 'platform' }
  ],
  [Role.TENANT_ADMIN]: [
    { resource: 'tenant', action: '*', scope: 'tenant' },
    { resource: 'user', action: '*', scope: 'tenant' },
    { resource: 'battle', action: '*', scope: 'tenant' }
  ],
  [Role.BATTLE_ORGANIZER]: [
    { resource: 'battle', action: 'create', scope: 'tenant' },
    { resource: 'battle', action: 'update', scope: 'own' },
    { resource: 'challenge', action: 'assign', scope: 'own' }
  ],
  [Role.COMPETITOR]: [
    { resource: 'battle', action: 'join', scope: 'tenant' },
    { resource: 'submission', action: 'create', scope: 'own' },
    { resource: 'leaderboard', action: 'read', scope: 'tenant' }
  ],
  [Role.SPECTATOR]: [
    { resource: 'battle', action: 'read', scope: 'tenant' },
    { resource: 'leaderboard', action: 'read', scope: 'tenant' }
  ]
};
```

### 9.3 Authorization Middleware

```typescript
class AuthorizationMiddleware {
  async authorize(request: Request, resource: string, action: string) {
    // 1. Extract JWT
    const token = this.extractToken(request);
    if (!token) throw new UnauthorizedError();

    // 2. Verify JWT
    const payload = await this.verifyToken(token);

    // 3. Check Permissions
    const hasPermission = this.checkPermission(
      payload.roles,
      resource,
      action,
      payload.tid
    );

    if (!hasPermission) {
      throw new ForbiddenError();
    }

    // 4. Attach context to request
    request.context = {
      userId: payload.sub,
      tenantId: payload.tid,
      roles: payload.roles
    };

    return next();
  }
}
```

---

## 10. フロントエンド設計

### 10.1 アプリケーション構造

```
frontend/
├── control-plane/              # 管理画面
│   ├── app/
│   │   ├── (auth)/           # 認証済みレイアウト
│   │   │   ├── dashboard/
│   │   │   ├── tenants/
│   │   │   ├── users/
│   │   │   └── battles/
│   │   ├── login/
│   │   └── layout.tsx
│   ├── components/
│   │   ├── ui/              # 基本UIコンポーネント
│   │   ├── features/        # 機能別コンポーネント
│   │   └── layouts/         # レイアウトコンポーネント
│   ├── hooks/               # カスタムフック
│   ├── lib/                 # ユーティリティ
│   ├── services/            # APIクライアント
│   └── stores/              # 状態管理
│
└── application/               # 競技者画面
    ├── app/
    │   ├── (auth)/
    │   │   ├── arena/        # バトルアリーナ
    │   │   ├── challenges/   # 問題一覧
    │   │   ├── leaderboard/  # リーダーボード
    │   │   └── profile/      # プロフィール
    │   └── spectate/         # 観戦モード
    ├── components/
    ├── hooks/
    └── services/
```

### 10.2 コンポーネント設計

#### 10.2.1 Atomic Design Pattern
```typescript
// Atoms
export const Button: FC<ButtonProps> = ({ variant, size, children, ...props }) => {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-md font-medium',
        variants[variant],
        sizes[size]
      )}
      {...props}
    >
      {children}
    </button>
  );
};

// Molecules
export const FormField: FC<FormFieldProps> = ({ label, error, children }) => {
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">{label}</label>
      {children}
      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
};

// Organisms
export const BattleCard: FC<BattleCardProps> = ({ battle }) => {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{battle.name}</CardTitle>
        <CardDescription>{battle.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex justify-between">
          <Badge>{battle.status}</Badge>
          <span>{battle.participantCount} participants</span>
        </div>
      </CardContent>
      <CardFooter>
        <Button onClick={() => joinBattle(battle.id)}>Join Battle</Button>
      </CardFooter>
    </Card>
  );
};
```

### 10.3 状態管理

```typescript
// Zustand Store
interface AppStore {
  // User State
  user: User | null;
  setUser: (user: User | null) => void;

  // Battle State
  currentBattle: Battle | null;
  joinBattle: (battleId: string) => Promise<void>;
  leaveBattle: () => void;

  // WebSocket State
  socket: Socket | null;
  connectSocket: (battleId: string) => void;
  disconnectSocket: () => void;

  // UI State
  sidebarOpen: boolean;
  toggleSidebar: () => void;
}

export const useAppStore = create<AppStore>((set, get) => ({
  user: null,
  setUser: (user) => set({ user }),

  currentBattle: null,
  joinBattle: async (battleId) => {
    const battle = await battleApi.join(battleId);
    set({ currentBattle: battle });
    get().connectSocket(battleId);
  },

  leaveBattle: () => {
    get().disconnectSocket();
    set({ currentBattle: null });
  },

  socket: null,
  connectSocket: (battleId) => {
    const socket = io(`/battles/${battleId}`);
    set({ socket });
  },

  disconnectSocket: () => {
    const { socket } = get();
    socket?.disconnect();
    set({ socket: null });
  },

  sidebarOpen: true,
  toggleSidebar: () => set(state => ({ sidebarOpen: !state.sidebarOpen }))
}));
```

### 10.4 API クライアント

```typescript
// API Client with Interceptors
class TenkaCloudApiClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: process.env.NEXT_PUBLIC_API_URL,
      timeout: 30000
    });

    // Request Interceptor
    this.client.interceptors.request.use(
      (config) => {
        const token = this.getToken();
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
      },
      (error) => Promise.reject(error)
    );

    // Response Interceptor
    this.client.interceptors.response.use(
      (response) => response.data,
      async (error) => {
        if (error.response?.status === 401) {
          await this.refreshToken();
          return this.client.request(error.config);
        }
        return Promise.reject(error);
      }
    );
  }

  async get<T>(url: string, params?: any): Promise<T> {
    return this.client.get(url, { params });
  }

  async post<T>(url: string, data?: any): Promise<T> {
    return this.client.post(url, data);
  }
}
```

---

## 11. バックエンド設計

### 11.1 サービスアーキテクチャ

```typescript
// Base Service Class
abstract class TenkaCloudBaseService {
  protected db: DatabaseClient;
  protected cache: CacheClient;
  protected logger: Logger;
  protected metrics: MetricsCollector;

  constructor(dependencies: ServiceDependencies) {
    this.db = dependencies.db;
    this.cache = dependencies.cache;
    this.logger = dependencies.logger;
    this.metrics = dependencies.metrics;
  }

  protected async withTransaction<T>(
    callback: (tx: Transaction) => Promise<T>
  ): Promise<T> {
    const tx = await this.db.beginTransaction();
    try {
      const result = await callback(tx);
      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  protected async withCache<T>(
    key: string,
    ttl: number,
    factory: () => Promise<T>
  ): Promise<T> {
    const cached = await this.cache.get<T>(key);
    if (cached) return cached;

    const value = await factory();
    await this.cache.set(key, value, ttl);
    return value;
  }
}
```

### 11.2 Repository Pattern

```typescript
// Generic Repository
abstract class TenkaCloudRepository<T extends { id: string }> {
  constructor(
    protected tableName: string,
    protected db: DatabaseClient
  ) {}

  async findById(id: string): Promise<T | null> {
    return this.db.get({
      TableName: this.tableName,
      Key: { id }
    });
  }

  async findAll(filter?: Partial<T>): Promise<T[]> {
    return this.db.scan({
      TableName: this.tableName,
      FilterExpression: this.buildFilterExpression(filter)
    });
  }

  async create(data: Omit<T, 'id'>): Promise<T> {
    const item = {
      ...data,
      id: generateId(),
      createdAt: new Date().toISOString()
    } as T;

    await this.db.put({
      TableName: this.tableName,
      Item: item
    });

    return item;
  }

  async update(id: string, data: Partial<T>): Promise<T> {
    const updated = await this.db.update({
      TableName: this.tableName,
      Key: { id },
      UpdateExpression: this.buildUpdateExpression(data),
      ReturnValues: 'ALL_NEW'
    });

    return updated.Attributes as T;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete({
      TableName: this.tableName,
      Key: { id }
    });
  }
}

// Specific Repository
class BattleRepository extends TenkaCloudRepository<Battle> {
  constructor(db: DatabaseClient) {
    super('Battles', db);
  }

  async findByTenant(tenantId: string): Promise<Battle[]> {
    return this.db.query({
      TableName: this.tableName,
      IndexName: 'TenantIndex',
      KeyConditionExpression: 'tenantId = :tenantId',
      ExpressionAttributeValues: {
        ':tenantId': tenantId
      }
    });
  }

  async findActive(): Promise<Battle[]> {
    return this.db.query({
      TableName: this.tableName,
      IndexName: 'StatusIndex',
      KeyConditionExpression: 'status = :status',
      ExpressionAttributeValues: {
        ':status': 'active'
      }
    });
  }
}
```

### 11.3 Event-Driven Architecture

```typescript
// Event Bus
interface TenkaCloudEventBus {
  publish(event: DomainEvent): Promise<void>;
  subscribe(eventType: string, handler: EventHandler): void;
}

// Domain Events
abstract class TenkaCloudDomainEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly aggregateId: string;
  readonly tenantId: string;

  constructor(aggregateId: string, tenantId: string) {
    this.eventId = generateId();
    this.eventType = this.constructor.name;
    this.occurredAt = new Date();
    this.aggregateId = aggregateId;
    this.tenantId = tenantId;
  }
}

// Specific Events
class BattleStartedEvent extends TenkaCloudDomainEvent {
  constructor(
    public battleId: string,
    public tenantId: string,
    public participants: string[]
  ) {
    super(battleId, tenantId);
  }
}

// Event Handlers
class TenkaCloudBattleEventHandler {
  @EventHandler(BattleStartedEvent)
  async handleBattleStarted(event: BattleStartedEvent) {
    // 1. Initialize scoring
    await this.scoringService.initializeBattle(event.battleId);

    // 2. Setup monitoring
    await this.monitoringService.startBattleMetrics(event.battleId);

    // 3. Notify participants
    await this.notificationService.notifyBattleStart(
      event.participants,
      event.battleId
    );

    // 4. Log event
    await this.auditService.logEvent(event);
  }
}
```

---

## 12. 競技システム設計

### 12.1 バトルライフサイクル

```mermaid
stateDiagram-v2
    [*] --> Scheduled: Create Battle
    Scheduled --> Registration: Open Registration
    Registration --> Preparation: Close Registration
    Preparation --> Active: Start Battle
    Active --> Ending: Time Limit Reached
    Active --> Ending: Manual End
    Ending --> Completed: Calculate Final Scores
    Completed --> Archived: Archive After 30 Days
    Archived --> [*]

    Registration --> Cancelled: Cancel
    Preparation --> Cancelled: Cancel
    Cancelled --> [*]
```

### 12.2 バトル実行エンジン

```typescript
class TenkaCloudBattleEngine {
  private battles: Map<string, BattleSession> = new Map();

  async startBattle(battleId: string): Promise<void> {
    const battle = await this.battleRepository.findById(battleId);
    if (!battle) throw new NotFoundError('Battle', battleId);

    const session = new BattleSession(battle);
    this.battles.set(battleId, session);

    // 1. Deploy infrastructure for each team
    await this.deployInfrastructure(battle);

    // 2. Start monitoring
    await this.startMonitoring(battle);

    // 3. Initialize scoring
    await this.initializeScoring(battle);

    // 4. Set battle timer
    this.setBattleTimer(battle);

    // 5. Emit start event
    await this.eventBus.publish(new BattleStartedEvent(battle));
  }

  private async deployInfrastructure(battle: Battle): Promise<void> {
    const deployments = battle.teams.map(async (team) => {
      const account = await this.allocateCloudAccount(team.id);

      for (const challenge of battle.challenges) {
        await this.deployChallenge(challenge, account);
      }

      return {
        teamId: team.id,
        accountId: account.id,
        resources: await this.getDeployedResources(account)
      };
    });

    await Promise.all(deployments);
  }

  private setBattleTimer(battle: Battle): void {
    const duration = battle.endTime.getTime() - Date.now();

    setTimeout(async () => {
      await this.endBattle(battle.id);
    }, duration);
  }
}
```

### 12.3 リアルタイム進捗追跡

```typescript
class TenkaCloudProgressTracker {
  private io: Server;
  private progressData: Map<string, TeamProgress> = new Map();

  constructor(io: Server) {
    this.io = io;
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.io.on('connection', (socket) => {
      socket.on('join-battle', ({ battleId, teamId }) => {
        socket.join(`battle:${battleId}`);
        socket.join(`team:${teamId}`);

        // Send current state
        const progress = this.progressData.get(teamId);
        socket.emit('progress-update', progress);
      });

      socket.on('challenge-attempt', async ({ challengeId, answer }) => {
        const result = await this.validateAnswer(challengeId, answer);

        if (result.correct) {
          await this.updateProgress(socket.teamId, challengeId);
          this.broadcastUpdate(socket.battleId);
        }

        socket.emit('attempt-result', result);
      });
    });
  }

  private async updateProgress(
    teamId: string,
    challengeId: string
  ): Promise<void> {
    const progress = this.progressData.get(teamId) || new TeamProgress();
    progress.completedChallenges.add(challengeId);
    progress.lastUpdate = new Date();

    this.progressData.set(teamId, progress);

    // Persist to database
    await this.saveProgress(teamId, progress);
  }

  private broadcastUpdate(battleId: string): void {
    const leaderboard = this.calculateLeaderboard(battleId);
    this.io.to(`battle:${battleId}`).emit('leaderboard-update', leaderboard);
  }
}
```

---

## 13. 問題管理システム

### 13.1 問題定義フォーマット

```yaml
# challenge-definition.yaml
metadata:
  id: challenge-001
  title: "Secure Web Application Deployment"
  category: "Security"
  difficulty: 1  # 0=Easy, 1=Medium, 2=Hard
  points: 100
  timeLimit: 60  # minutes
  tags:
    - web
    - security
    - aws

requirements:
  - "Deploy a web application with HTTPS"
  - "Implement WAF rules"
  - "Setup automated backups"
  - "Configure monitoring alerts"

infrastructure:
  provider: aws
  template:
    type: cloudformation
    file: template.yaml
    parameters:
      InstanceType: t3.micro
      KeyName: "{{TEAM_KEY}}"
      TeamId: "{{TEAM_ID}}"

validation:
  - type: https_check
    endpoint: "https://{{OUTPUT.WebsiteURL}}"
    expected: 200

  - type: waf_check
    resource: "{{OUTPUT.WAFArn}}"
    rules:
      - SQLInjection
      - XSS

  - type: backup_check
    resource: "{{OUTPUT.DBInstanceId}}"
    backupEnabled: true

  - type: monitoring_check
    alarms:
      - CPUUtilization
      - UnhealthyHostCount

hints:
  - level: 1
    content: "Use AWS Certificate Manager for HTTPS"
    penalty: 10

  - level: 2
    content: "WAF should be attached to CloudFront"
    penalty: 20

  - level: 3
    content: "RDS automated backups configuration"
    penalty: 30

solution:
  documentation: solution.md
  referenceImplementation: reference/
```

### 13.2 問題デプロイメントエンジン

```typescript
class TenkaCloudChallengeDeployer {
  async deployChallenge(
    challenge: Challenge,
    targetAccount: CloudAccount
  ): Promise<DeploymentResult> {
    // 1. Get cloud credentials
    const credentials = await this.getCredentials(targetAccount);

    // 2. Prepare template
    const template = await this.prepareTemplate(challenge, targetAccount);

    // 3. Deploy infrastructure
    const deploymentId = await this.deployInfrastructure(template, credentials);

    // 4. Wait for completion
    await this.waitForDeployment(deploymentId, credentials);

    // 5. Get outputs
    const outputs = await this.getDeploymentOutputs(deploymentId, credentials);

    // 6. Store deployment info
    await this.storeDeployment({
      challengeId: challenge.id,
      accountId: targetAccount.id,
      deploymentId,
      outputs,
      deployedAt: new Date()
    });

    return { deploymentId, outputs };
  }

  private async prepareTemplate(
    challenge: Challenge,
    account: CloudAccount
  ): Promise<string> {
    let template = challenge.infrastructure.template.content;

    // Replace placeholders
    const replacements = {
      '{{TEAM_ID}}': account.teamId,
      '{{TEAM_KEY}}': account.keyPair,
      '{{RANDOM_STRING}}': generateRandomString(),
      '{{REGION}}': account.region
    };

    for (const [placeholder, value] of Object.entries(replacements)) {
      template = template.replace(new RegExp(placeholder, 'g'), value);
    }

    return template;
  }
}
```

### 13.3 問題バリデーター

```typescript
class TenkaCloudChallengeValidator {
  private validators: Map<string, Validator> = new Map();

  constructor() {
    this.registerValidators();
  }

  private registerValidators(): void {
    this.validators.set('https_check', new HttpsValidator());
    this.validators.set('waf_check', new WAFValidator());
    this.validators.set('backup_check', new BackupValidator());
    this.validators.set('monitoring_check', new MonitoringValidator());
    this.validators.set('resource_check', new ResourceValidator());
    this.validators.set('security_check', new SecurityValidator());
  }

  async validate(
    submission: Submission,
    challenge: Challenge
  ): Promise<ValidationResult> {
    const results: ValidationResult[] = [];

    for (const check of challenge.validation) {
      const validator = this.validators.get(check.type);
      if (!validator) {
        throw new Error(`Unknown validator type: ${check.type}`);
      }

      const result = await validator.validate(submission, check);
      results.push(result);
    }

    return this.aggregateResults(results);
  }
}
```

---

## 14. 採点システム

### 14.1 採点エンジンアーキテクチャ

```typescript
class TenkaCloudScoringEngine {
  private scoringQueue: Queue;
  private validators: ValidatorRegistry;
  private metrics: MetricsCollector;

  async evaluateSubmission(submission: Submission): Promise<ScoringResult> {
    const startTime = Date.now();

    try {
      // 1. Validate submission format
      await this.validateSubmissionFormat(submission);

      // 2. Get challenge details
      const challenge = await this.getChallenge(submission.challengeId);

      // 3. Run validation checks
      const validationResults = await this.runValidations(submission, challenge);

      // 4. Calculate scores
      const scores = this.calculateScores(validationResults, challenge);

      // 5. Apply penalties
      const finalScore = this.applyPenalties(scores, submission);

      // 6. Store results
      await this.storeResults(submission, finalScore);

      // 7. Update leaderboard
      await this.updateLeaderboard(submission.teamId, finalScore);

      // 8. Emit events
      await this.emitScoringEvents(submission, finalScore);

      this.metrics.recordScoring(Date.now() - startTime);

      return finalScore;
    } catch (error) {
      this.logger.error('Scoring failed', { submission, error });
      throw error;
    }
  }

  private calculateScores(
    results: ValidationResult[],
    challenge: Challenge
  ): ScoreBreakdown {
    const breakdown: ScoreBreakdown = {
      functionality: 0,
      security: 0,
      performance: 0,
      costOptimization: 0,
      total: 0
    };

    // Weight configuration
    const weights = {
      functionality: 0.4,
      security: 0.3,
      performance: 0.2,
      costOptimization: 0.1
    };

    // Calculate category scores
    for (const result of results) {
      const category = this.getCategory(result.checkType);
      breakdown[category] += result.score;
    }

    // Apply weights
    breakdown.total = Object.entries(weights).reduce(
      (total, [category, weight]) => total + breakdown[category] * weight,
      0
    );

    return breakdown;
  }

  private applyPenalties(
    scores: ScoreBreakdown,
    submission: Submission
  ): ScoringResult {
    let penalty = 0;

    // Time penalty
    const timeTaken = submission.submittedAt - submission.startedAt;
    const timeLimit = submission.challenge.timeLimit * 60 * 1000;
    if (timeTaken > timeLimit) {
      const overtime = timeTaken - timeLimit;
      penalty += Math.floor(overtime / 60000) * 5; // 5 points per minute
    }

    // Hint penalty
    penalty += submission.hintsUsed.reduce((sum, hint) => sum + hint.penalty, 0);

    // Failed attempt penalty
    penalty += submission.attemptCount * 2;

    const finalScore = Math.max(0, scores.total - penalty);

    return {
      ...scores,
      penalties: penalty,
      finalScore,
      timestamp: new Date()
    };
  }
}
```

### 14.2 自動採点Lambda関数

```typescript
// Lambda Handler for Scoring
export const scoringHandler = async (event: SQSEvent): Promise<void> => {
  const scoringEngine = new TenkaCloudScoringEngine();

  for (const record of event.Records) {
    const submission: Submission = JSON.parse(record.body);

    try {
      // 1. Get cloud provider credentials
      const credentials = await getCloudCredentials(submission.accountId);

      // 2. Initialize cloud clients
      const clients = initializeCloudClients(credentials, submission.provider);

      // 3. Run infrastructure checks
      const infraChecks = await runInfrastructureChecks(clients, submission);

      // 4. Run security checks
      const securityChecks = await runSecurityChecks(clients, submission);

      // 5. Run performance tests
      const perfResults = await runPerformanceTests(submission.endpoint);

      // 6. Calculate cost estimate
      const costEstimate = await calculateCostEstimate(clients);

      // 7. Aggregate results
      const scoringResult = await scoringEngine.evaluate({
        submission,
        infrastructure: infraChecks,
        security: securityChecks,
        performance: perfResults,
        cost: costEstimate
      });

      // 8. Store results
      await storeScoringResults(scoringResult);

      // 9. Notify team
      await notifyTeam(submission.teamId, scoringResult);

    } catch (error) {
      console.error('Scoring failed:', error);
      await handleScoringError(submission, error);
    }
  }
};
```

---

## 15. インフラストラクチャ設計

### 15.1 Kubernetes アーキテクチャ

```yaml
# EKS Cluster Configuration
apiVersion: eksctl.io/v1alpha5
kind: ClusterConfig

metadata:
  name: tenkacloud-cluster
  region: ap-northeast-1
  version: "1.31"

nodeGroups:
  - name: control-plane-nodes
    instanceType: t3.medium
    desiredCapacity: 3
    minSize: 3
    maxSize: 5
    labels:
      nodeType: control-plane
    taints:
      - key: control-plane
        value: "true"
        effect: NoSchedule

  - name: application-nodes
    instanceType: t3.large
    desiredCapacity: 5
    minSize: 3
    maxSize: 10
    labels:
      nodeType: application
    autoScaling: true

  - name: scoring-nodes
    instanceType: c5.xlarge
    desiredCapacity: 2
    minSize: 1
    maxSize: 5
    labels:
      nodeType: scoring
    spot: true

addons:
  - name: vpc-cni
    version: latest
  - name: kube-proxy
    version: latest
  - name: aws-ebs-csi-driver
    version: latest
```

### 15.2 Service Deployment

```yaml
# Control Plane Service Example
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tenant-service
  namespace: tenkacloud-control
spec:
  replicas: 3
  selector:
    matchLabels:
      app: tenant-service
  template:
    metadata:
      labels:
        app: tenant-service
    spec:
      nodeSelector:
        nodeType: control-plane
      containers:
      - name: tenant-service
        image: ghcr.io/tenkacloud/tenant-service:latest
        ports:
        - containerPort: 3000
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: db-secret
              key: url
        - name: REDIS_URL
          valueFrom:
            secretKeyRef:
              name: redis-secret
              key: url
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: tenant-service
  namespace: tenkacloud-control
spec:
  selector:
    app: tenant-service
  ports:
  - port: 80
    targetPort: 3000
  type: ClusterIP
```

### 15.3 Terraform Modules

```hcl
# Main Infrastructure Module
module "tenkacloud_infrastructure" {
  source = "./modules/infrastructure"

  environment = var.environment
  region      = var.region

  # VPC Configuration
  vpc_cidr = "10.0.0.0/16"
  availability_zones = ["ap-northeast-1a", "ap-northeast-1c"]

  # EKS Configuration
  eks_cluster_name = "tenkacloud-${var.environment}"
  eks_version      = "1.31"

  # Database Configuration
  dynamodb_tables = {
    tenants = {
      hash_key = "tenantId"
      billing_mode = "PAY_PER_REQUEST"
    }
    users = {
      hash_key = "userId"
      billing_mode = "PAY_PER_REQUEST"
    }
    battles = {
      hash_key = "battleId"
      billing_mode = "ON_DEMAND"
    }
  }

  # Cache Configuration
  redis_node_type = "cache.t3.micro"
  redis_num_nodes = 2

  # S3 Buckets
  s3_buckets = [
    "challenges",
    "submissions",
    "artifacts",
    "logs"
  ]

  tags = {
    Project     = "TenkaCloud"
    Environment = var.environment
    ManagedBy   = "Terraform"
  }
}
```

---

## 16. AI機能設計

### 16.1 AI アーキテクチャ

```typescript
// AI Service Interface
interface AIService {
  // Problem Generation
  generateChallenge(params: ChallengeParams): Promise<Challenge>;

  // Scoring Optimization
  optimizeScoring(history: ScoringHistory): Promise<ScoringWeights>;

  // Coaching
  provideHint(context: ChallengeContext): Promise<Hint>;
  analyzeSubmission(submission: Submission): Promise<Analysis>;

  // Content Generation
  generateDocumentation(challenge: Challenge): Promise<Documentation>;
  generateTestCases(challenge: Challenge): Promise<TestCase[]>;
}
```

### 16.2 Claude Integration

```typescript
class ClaudeAIService implements AIService {
  private client: AnthropicClient;
  private mcpServer: MCPServer;

  constructor() {
    this.client = new AnthropicClient({
      apiKey: process.env.CLAUDE_API_KEY
    });

    this.mcpServer = new MCPServer({
      tools: ['code-interpreter', 'web-browser', 'file-system']
    });
  }

  async generateChallenge(params: ChallengeParams): Promise<Challenge> {
    const prompt = this.buildChallengePrompt(params);

    const response = await this.client.messages.create({
      model: 'claude-3-opus-20240229',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    return this.parseChallengeResponse(response);
  }

  async provideHint(context: ChallengeContext): Promise<Hint> {
    const prompt = `
      Challenge: ${context.challenge.title}
      Current Progress: ${context.progress}
      Failed Attempts: ${context.attempts}
      Time Elapsed: ${context.timeElapsed}

      Provide a helpful hint that guides without giving away the solution.
    `;

    const response = await this.client.messages.create({
      model: 'claude-3-sonnet-20240229',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    return {
      content: response.content[0].text,
      level: this.calculateHintLevel(context),
      penalty: this.calculatePenalty(context)
    };
  }
}
```

### 16.3 Problem Generation Pipeline

```typescript
class ProblemGenerationPipeline {
  async generateProblem(requirements: ProblemRequirements): Promise<GeneratedProblem> {
    // 1. Generate problem concept
    const concept = await this.generateConcept(requirements);

    // 2. Create infrastructure template
    const template = await this.generateTemplate(concept);

    // 3. Generate validation tests
    const validations = await this.generateValidations(concept);

    // 4. Create solution documentation
    const solution = await this.generateSolution(concept, template);

    // 5. Generate hints
    const hints = await this.generateHints(concept, solution);

    // 6. Validate completeness
    await this.validateProblem({
      concept,
      template,
      validations,
      solution,
      hints
    });

    return {
      metadata: this.buildMetadata(concept),
      infrastructure: template,
      validation: validations,
      hints,
      solution
    };
  }
}
```

---

## 17. セキュリティ設計

### 17.1 セキュリティアーキテクチャ

```yaml
Security Layers:
  1. Network Security:
     - VPC isolation
     - Security Groups
     - NACLs
     - Private subnets
     - VPN/Direct Connect

  2. Application Security:
     - JWT authentication
     - OAuth 2.0 / OIDC
     - API rate limiting
     - Input validation
     - SQL injection prevention
     - XSS protection
     - CSRF tokens

  3. Data Security:
     - Encryption at rest (AES-256)
     - Encryption in transit (TLS 1.3)
     - Key management (AWS KMS)
     - Data masking
     - PII protection

  4. Infrastructure Security:
     - IAM roles and policies
     - Least privilege principle
     - Pod Security Policies
     - Network Policies
     - Container scanning
     - Vulnerability assessment

  5. Compliance:
     - GDPR compliance
     - SOC 2
     - ISO 27001
     - PCI DSS (if payment processing)
```

### 17.2 Security Implementation

```typescript
// Security Middleware Stack
class SecurityMiddleware {
  // Rate Limiting
  rateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute
    keyGenerator: (req) => req.user?.id || req.ip
  });

  // CORS Configuration
  cors = cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || [],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
  });

  // Helmet Security Headers
  helmet = helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "wss:"]
      }
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    }
  });

  // Input Sanitization
  sanitize(input: any): any {
    if (typeof input === 'string') {
      return DOMPurify.sanitize(input);
    }
    if (Array.isArray(input)) {
      return input.map(item => this.sanitize(item));
    }
    if (typeof input === 'object' && input !== null) {
      const sanitized: any = {};
      for (const [key, value] of Object.entries(input)) {
        sanitized[key] = this.sanitize(value);
      }
      return sanitized;
    }
    return input;
  }
}
```

### 17.3 Audit Logging

```typescript
class AuditLogger {
  async logSecurityEvent(event: SecurityEvent): Promise<void> {
    const auditEntry = {
      timestamp: new Date().toISOString(),
      eventType: event.type,
      severity: event.severity,
      userId: event.userId,
      tenantId: event.tenantId,
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
      resource: event.resource,
      action: event.action,
      outcome: event.outcome,
      details: event.details
    };

    // Store in database
    await this.db.put({
      TableName: 'SecurityAuditLogs',
      Item: auditEntry
    });

    // Alert on critical events
    if (event.severity === 'CRITICAL') {
      await this.alertSecurityTeam(auditEntry);
    }
  }
}
```

---

## 18. パフォーマンス設計

### 18.1 パフォーマンス目標

| メトリクス | 目標値 | 測定方法 |
|-----------|--------|----------|
| API レスポンスタイム (p50) | <100ms | APM |
| API レスポンスタイム (p99) | <500ms | APM |
| WebSocket レイテンシー | <50ms | Custom Metrics |
| ページロード時間 | <2s | Lighthouse |
| Time to Interactive | <3s | Lighthouse |
| データベースクエリ時間 | <50ms | DB Metrics |
| キャッシュヒット率 | >90% | Redis Metrics |
| CDN キャッシュヒット率 | >95% | CloudFront Metrics |

### 18.2 パフォーマンス最適化

```typescript
// Caching Strategy
class CachingService {
  private redis: RedisClient;
  private memoryCache: Map<string, CacheEntry> = new Map();

  // Multi-layer caching
  async get<T>(key: string): Promise<T | null> {
    // L1: Memory cache
    const memoryHit = this.memoryCache.get(key);
    if (memoryHit && memoryHit.expiry > Date.now()) {
      return memoryHit.value as T;
    }

    // L2: Redis cache
    const redisHit = await this.redis.get(key);
    if (redisHit) {
      // Populate memory cache
      this.memoryCache.set(key, {
        value: redisHit,
        expiry: Date.now() + 60000 // 1 minute
      });
      return JSON.parse(redisHit) as T;
    }

    return null;
  }

  async set<T>(key: string, value: T, ttl: number): Promise<void> {
    // Set in both caches
    this.memoryCache.set(key, {
      value,
      expiry: Date.now() + (ttl * 1000)
    });

    await this.redis.setex(key, ttl, JSON.stringify(value));
  }
}

// Database Query Optimization
class OptimizedRepository {
  // Batch loading
  async batchLoad<T>(ids: string[]): Promise<Map<string, T>> {
    const results = await this.db.batchGet({
      RequestItems: {
        [this.tableName]: {
          Keys: ids.map(id => ({ id }))
        }
      }
    });

    return new Map(
      results.Responses[this.tableName].map(item => [item.id, item])
    );
  }

  // Pagination with cursor
  async paginate<T>(cursor?: string, limit = 20): Promise<PaginatedResult<T>> {
    const params = {
      TableName: this.tableName,
      Limit: limit,
      ...(cursor && { ExclusiveStartKey: JSON.parse(Buffer.from(cursor, 'base64').toString()) })
    };

    const result = await this.db.scan(params);

    return {
      items: result.Items as T[],
      nextCursor: result.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
        : null
    };
  }
}
```

### 18.3 Frontend Performance

```typescript
// Next.js Performance Optimizations
export const config = {
  // Image optimization
  images: {
    domains: ['cdn.tenkacloud.io'],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920],
    imageSizes: [16, 32, 48, 64, 96, 128, 256],
    formats: ['image/webp', 'image/avif']
  },

  // Build optimizations
  webpack: (config, { dev, isServer }) => {
    // Production optimizations
    if (!dev && !isServer) {
      config.optimization.splitChunks = {
        chunks: 'all',
        cacheGroups: {
          vendor: {
            name: 'vendor',
            test: /node_modules/,
            priority: 10,
            reuseExistingChunk: true
          },
          common: {
            minChunks: 2,
            priority: 5,
            reuseExistingChunk: true
          }
        }
      };
    }
    return config;
  }
};

// Lazy loading components
const BattleArena = dynamic(() => import('@/components/BattleArena'), {
  loading: () => <ArenaLoader />,
  ssr: false
});

// Virtual scrolling for large lists
const LeaderboardList = ({ entries }: { entries: LeaderboardEntry[] }) => {
  const rowVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 60,
    overscan: 5
  });

  return (
    <div ref={parentRef} style={{ height: '600px', overflow: 'auto' }}>
      <div style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
        {rowVirtualizer.getVirtualItems().map(virtualItem => (
          <LeaderboardRow
            key={virtualItem.key}
            entry={entries[virtualItem.index]}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: `${virtualItem.size}px`,
              transform: `translateY(${virtualItem.start}px)`
            }}
          />
        ))}
      </div>
    </div>
  );
};
```

---

## 19. デプロイメント戦略

### 19.1 CI/CD Pipeline

```yaml
# GitHub Actions Workflow
name: Deploy to Production

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install

      - name: Run tests
        run: bun test:coverage

      - name: Upload coverage
        uses: codecov/codecov-action@v3

  build:
    needs: test
    runs-on: ubuntu-latest
    strategy:
      matrix:
        service: [tenant-service, identity-service, battle-service]

    steps:
      - uses: actions/checkout@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v2

      - name: Login to GitHub Container Registry
        uses: docker/login-action@v2
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push Docker image
        uses: docker/build-push-action@v4
        with:
          context: ./backend/services/${{ matrix.service }}
          push: true
          tags: |
            ghcr.io/tenkacloud/${{ matrix.service }}:${{ github.sha }}
            ghcr.io/tenkacloud/${{ matrix.service }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy:
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'

    steps:
      - uses: actions/checkout@v3

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v2
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ap-northeast-1

      - name: Update kubeconfig
        run: aws eks update-kubeconfig --name tenkacloud-cluster

      - name: Deploy to Kubernetes
        run: |
          kubectl set image deployment/tenant-service \
            tenant-service=ghcr.io/tenkacloud/tenant-service:${{ github.sha }} \
            -n tenkacloud-control

          kubectl rollout status deployment/tenant-service -n tenkacloud-control
```

### 19.2 Blue-Green Deployment

```typescript
// Deployment Manager
class DeploymentManager {
  async deployBlueGreen(service: string, newVersion: string): Promise<void> {
    // 1. Deploy to green environment
    await this.deployToEnvironment('green', service, newVersion);

    // 2. Run health checks
    await this.runHealthChecks('green', service);

    // 3. Run smoke tests
    await this.runSmokeTests('green', service);

    // 4. Gradual traffic shift
    for (const percentage of [10, 25, 50, 75, 100]) {
      await this.shiftTraffic('green', percentage);
      await this.monitorMetrics(service, 5 * 60 * 1000); // 5 minutes

      if (await this.detectAnomalies(service)) {
        await this.rollback('blue');
        throw new Error('Deployment failed due to anomalies');
      }
    }

    // 5. Complete deployment
    await this.promoteEnvironment('green', 'blue');
    await this.cleanupOldEnvironment();
  }
}
```

### 19.3 Database Migration

```typescript
// Migration Runner
class MigrationRunner {
  async runMigrations(): Promise<void> {
    const migrations = await this.loadPendingMigrations();

    for (const migration of migrations) {
      console.log(`Running migration: ${migration.name}`);

      try {
        await this.beginTransaction();
        await migration.up();
        await this.recordMigration(migration.name);
        await this.commitTransaction();

        console.log(`Migration ${migration.name} completed successfully`);
      } catch (error) {
        await this.rollbackTransaction();
        console.error(`Migration ${migration.name} failed:`, error);
        throw error;
      }
    }
  }

  async rollbackMigration(name: string): Promise<void> {
    const migration = await this.loadMigration(name);

    await this.beginTransaction();
    await migration.down();
    await this.removeMigrationRecord(name);
    await this.commitTransaction();
  }
}
```

---

## 20. 運用・監視設計

### 20.1 監視アーキテクチャ

```yaml
Monitoring Stack:
  Metrics:
    - Prometheus: メトリクス収集
    - Grafana: ダッシュボード
    - CloudWatch: AWS メトリクス

  Logging:
    - Fluentd: ログ収集
    - Elasticsearch: ログ保存
    - Kibana: ログ分析

  Tracing:
    - OpenTelemetry: トレース収集
    - Jaeger: 分散トレーシング

  Alerting:
    - AlertManager: アラート管理
    - PagerDuty: インシデント管理
    - Slack: 通知
```

### 20.2 SLO/SLI Definition

```typescript
// Service Level Indicators
interface SLI {
  availability: {
    formula: 'successful_requests / total_requests';
    target: 0.999; // 99.9%
  };

  latency: {
    formula: 'requests_under_200ms / total_requests';
    target: 0.95; // 95% of requests under 200ms
  };

  errorRate: {
    formula: 'error_responses / total_responses';
    target: 0.01; // Less than 1% errors
  };
}

// Service Level Objectives
interface SLO {
  monthly: {
    availability: 0.999;
    errorBudget: '43.2 minutes'; // 30 days * 0.1%
  };

  weekly: {
    availability: 0.999;
    errorBudget: '10.08 minutes'; // 7 days * 0.1%
  };
}
```

### 20.3 Incident Response

```typescript
// Incident Management
class IncidentManager {
  async handleIncident(alert: Alert): Promise<void> {
    // 1. Create incident
    const incident = await this.createIncident(alert);

    // 2. Notify on-call
    await this.notifyOnCall(incident);

    // 3. Start incident timeline
    await this.startTimeline(incident);

    // 4. Run automated diagnostics
    const diagnostics = await this.runDiagnostics(incident);

    // 5. Attempt auto-remediation
    if (this.canAutoRemediate(incident, diagnostics)) {
      await this.autoRemediate(incident);
    }

    // 6. Escalate if needed
    if (incident.severity === 'CRITICAL') {
      await this.escalate(incident);
    }

    // 7. Track resolution
    await this.trackResolution(incident);
  }

  async runDiagnostics(incident: Incident): Promise<Diagnostics> {
    return {
      logs: await this.collectLogs(incident.service, incident.timeRange),
      metrics: await this.collectMetrics(incident.service, incident.timeRange),
      traces: await this.collectTraces(incident.service, incident.timeRange),
      healthChecks: await this.runHealthChecks(incident.service),
      dependencies: await this.checkDependencies(incident.service)
    };
  }
}
```

---

## 付録A: API仕様書

API 仕様の詳細は別ドキュメント「API-Specification.md」を参照してください。

---

## 付録B: データベース詳細設計

データベース設計の詳細は「Database-Design.md」を参照してください。

---

## 付録C: セキュリティチェックリスト

セキュリティチェックリストは「Security-Design.md」にまとめています。

---

## まとめ

TenkaCloud Platform は、スクラッチから開発される OSS クラウド競技プラットフォームとして、次の特徴を備えています。

1. **マルチテナント・マルチクラウド対応**: 拡張性の高いアーキテクチャ
2. **マイクロサービス設計**: 独立したサービスによる高い保守性
3. **リアルタイム競技システム**: WebSocket による即座のフィードバック
4. **AI支援機能**: Claude API による問題生成と採点最適化
5. **包括的なセキュリティ**: OWASP Top 10 対応とゼロトラストアーキテクチャ
6. **高パフォーマンス**: 多層キャッシュと CDN 活用
7. **完全自動化**: CI/CD パイプラインによる継続的デプロイ

この設計書に基づいて実装を進めることで、エンタープライズグレードのクラウド競技プラットフォームを構築できます。

---

**Document Version**: 1.0
**Last Updated**: 2025-11-21
**Status**: Final Design
**License**: MIT

---

## 21. AWS Console Access Integration

### 21.1 概要

TenkaCloud プラットフォームから直接 AWS Management Console にアクセスできる統合機能を提供します。これにより、競技者は問題解決中にシームレスに AWS リソースを操作できます。

### 21.2 実装方式

#### 21.2.1 AWS STS (Security Token Service) Integration

```typescript
// AWS Console Access Manager
export class AWSConsoleAccessManager {
  private stsClient: STSClient;

  constructor(private readonly config: AWSConfig) {
    this.stsClient = new STSClient({
      region: config.region,
      credentials: config.credentials
    });
  }

  async generateConsoleAccessURL(params: {
    tenantId: string;
    userId: string;
    battleId: string;
    permissions: string[];
  }): Promise<string> {
    // 1. Assume Role for Battle Participant
    const assumeRoleResponse = await this.stsClient.send(
      new AssumeRoleCommand({
        RoleArn: `arn:aws:iam::${this.config.accountId}:role/TenkaCloudBattleRole`,
        RoleSessionName: `battle-${params.battleId}-${params.userId}`,
        DurationSeconds: 3600, // 1 hour
        Policy: this.generateScopedPolicy(params.permissions)
      })
    );

    // 2. Generate Console Sign-in URL
    const signInToken = await this.getSignInToken(
      assumeRoleResponse.Credentials!
    );

    // 3. Construct Console URL
    const consoleUrl = this.constructConsoleUrl({
      signInToken,
      destination: 'https://console.aws.amazon.com/',
      issuer: 'TenkaCloud'
    });

    return consoleUrl;
  }

  private generateScopedPolicy(permissions: string[]): string {
    return JSON.stringify({
      Version: '2012-10-17',
      Statement: permissions.map(permission => ({
        Effect: 'Allow',
        Action: permission,
        Resource: '*'
      }))
    });
  }

  private async getSignInToken(credentials: Credentials): Promise<string> {
    const session = {
      sessionId: credentials.AccessKeyId,
      sessionKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken
    };

    const response = await fetch(
      'https://signin.aws.amazon.com/federation',
      {
        method: 'GET',
        params: {
          Action: 'getSigninToken',
          Session: encodeURIComponent(JSON.stringify(session))
        }
      }
    );

    const data = await response.json();
    return data.SigninToken;
  }

  private constructConsoleUrl(params: {
    signInToken: string;
    destination: string;
    issuer: string;
  }): string {
    const baseUrl = 'https://signin.aws.amazon.com/federation';
    const urlParams = new URLSearchParams({
      Action: 'login',
      SigninToken: params.signInToken,
      Destination: params.destination,
      Issuer: params.issuer
    });

    return `${baseUrl}?${urlParams.toString()}`;
  }
}
```

#### 21.2.2 UI Integration

```tsx
// AWS Console Access Component
export const AWSConsoleAccessButton: React.FC<{
  battleId: string;
  problemId: string;
}> = ({ battleId, problemId }) => {
  const [isLoading, setIsLoading] = useState(false);
  const { user } = useAuth();

  const handleOpenConsole = async () => {
    setIsLoading(true);
    try {
      // Get console access URL from backend
      const response = await api.post('/aws/console-access', {
        battleId,
        problemId,
        userId: user.id
      });

      // Open AWS Console in new window
      const consoleWindow = window.open(
        response.data.consoleUrl,
        'aws-console',
        'width=1200,height=800,menubar=no,toolbar=no'
      );

      // Track console access
      await api.post('/analytics/track', {
        event: 'aws_console_accessed',
        properties: {
          battleId,
          problemId,
          userId: user.id
        }
      });
    } catch (error) {
      console.error('Failed to open AWS Console:', error);
      toast.error('AWS Consoleへのアクセスに失敗しました');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Button
      onClick={handleOpenConsole}
      disabled={isLoading}
      variant="primary"
      className="flex items-center gap-2"
    >
      <AWSIcon />
      {isLoading ? 'アクセス中...' : 'AWS Consoleを開く'}
    </Button>
  );
};
```

### 21.3 セキュリティ考慮事項

#### 21.3.1 権限スコープ

```yaml
# Battle-specific IAM Policy Template
BattleParticipantPolicy:
  Version: '2012-10-17'
  Statement:
    - Sid: ReadOnlyAccess
      Effect: Allow
      Action:
        - 'ec2:Describe*'
        - 's3:List*'
        - 's3:Get*'
        - 'lambda:Get*'
        - 'lambda:List*'
      Resource: '*'

    - Sid: ResourceCreation
      Effect: Allow
      Action:
        - 'ec2:RunInstances'
        - 'ec2:TerminateInstances'
        - 's3:CreateBucket'
        - 's3:PutObject'
        - 'lambda:CreateFunction'
        - 'lambda:UpdateFunctionCode'
      Resource:
        - !Sub 'arn:aws:*:*:*:tenkacloud-battle-${BattleId}-*'

    - Sid: TagRestriction
      Effect: Deny
      Action: '*'
      Resource: '*'
      Condition:
        StringNotEquals:
          'aws:RequestTag/TenkaCloudBattleId': '${BattleId}'
```

#### 21.3.2 セッション管理

- セッションは 1 時間で自動的に期限切れ
- バトル終了時にセッションを即座に無効化
- アクセスログを CloudTrail で監査

### 21.4 マルチクラウド対応

```typescript
// Cloud Console Access Interface
export interface CloudConsoleAccess {
  generateAccessURL(params: AccessParams): Promise<string>;
  revokeAccess(sessionId: string): Promise<void>;
  validatePermissions(userId: string, requestedPermissions: string[]): Promise<boolean>;
}

// AWS Implementation
export class AWSConsoleAccess implements CloudConsoleAccess {
  // Implementation as shown above
}

// GCP Implementation
export class GCPConsoleAccess implements CloudConsoleAccess {
  async generateAccessURL(params: AccessParams): Promise<string> {
    // Use Google Cloud IAM & OAuth2 for console access
    const oauth2Client = new OAuth2Client({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret
    });

    const authUrl = oauth2Client.generateAuthUrl({
      scope: params.permissions,
      access_type: 'online',
      state: params.battleId
    });

    return authUrl;
  }
}

// Azure Implementation
export class AzureConsoleAccess implements CloudConsoleAccess {
  async generateAccessURL(params: AccessParams): Promise<string> {
    // Use Azure AD & RBAC for portal access
    const msalClient = new ConfidentialClientApplication({
      auth: {
        clientId: this.config.clientId,
        authority: this.config.authority,
        clientSecret: this.config.clientSecret
      }
    });

    const authResult = await msalClient.acquireTokenByClientCredential({
      scopes: params.permissions
    });

    return `https://portal.azure.com/#@${this.config.tenantId}`;
  }
}
```

## 22. ライセンス

### 22.1 Apache License 2.0

本プロジェクトは Apache License 2.0 の下で公開されます。

```text
Copyright 2025 TenkaCloud Contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

### 22.2 ライセンス選択理由

Apache License 2.0 を選択した理由は次の通りです。

1. **企業利用に適している**: 特許権の明示的な付与により、企業が安心して利用可能
2. **貢献者の保護**: 貢献者に対する特許訴訟からの保護条項
3. **商用利用可能**: 商用製品への組み込みが可能
4. **変更の明示**: 変更箇所の明示義務により、オリジナルと派生物の区別が明確
5. **互換性**: 多くの OSS ライセンスと互換性がある

### 22.3 サードパーティライセンス

主要な依存関係とそのライセンスは次の表の通りです。

| ライブラリ | ライセンス | 用途 |
|-----------|------------|------|
| Next.js | MIT | フロントエンドフレームワーク |
| React | MIT | UIライブラリ |
| TypeScript | Apache-2.0 | 型システム |
| Fastify | MIT | バックエンドフレームワーク |
| AWS SDK | Apache-2.0 | AWSサービス統合 |
| Terraform | MPL-2.0 | インフラストラクチャ管理 |
| Kubernetes | Apache-2.0 | コンテナオーケストレーション |
| PostgreSQL | PostgreSQL License | データベース |
| Redis | BSD-3-Clause | キャッシュ・セッション管理 |
| Keycloak | Apache-2.0 | 認証・認可 |

## 23. 実装ロードマップ

### 23.1 フェーズ1: 基盤構築 (Month 1-2)

#### Week 1-2: プロジェクトセットアップ
- [ ] リポジトリ構成とモノレポセットアップ
- [ ] 開発環境構築ドキュメント作成
- [ ] CI/CD パイプライン基本設定
- [ ] コーディング規約とレビュープロセス確立

#### Week 3-4: 認証基盤
- [ ] Keycloak Docker 環境構築
- [ ] NextAuth.js 統合
- [ ] JWT token validation middleware
- [ ] Role-based access control 実装

#### Week 5-6: Control Plane Core
- [ ] Tenant Management Service 実装
- [ ] DynamoDB table 作成と DAO 実装
- [ ] REST API 実装（OpenAPI spec 準拠）
- [ ] ユニットテスト（カバレッジ 100％）

#### Week 7-8: Control Plane UI
- [ ] Next.js プロジェクト構築
- [ ] 管理ダッシュボード基本 UI
- [ ] テナント管理画面
- [ ] Keycloak 認証統合

### 23.2 フェーズ2: コア機能実装 (Month 3-4)

#### Week 9-10: Application Plane基盤
- [ ] Battle Management Service
- [ ] WebSocket real-time 通信
- [ ] バトルライフサイクル管理
- [ ] 参加者管理システム

#### Week 11-12: 問題管理システム
- [ ] Challenge Service 実装
- [ ] 問題テンプレート管理
- [ ] CloudFormation/Terraform 統合
- [ ] 問題バリデーション機能

#### Week 13-14: 採点システム
- [ ] Scoring Service 実装
- [ ] 自動採点エンジン
- [ ] インフラ検証ロジック
- [ ] スコアボード更新システム

#### Week 15-16: 参加者UI
- [ ] バトル参加画面
- [ ] 問題表示・提出画面
- [ ] リアルタイム進捗表示
- [ ] AWS Console 統合

### 23.3 フェーズ3: AI機能統合 (Month 5)

#### Week 17-18: Claude AI統合
- [ ] Claude API クライアント実装
- [ ] プロンプトエンジニアリング
- [ ] レート制限とコスト管理
- [ ] エラーハンドリング

#### Week 19-20: AI機能実装
- [ ] 問題自動生成システム
- [ ] インテリジェント採点
- [ ] コーチング機能
- [ ] ヒント生成システム

### 23.4 フェーズ4: マルチクラウド対応 (Month 6)

#### Week 21-22: クラウド抽象化層
- [ ] Provider interface 定義
- [ ] AWS provider 実装
- [ ] GCP provider 実装
- [ ] Azure provider 実装

#### Week 23-24: LocalStack統合
- [ ] LocalStack Docker 環境
- [ ] ローカル開発ワークフロー
- [ ] 統合テストスイート
- [ ] 開発者ドキュメント

### 23.5 実装優先度

1. **Critical (P0)** - 基本動作に必須
   - 認証・認可システム
   - テナント管理
   - バトル実行エンジン
   - 基本 UI

2. **High (P1)** - コア機能
   - 問題管理
   - 採点システム
   - リアルタイム更新
   - AWS Console 統合

3. **Medium (P2)** - 付加価値機能
   - AI 問題生成
   - コーチング機能
   - 詳細な分析・レポート
   - マルチクラウド対応

4. **Low (P3)** - 将来の拡張
   - 課金システム
   - エンタープライズ機能
   - カスタムブランディング
   - API marketplace

## 24. 開発環境セットアップガイド

### 24.1 必要なツール

```bash
# Required tools and versions
- Node.js 20.x or later
- Bun 1.0.x or later (alternative to npm/yarn)
- Docker 24.x or later
- Docker Compose 2.x or later
- kubectl 1.28.x or later
- Terraform 1.6.x or later
- AWS CLI 2.x
- Git 2.x or later
```

### 24.2 初期セットアップ手順

#### Step 1: リポジトリクローン

```bash
# Clone repository
git clone https://github.com/tenkacloud/tenkacloud.git
cd tenkacloud

# Install dependencies
bun install

# Setup git hooks
bun run prepare
```

#### Step 2: 環境変数設定

```bash
# Copy environment templates
cp .env.example .env.local

# Edit environment variables
vi .env.local

# Required variables:
# - NEXTAUTH_URL=http://localhost:3000
# - NEXTAUTH_SECRET=<generate-secret>
# - KEYCLOAK_CLIENT_ID=control-plane-ui
# - KEYCLOAK_CLIENT_SECRET=<from-keycloak>
# - KEYCLOAK_ISSUER=http://localhost:8080/realms/tenkacloud
# - AWS_REGION=us-east-1
# - AWS_ACCESS_KEY_ID=<your-key>
# - AWS_SECRET_ACCESS_KEY=<your-secret>
# - DATABASE_URL=postgresql://user:pass@localhost:5432/tenkacloud
# - REDIS_URL=redis://localhost:6379
# - CLAUDE_API_KEY=<your-anthropic-key>
```

#### Step 3: Docker環境起動

```bash
# Start infrastructure services
make docker-up

# Verify services are running
make docker-status

# Services should be running:
# - Keycloak (8080)
# - PostgreSQL (5432)
# - Redis (6379)
# - LocalStack (4566)
```

#### Step 4: データベース初期化

```bash
# Run migrations
bun run db:migrate

# Seed initial data
bun run db:seed

# Verify database
bun run db:verify
```

#### Step 5: アプリケーション起動

```bash
# Terminal 1: Start Control Plane UI
cd frontend/control-plane-ui
bun run dev

# Terminal 2: Start Control Plane Services
cd backend/services/control-plane
bun run dev

# Terminal 3: Start Application Plane Services
cd backend/services/application-plane
bun run dev
```

### 24.3 開発ワークフロー

#### テスト駆動開発

```bash
# Watch mode for unit tests
bun run test:watch

# Run all tests with coverage
bun run test:coverage

# Run specific test file
bun run test src/services/tenant.test.ts

# E2E tests
bun run test:e2e
```

#### コード品質チェック

```bash
# Lint check
bun run lint

# Type check
bun run typecheck

# Format code
bun run format

# All checks (pre-commit)
bun run validate
```

#### ローカルKubernetes開発

```bash
# Start kind cluster
kind create cluster --config=infrastructure/kind/config.yaml

# Apply Kubernetes manifests
kubectl apply -f infrastructure/k8s/namespaces/
kubectl apply -f infrastructure/k8s/control-plane/
kubectl apply -f infrastructure/k8s/application-plane/

# Port forward for local access
kubectl port-forward -n control-plane svc/tenant-service 8081:80

# View logs
kubectl logs -n control-plane -l app=tenant-service -f
```

### 24.4 トラブルシューティング

#### 問題: Keycloakに接続できない

```bash
# Check Keycloak logs
docker logs keycloak

# Restart Keycloak
docker restart keycloak

# Verify Keycloak is accessible
curl http://localhost:8080/health
```

#### 問題: DynamoDB Localが起動しない

```bash
# Check LocalStack status
docker logs localstack

# Create DynamoDB tables manually
aws dynamodb create-table \
  --endpoint-url http://localhost:4566 \
  --table-name TenkaCloudTenants \
  --cli-input-json file://infrastructure/dynamodb/tables.json
```

#### 問題: ビルドエラー

```bash
# Clear cache and reinstall
rm -rf node_modules .next
bun install --force
bun run build

# Check for type errors
bun run typecheck --noEmit

# Update dependencies
bun update
```

## 25. API仕様詳細

### 25.1 Control Plane APIs

#### Tenant Management API

```yaml
openapi: 3.0.0
info:
  title: TenkaCloud Tenant Management API
  version: 1.0.0
  description: Control Plane API for managing tenants

servers:
  - url: https://api.tenkacloud.io/control-plane/v1
    description: Production
  - url: http://localhost:8080/control-plane/v1
    description: Development

paths:
  /tenants:
    get:
      summary: List all tenants
      operationId: listTenants
      tags:
        - Tenants
      parameters:
        - in: query
          name: status
          schema:
            type: string
            enum: [active, suspended, deleted]
        - in: query
          name: limit
          schema:
            type: integer
            default: 20
        - in: query
          name: offset
          schema:
            type: integer
            default: 0
      responses:
        '200':
          description: List of tenants
          content:
            application/json:
              schema:
                type: object
                properties:
                  items:
                    type: array
                    items:
                      $ref: '#/components/schemas/Tenant'
                  total:
                    type: integer
                  hasMore:
                    type: boolean

    post:
      summary: Create new tenant
      operationId: createTenant
      tags:
        - Tenants
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateTenantRequest'
      responses:
        '201':
          description: Tenant created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Tenant'

  /tenants/{tenantId}:
    get:
      summary: Get tenant by ID
      operationId: getTenant
      tags:
        - Tenants
      parameters:
        - in: path
          name: tenantId
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Tenant details
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Tenant'

    patch:
      summary: Update tenant
      operationId: updateTenant
      tags:
        - Tenants
      parameters:
        - in: path
          name: tenantId
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/UpdateTenantRequest'
      responses:
        '200':
          description: Tenant updated
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Tenant'

    delete:
      summary: Delete tenant
      operationId: deleteTenant
      tags:
        - Tenants
      parameters:
        - in: path
          name: tenantId
          required: true
          schema:
            type: string
      responses:
        '204':
          description: Tenant deleted

  /tenants/{tenantId}/suspend:
    post:
      summary: Suspend tenant
      operationId: suspendTenant
      tags:
        - Tenants
      parameters:
        - in: path
          name: tenantId
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Tenant suspended

  /tenants/{tenantId}/resume:
    post:
      summary: Resume tenant
      operationId: resumeTenant
      tags:
        - Tenants
      parameters:
        - in: path
          name: tenantId
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Tenant resumed

components:
  schemas:
    Tenant:
      type: object
      properties:
        tenantId:
          type: string
        name:
          type: string
        tier:
          type: string
          enum: [free, pro, enterprise]
        status:
          type: string
          enum: [active, suspended, deleted]
        adminEmail:
          type: string
        metadata:
          type: object
        createdAt:
          type: string
          format: date-time
        updatedAt:
          type: string
          format: date-time

    CreateTenantRequest:
      type: object
      required:
        - name
        - adminEmail
        - tier
      properties:
        name:
          type: string
        adminEmail:
          type: string
          format: email
        tier:
          type: string
          enum: [free, pro, enterprise]
        metadata:
          type: object

    UpdateTenantRequest:
      type: object
      properties:
        name:
          type: string
        tier:
          type: string
          enum: [free, pro, enterprise]
        metadata:
          type: object

  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT

security:
  - bearerAuth: []
```

### 25.2 Application Plane APIs

#### Battle Management API

```yaml
openapi: 3.0.0
info:
  title: TenkaCloud Battle Management API
  version: 1.0.0
  description: Application Plane API for managing battles

paths:
  /battles:
    post:
      summary: Create new battle
      operationId: createBattle
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                name:
                  type: string
                problemIds:
                  type: array
                  items:
                    type: string
                duration:
                  type: integer
                  description: Duration in minutes
                maxParticipants:
                  type: integer
      responses:
        '201':
          description: Battle created

  /battles/{battleId}/join:
    post:
      summary: Join battle
      operationId: joinBattle
      parameters:
        - in: path
          name: battleId
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Successfully joined battle

  /battles/{battleId}/submit:
    post:
      summary: Submit solution
      operationId: submitSolution
      parameters:
        - in: path
          name: battleId
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                problemId:
                  type: string
                infrastructureCode:
                  type: string
                  description: CloudFormation or Terraform code
                resourceIds:
                  type: array
                  items:
                    type: string
      responses:
        '200':
          description: Solution submitted for scoring

  /battles/{battleId}/leaderboard:
    get:
      summary: Get battle leaderboard
      operationId: getLeaderboard
      parameters:
        - in: path
          name: battleId
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Battle leaderboard
          content:
            application/json:
              schema:
                type: object
                properties:
                  entries:
                    type: array
                    items:
                      type: object
                      properties:
                        rank:
                          type: integer
                        userId:
                          type: string
                        username:
                          type: string
                        score:
                          type: number
                        completedProblems:
                          type: integer
                        lastSubmission:
                          type: string
                          format: date-time
```

### 25.3 WebSocket Events

```typescript
// WebSocket Event Types
export enum WebSocketEventType {
  // Battle Events
  BATTLE_STARTED = 'battle.started',
  BATTLE_ENDED = 'battle.ended',
  PARTICIPANT_JOINED = 'participant.joined',
  PARTICIPANT_LEFT = 'participant.left',

  // Submission Events
  SOLUTION_SUBMITTED = 'solution.submitted',
  SOLUTION_SCORED = 'solution.scored',

  // Leaderboard Events
  LEADERBOARD_UPDATED = 'leaderboard.updated',
  RANK_CHANGED = 'rank.changed',

  // System Events
  ANNOUNCEMENT = 'system.announcement',
  TIME_WARNING = 'time.warning'
}

// WebSocket Message Format
export interface WebSocketMessage<T = any> {
  id: string;
  type: WebSocketEventType;
  timestamp: string;
  data: T;
}

// Connection URL: wss://api.tenkacloud.io/ws
// Authentication: JWT token in query parameter
// Example: wss://api.tenkacloud.io/ws?token=eyJhbGciOiJIUzI1NiIs...
```

## 26. マルチクラウドデプロイメントガイド

### 26.1 AWS Deployment

#### 26.1.1 Prerequisites

```bash
# AWS CLI Configuration
aws configure
# Enter: AWS Access Key ID, Secret Access Key, Region

# EKS CLI Tools
curl -o kubectl https://amazon-eks.s3.amazonaws.com/1.28.3/2023-11-14/bin/linux/amd64/kubectl
chmod +x ./kubectl
sudo mv ./kubectl /usr/local/bin

# eksctl
curl --silent --location "https://github.com/weaveworks/eksctl/releases/latest/download/eksctl_$(uname -s)_amd64.tar.gz" | tar xz -C /tmp
sudo mv /tmp/eksctl /usr/local/bin
```

#### 26.1.2 Infrastructure Deployment

```bash
# Navigate to AWS infrastructure
cd infrastructure/terraform/aws

# Initialize Terraform
terraform init

# Create workspace for environment
terraform workspace new production

# Plan deployment
terraform plan -var-file=environments/production.tfvars

# Apply infrastructure
terraform apply -var-file=environments/production.tfvars -auto-approve

# Get EKS cluster credentials
aws eks update-kubeconfig --name tenkacloud-production --region us-east-1

# Verify cluster access
kubectl get nodes
```

#### 26.1.3 Application Deployment

```bash
# Build and push Docker images
make docker-build-all
make docker-push-all

# Deploy Control Plane
kubectl apply -f infrastructure/k8s/aws/control-plane/

# Deploy Application Plane
kubectl apply -f infrastructure/k8s/aws/application-plane/

# Verify deployments
kubectl get pods -n control-plane
kubectl get pods -n application-plane

# Setup ingress
kubectl apply -f infrastructure/k8s/aws/ingress/
```

### 26.2 GCP Deployment

#### 26.2.1 Prerequisites

```bash
# Install gcloud CLI
curl https://sdk.cloud.google.com | bash
exec -l $SHELL

# Initialize gcloud
gcloud init

# Set project
gcloud config set project tenkacloud-production

# Enable required APIs
gcloud services enable compute.googleapis.com
gcloud services enable container.googleapis.com
gcloud services enable cloudbuild.googleapis.com
```

#### 26.2.2 GKE Cluster Deployment

```bash
# Navigate to GCP infrastructure
cd infrastructure/terraform/gcp

# Initialize Terraform
terraform init

# Deploy GKE cluster
terraform apply -var-file=environments/production.tfvars

# Get GKE credentials
gcloud container clusters get-credentials tenkacloud-production \
  --zone us-central1-a

# Deploy applications
kubectl apply -f infrastructure/k8s/gcp/
```

### 26.3 Azure Deployment

#### 26.3.1 Prerequisites

```bash
# Install Azure CLI
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash

# Login to Azure
az login

# Set subscription
az account set --subscription "TenkaCloud Production"

# Create resource group
az group create --name tenkacloud-rg --location eastus
```

#### 26.3.2 AKS Deployment

```bash
# Navigate to Azure infrastructure
cd infrastructure/terraform/azure

# Deploy AKS cluster
terraform apply -var-file=environments/production.tfvars

# Get AKS credentials
az aks get-credentials --resource-group tenkacloud-rg \
  --name tenkacloud-aks

# Deploy applications
kubectl apply -f infrastructure/k8s/azure/
```

### 26.4 LocalStack Development

#### 26.4.1 Setup

```bash
# Start LocalStack
docker-compose -f infrastructure/docker/localstack/docker-compose.yml up -d

# Verify LocalStack
aws --endpoint-url=http://localhost:4566 s3 ls

# Create local resources
./scripts/localstack/setup.sh
```

#### 26.4.2 Local Development Configuration

```yaml
# config/development.yaml
aws:
  endpoint: http://localhost:4566
  region: us-east-1
  credentials:
    accessKeyId: test
    secretAccessKey: test

dynamodb:
  endpoint: http://localhost:4566
  tables:
    tenants: TenkaCloudTenants-dev
    battles: TenkaCloudBattles-dev
    challenges: TenkaCloudChallenges-dev

s3:
  endpoint: http://localhost:4566
  buckets:
    problems: tenkacloud-problems-dev
    submissions: tenkacloud-submissions-dev
```

## 27. 監視・運用ガイド

### 27.1 監視スタック

#### 27.1.1 Prometheus Setup

```yaml
# prometheus-values.yaml
prometheus:
  prometheusSpec:
    serviceMonitorSelectorNilUsesHelmValues: false
    retention: 30d
    storageSpec:
      volumeClaimTemplate:
        spec:
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 50Gi
```

```bash
# Install Prometheus Operator
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install prometheus prometheus-community/kube-prometheus-stack \
  -f monitoring/prometheus-values.yaml \
  -n monitoring --create-namespace
```

#### 27.1.2 Grafana Dashboards

```json
{
  "dashboard": {
    "title": "TenkaCloud Operations",
    "panels": [
      {
        "title": "Active Tenants",
        "targets": [
          {
            "expr": "count(tenkacloud_tenant_status{status=\"active\"})"
          }
        ]
      },
      {
        "title": "Battle Participation Rate",
        "targets": [
          {
            "expr": "rate(tenkacloud_battle_participants_total[5m])"
          }
        ]
      },
      {
        "title": "API Response Time",
        "targets": [
          {
            "expr": "histogram_quantile(0.95, tenkacloud_api_duration_seconds_bucket)"
          }
        ]
      }
    ]
  }
}
```

### 27.2 ログ管理

#### 27.2.1 Fluentd Configuration

```yaml
# fluentd-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluentd-config
data:
  fluent.conf: |
    <source>
      @type tail
      path /var/log/containers/*.log
      pos_file /var/log/fluentd-containers.log.pos
      tag kubernetes.*
      <parse>
        @type json
      </parse>
    </source>

    <filter kubernetes.**>
      @type kubernetes_metadata
    </filter>

    <match **>
      @type elasticsearch
      host elasticsearch.elastic-system.svc
      port 9200
      logstash_format true
      logstash_prefix tenkacloud
    </match>
```

### 27.3 バックアップ戦略

#### 27.3.1 Database Backup

```bash
#!/bin/bash
# backup-databases.sh

# PostgreSQL backup
pg_dump $DATABASE_URL > backups/postgres-$(date +%Y%m%d).sql

# DynamoDB backup
aws dynamodb create-backup \
  --table-name TenkaCloudTenants \
  --backup-name tenants-$(date +%Y%m%d)

# Upload to S3
aws s3 cp backups/ s3://tenkacloud-backups/ --recursive

# Cleanup old backups
find backups/ -type f -mtime +30 -delete
```

#### 27.3.2 Disaster Recovery

```yaml
# disaster-recovery-plan.yaml
procedures:
  - name: Database Recovery
    steps:
      - Identify latest backup
      - Restore PostgreSQL from backup
      - Restore DynamoDB tables
      - Verify data integrity
      - Update DNS if needed

  - name: Cluster Recovery
    steps:
      - Create new cluster in DR region
      - Apply Terraform configurations
      - Deploy applications
      - Restore persistent volumes
      - Switch traffic to DR cluster

  rto: 4 hours  # Recovery Time Objective
  rpo: 1 hour   # Recovery Point Objective
```

## 改訂履歴

| バージョン | 日付 | 変更内容 | 作成者 |
|-----------|------|----------|--------|
| 1.0 | 2025-11-21 | 初版作成 | TenkaCloud Team |
| 1.1 | 2025-11-21 | AWS Console Access Integration、ライセンス情報、実装ロードマップ、開発環境セットアップガイド、API仕様詳細、マルチクラウドデプロイメントガイド、監視・運用ガイドを追加 | TenkaCloud Team |

---

**END OF DOCUMENT**
