# Control Plane Services

Control Plane は、TenkaCloud 全体で共有される管理系サービス群です。

## 含まれるサービス

- `tenant-management`: テナント CRUD と状態管理
- `registration`: 新規テナント登録フロー
- `provisioning`: テナント向けリソース作成
- `provisioning-completion`: プロビジョニング完了処理
- `user-management`: ユーザー管理
- `system-management`: 全体設定と運用情報
- `deployment-management`: デプロイ関連の制御

## 責務

- テナントライフサイクル管理
- 共通設定管理
- ユーザー、登録、プロビジョニングの制御
- Application Plane に渡すための管理情報の保持

## 技術方針

- TypeScript
- Hono を中心とした軽量 HTTP サービス
- DynamoDB 系の共有実装を利用
- Auth0 / JWT ベースの認証統合を前提とする

## ローカル開発

サービス単位で起動します。例は以下のとおりです。

```bash
cd backend/services/control-plane/tenant-management
bun run dev
```

## 関連文書

- [docs/architecture/architecture.md](/Users/susumu/product/TenkaCloud/docs/architecture/architecture.md)
- [docs/architecture/tenant-management-integration.md](/Users/susumu/product/TenkaCloud/docs/architecture/tenant-management-integration.md)
