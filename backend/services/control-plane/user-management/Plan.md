# ユーザー管理サービス実装計画

## 概要

Control Plane のユーザー管理サービス（User Management Service）を実装する。
テナント内のユーザー（TenantAdmin、Participant）の CRUD 操作と Keycloak 統合を提供。

## アーキテクチャ

```
user-management/
├── src/
│   ├── index.ts              # Hono アプリエントリーポイント
│   ├── api/
│   │   └── users.ts          # ユーザー API ルート
│   ├── services/
│   │   └── user.ts           # ユーザービジネスロジック
│   ├── lib/
│   │   ├── prisma.ts         # Prisma クライアント
│   │   ├── keycloak.ts       # Keycloak クライアント
│   │   └── logger.ts         # ロガー
│   ├── middleware/
│   │   └── auth.ts           # 認証ミドルウェア
│   └── __tests__/
│       └── users.test.ts     # API テスト
├── prisma/
│   └── schema.prisma         # User モデル定義
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## API エンドポイント

| Method | Path | 説明 |
|--------|------|------|
| POST | /api/users | ユーザー作成 |
| GET | /api/users | ユーザー一覧取得 |
| GET | /api/users/:id | ユーザー詳細取得 |
| PATCH | /api/users/:id/role | ロール変更 |
| POST | /api/users/:id/password-reset | パスワードリセット |
| DELETE | /api/users/:id | ユーザー無効化（論理削除） |
| GET | /health | ヘルスチェック |

## データモデル

```prisma
enum UserRole {
  TENANT_ADMIN
  PARTICIPANT
}

enum UserStatus {
  ACTIVE
  INACTIVE
  PENDING
}

model User {
  id            String     @id @default(uuid())
  tenantId      String
  email         String
  name          String
  role          UserRole   @default(PARTICIPANT)
  status        UserStatus @default(PENDING)
  keycloakId    String?    @unique
  createdAt     DateTime   @default(now())
  updatedAt     DateTime   @updatedAt

  @@unique([tenantId, email])
  @@index([tenantId])
  @@map("users")
}
```

## 実装ステップ

### Phase 1: 基盤セットアップ
- [x] Plan.md 作成
- [ ] package.json, tsconfig.json, vitest.config.ts 作成
- [ ] Prisma スキーマ作成
- [ ] 基本ファイル構造作成

### Phase 2: ユーザー作成 API
- [ ] テスト作成（TDD Red）
- [ ] 実装（TDD Green）
- [ ] リファクタリング

### Phase 3: ユーザー一覧取得 API
- [ ] テスト作成
- [ ] 実装

### Phase 4: ロール管理 API
- [ ] テスト作成
- [ ] 実装

### Phase 5: パスワードリセット API
- [ ] テスト作成
- [ ] 実装

### Phase 6: ユーザー無効化 API
- [ ] テスト作成
- [ ] 実装

### Phase 7: 品質チェック
- [ ] カバレッジ 99％以上確認
- [ ] make before-commit 実行

## 技術的考慮事項

- **テナント分離**: すべての API は tenantId でフィルタリング
- **Keycloak 統合**: ユーザー作成時に Keycloak にも同期
- **RBAC**: TENANT_ADMIN のみがユーザー管理可能
- **パスワードポリシー**: Keycloak のポリシーに従う
- **監査ログ**: 重要操作はログに記録

## 依存関係

- registration サービスの Prisma スキーマを拡張
- Keycloak Admin Client
- Hono フレームワーク
