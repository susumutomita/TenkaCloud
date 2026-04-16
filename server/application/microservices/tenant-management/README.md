# Tenant Management API

テナント管理のための RESTful API サービスです。

## 技術スタック

- **Runtime**: Bun
- **Framework**: Hono
- **O/Rマッパ**: Prisma
- **Database**: PostgreSQL
- **Validation**: Zod

## セキュリティ機能

### 実装済み

- CORS 設定: 厳密なオリジン制限
- 入力検証: Zod による型安全なバリデーション
- UUID 検証: 不正な ID 形式のリクエストを拒否
- Prisma エラーハンドリング: ユニーク制約違反などを適切に処理
- リソース制限: Kubernetes での CPU / メモリ制限
- ヘルスチェック: liveness/readiness probe

### 今後実装予定

- ⏳ **認証・認可**: JWT トークンベースの認証
- ⏳ **レート制限**: DDoS 対策
- ⏳ **監査ログ**: すべての操作を記録

## API エンドポイント

### Health Check

```
GET /health
```

### Tenants

```
GET    /api/tenants       # テナント一覧取得
GET    /api/tenants/:id   # テナント詳細取得
POST   /api/tenants       # テナント作成
PATCH  /api/tenants/:id   # テナント更新
DELETE /api/tenants/:id   # テナント削除
```

## ローカル開発

### 1. 環境変数設定

ルートディレクトリの `.env.example` をコピーします。

```bash
cp ../../.env.example ../../.env
```

`.env` ファイルを編集して、必要な値を設定してください。

### 2. 依存関係インストール

```bash
bun install
```

### 3. Prisma マイグレーション

```bash
# データベースマイグレーション実行
bunx prisma migrate dev

# Prisma Client 生成
bunx prisma generate
```

### 4. サーバー起動

```bash
# 開発モード（ホットリロード）
bun run dev

# 本番ビルド
bun run build
bun run start
```

## Docker Compose での実行

ルートディレクトリから次のコマンドを実行します。

```bash
make start-compose
```

## Kubernetes デプロイ

### 1. Secrets 作成

本番環境では必ず強力なパスワードを使用してください。

```bash
# Secrets作成
kubectl create secret generic postgres-secret \
  --from-literal=username=postgres \
  --from-literal=password=$(openssl rand -base64 32) \
  --from-literal=database=tenkacloud \
  -n tenkacloud
```

### 2. デプロイ

```bash
# PostgreSQL Secret
kubectl apply -f ../../infrastructure/k8s/base/postgres-secret.yaml

# PostgreSQL
kubectl apply -f ../../infrastructure/k8s/base/postgres.yaml

# Tenant Management API
kubectl apply -f ../../infrastructure/k8s/control-plane/tenant-management.yaml
```

## データベーススキーマ

### Tenant モデル

| フィールド | 型 | 説明 |
|-----------|----|----|
| id | UUID | プライマリキー |
| name | String | テナント名 |
| status | Enum | ACTIVE / SUSPENDED / ARCHIVED |
| tier | Enum | FREE / PRO / ENTERPRISE |
| adminEmail | String | 管理者メール（ユニーク） |
| createdAt | DateTime | 作成日時 |
| updatedAt | DateTime | 更新日時 |

### インデックス

- `status` - ステータスでのフィルタリング用
- `adminEmail` - メールアドレス検索用（ユニーク制約）

## エラーコード

| ステータス | 説明 |
|----------|------|
| 200 | 成功 |
| 201 | 作成成功 |
| 400 | バリデーションエラー / 不正な UUID |
| 404 | テナントが見つからない |
| 409 | 重複エラー（メールアドレスが既に存在） |
| 500 | サーバーエラー |

## セキュリティのベストプラクティス

### 本番環境チェックリスト

- [ ] `.env` ファイルに強力なパスワードを設定
- [ ] Kubernetes Secrets を使用（平文パスワード禁止）
- [ ] CORS の `ALLOWED_ORIGIN` を本番ドメインに制限
- [ ] データベースの定期バックアップを設定
- [ ] モニタリング・アラート設定
- [ ] JWT 認証の実装
- [ ] レート制限の実装
- [ ] HTTPS の強制

## トラブルシューティング

### データベース接続エラー

```bash
# PostgreSQL コンテナ確認
docker ps | grep postgres

# ログ確認
docker logs tenkacloud-postgres-1

# 接続テスト
docker exec tenkacloud-postgres-1 psql -U postgres -d tenkacloud -c "\dt"
```

### Prisma マイグレーションエラー

```bash
# マイグレーション状態確認
bunx prisma migrate status

# リセット（開発環境のみ）
bunx prisma migrate reset

# 再マイグレーション
bunx prisma migrate dev
```

## ライセンス

MIT
