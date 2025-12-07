# Registration Service 実装計画

## 概要

Control Plane の登録サービスを実装し、新規テナントのオンボーディングプロセスを自動化します。

## アーキテクチャ決定

Issue では DynamoDB/Cognito を想定していますが、TenkaCloud は以下のスタックを使用します。

- **Database**: PostgreSQL + Prisma（DynamoDB の代替）
- **Auth**: Keycloak（Cognito の代替）

既存の `tenant-management` サービスとの関係は以下のとおりです。

- `registration` は公開エンドポイント（認証不要）
- `tenant-management` は管理者向け（認証必須）
- 両者は同じ Prisma スキーマと ProvisioningManager を共有

## 受け入れ基準

1. 登録 API 機能の動作確認
2. テナント ID 生成の一意性保証（UUID v4）
3. PostgreSQL・Keycloak 自動リソース作成
4. Application Plane への自動デプロイ実行
5. 登録完了通知の送信機能

## 実装タスク

### Phase 1: 基盤構築

- package.json、tsconfig.json、Dockerfile 作成
- Prisma 設定（tenant-management と共有）
- 基本的な Hono アプリ構造

### Phase 2: BDD テスト作成（TDD）

- 登録リクエストのバリデーションテスト
- テナント作成成功テスト
- 重複登録エラーテスト
- プロビジョニング開始テスト
- 通知送信テスト

### Phase 3: 登録 API 実装

`POST /api/register` エンドポイントでは以下を実装します。

- 入力バリデーション（Zod）
- テナント作成（Prisma）
- 管理者ユーザー作成（Keycloak）
- プロビジョニング開始（非同期）

`GET /api/register/:id/status` でプロビジョニング状態を確認します。

### Phase 4: 通知サービス

- メール通知の定義
- 登録完了通知の送信
- テスト用のモックメール実装（開発環境）

### Phase 5: 統合・品質

- ProvisioningManager との統合
- エラーハンドリング強化
- レート制限の実装
- docker-compose への追加
- make before-commit 実行

## API 設計

### POST /api/register

リクエストボディは以下の形式です。

```json
{
  "organizationName": "string (必須)",
  "adminEmail": "string (必須)",
  "adminName": "string (必須)",
  "tier": "FREE | PRO | ENTERPRISE (デフォルト: FREE)"
}
```

成功時のレスポンス（201 Created）は以下の形式です。

```json
{
  "tenantId": "uuid",
  "status": "PENDING",
  "message": "登録を受け付けました。プロビジョニング完了後にメールでお知らせします。"
}
```

### GET /api/register/:tenantId/status

レスポンスは以下の形式です。

```json
{
  "tenantId": "uuid",
  "provisioningStatus": "PENDING | IN_PROGRESS | COMPLETED | FAILED",
  "createdAt": "ISO8601",
  "completedAt": "ISO8601 | null"
}
```

## 技術スタック

- **Framework**: Hono
- **Validation**: Zod
- **Database**: Prisma + PostgreSQL
- **Auth**: Keycloak Admin Client
- **Logging**: Pino
- **Testing**: Vitest
- **Email**: Nodemailer（将来的に SES に移行可能）

## ディレクトリ構造

```text
registration/
├── src/
│   ├── index.ts           # エントリーポイント
│   ├── api/
│   │   └── register.ts    # 登録API
│   ├── services/
│   │   ├── registration.ts # 登録ビジネスロジック
│   │   └── notification.ts # 通知サービス
│   ├── lib/
│   │   ├── prisma.ts      # DB接続
│   │   ├── keycloak.ts    # Keycloak連携
│   │   └── logger.ts      # ロガー
│   └── middleware/
│       └── rate-limit.ts  # レート制限
├── __tests__/
│   └── register.test.ts   # BDDテスト
├── package.json
├── tsconfig.json
├── Dockerfile
└── Plan.md
```

## 進捗記録

| 日付 | 完了項目 | 次のステップ |
|------|----------|--------------|
| 2025-12-08 | 全タスク完了 | PR 作成 |
