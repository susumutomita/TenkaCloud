# Tenant Management Service 統合仕様書

Control Plane と Tenant Management Service 間の統合仕様を定義します。

## 概要

| 項目 | 値 |
|------|-----|
| サービス名 | tenant-management |
| ポート | 13004 |
| ベース URL | `/api` |
| データストア | DynamoDB (Single-Table Design) |

## アーキテクチャ

```
┌─────────────────┐     HTTP      ┌─────────────────────┐     AWS SDK    ┌─────────────┐
│  Control Plane  │ ───────────▶ │  Tenant Management  │ ─────────────▶ │  DynamoDB   │
│  (Next.js)      │   :13004     │  (Hono)             │                │  LocalStack │
│  :13000         │              │                     │                │  :4566      │
└─────────────────┘              └─────────────────────┘                └─────────────┘
```

## 環境変数

### Control Plane (`apps/control-plane/.env.local`)

```bash
# ローカル開発時（必須）
TENANT_API_BASE_URL=http://localhost:13004/api

# クライアントサイド用（ブラウザから直接呼ぶ場合）
NEXT_PUBLIC_TENANT_API_BASE_URL=http://localhost:13004/api
```

### Tenant Management (`backend/services/control-plane/tenant-management`)

```bash
DYNAMODB_TABLE_NAME=TenkaCloud-dev    # テーブル名
DYNAMODB_ENDPOINT=http://localhost:4566  # LocalStack エンドポイント
AWS_REGION=ap-northeast-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
```

## API エンドポイント

### ヘルスチェック

```
GET /health
```

**レスポンス:**
```json
{
  "status": "ok",
  "service": "tenant-management"
}
```

### テナント一覧取得

```
GET /api/tenants
```

**クエリパラメータ:**
| パラメータ | 型 | デフォルト | 説明 |
|------------|-----|----------|------|
| limit | number | 50 | 取得件数 |
| cursor | string | - | ページネーションカーソル |

**レスポンス:**
```json
{
  "data": [
    {
      "id": "tenant_xxxx",
      "name": "テナント名",
      "slug": "tenant-slug",
      "status": "active",
      "plan": "free",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "pagination": {
    "limit": 50,
    "total": 0,
    "hasNextPage": false
  }
}
```

### テナント作成

```
POST /api/tenants
Content-Type: application/json
```

**リクエストボディ:**
```json
{
  "name": "テナント名",
  "slug": "tenant-slug",
  "plan": "free"
}
```

**レスポンス:** `201 Created`
```json
{
  "id": "tenant_xxxx",
  "name": "テナント名",
  "slug": "tenant-slug",
  "status": "active",
  "plan": "free",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

### テナント取得

```
GET /api/tenants/:id
```

**レスポンス:** `200 OK` または `404 Not Found`

### テナント更新

```
PATCH /api/tenants/:id
Content-Type: application/json
```

**リクエストボディ:**
```json
{
  "name": "新しいテナント名",
  "status": "suspended"
}
```

### テナント削除

```
DELETE /api/tenants/:id
```

**レスポンス:** `204 No Content` または `404 Not Found`

## 起動手順

### 1. LocalStack を起動

```bash
docker compose up localstack -d
```

### 2. tenant-management を起動

**方法 A: ローカル実行（推奨）**
```bash
cd backend/services/control-plane/tenant-management
DYNAMODB_TABLE_NAME=TenkaCloud-dev \
DYNAMODB_ENDPOINT=http://localhost:4566 \
AWS_REGION=ap-northeast-1 \
AWS_ACCESS_KEY_ID=test \
AWS_SECRET_ACCESS_KEY=test \
bun run dev
```

**方法 B: Docker Compose**
```bash
# lockfile 問題が解決している場合
docker compose up tenant-management -d
```

### 3. Control Plane を起動

```bash
cd apps/control-plane
bun run dev
```

### 4. 動作確認

```bash
# ヘルスチェック
curl http://localhost:13004/health

# テナント一覧
curl http://localhost:13004/api/tenants

# Control Plane でテナント管理画面にアクセス
open http://localhost:13000/dashboard/tenants
```

## トラブルシューティング

### `ENOTFOUND tenant-management` エラー

**原因：** `TENANT_API_BASE_URL` が未設定でデフォルトの Docker ホスト名が使われている。

**解決策:**
```bash
# apps/control-plane/.env.local に追加
TENANT_API_BASE_URL=http://localhost:13004/api
```

### `lockfile had changes` エラー（Docker ビルド時）

**原因：** ローカルの `bun.lock` と Docker ビルドコンテキストの不一致。

**解決策:**
```bash
bun install
git add bun.lock
git commit -m "chore: update bun.lock"
```

### LocalStack に接続できない

**原因：** LocalStack が起動していない、またはポートが異なる。

**解決策:**
```bash
# ヘルスチェック
curl http://localhost:4566/_localstack/health

# 起動していない場合
docker compose up localstack -d
```

## 関連ファイル

| ファイル | 説明 |
|---------|------|
| `apps/control-plane/lib/api/tenant-api.ts` | API クライアント |
| `apps/control-plane/app/dashboard/tenants/page.tsx` | テナント管理画面 |
| `backend/services/control-plane/tenant-management/src/index.ts` | API サーバー |
| `backend/services/control-plane/tenant-management/src/lib/dynamodb.ts` | DynamoDB 設定 |
| `docker-compose.yml` | サービス定義 |
