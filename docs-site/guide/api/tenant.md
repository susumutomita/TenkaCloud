# Tenant API

テナント管理 API のリファレンスです。

## エンドポイント

**Base URL**: `http://localhost:13004/api`

## 認証

すべてのエンドポイントは認証が必要です。リクエストヘッダーに Bearer トークンを含めてください。

```
Authorization: Bearer <access_token>
```

## テナント一覧取得

テナントの一覧を取得します。

```http
GET /tenants
```

### レスポンス

```json
{
  "tenants": [
    {
      "id": "tenant-123",
      "name": "Sample Tenant",
      "slug": "sample-tenant",
      "tier": "FREE",
      "status": "ACTIVE",
      "provisioningStatus": "COMPLETED",
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

## テナント詳細取得

特定のテナントの詳細を取得します。

```http
GET /tenants/:id
```

### パスパラメータ

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| id | string | テナント ID |

### レスポンス

```json
{
  "id": "tenant-123",
  "name": "Sample Tenant",
  "slug": "sample-tenant",
  "tier": "FREE",
  "status": "ACTIVE",
  "provisioningStatus": "COMPLETED",
  "adminEmail": "admin@example.com",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z"
}
```

## テナント作成

新しいテナントを作成します。

```http
POST /tenants
```

### リクエストボディ

```json
{
  "name": "New Tenant",
  "slug": "new-tenant",
  "tier": "FREE",
  "adminEmail": "admin@example.com"
}
```

### パラメータ

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| name | string | Yes | テナント名 |
| slug | string | Yes | URL スラッグ（一意） |
| tier | string | No | プラン（FREE, BASIC, PREMIUM, ENTERPRISE） |
| adminEmail | string | No | 管理者メールアドレス |

### レスポンス

```json
{
  "id": "tenant-456",
  "name": "New Tenant",
  "slug": "new-tenant",
  "tier": "FREE",
  "status": "ACTIVE",
  "provisioningStatus": "PENDING",
  "adminEmail": "admin@example.com",
  "createdAt": "2024-01-02T00:00:00.000Z",
  "updatedAt": "2024-01-02T00:00:00.000Z"
}
```

## テナント更新

既存のテナントを更新します。

```http
PUT /tenants/:id
```

### パスパラメータ

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| id | string | テナント ID |

### リクエストボディ

```json
{
  "name": "Updated Tenant Name",
  "tier": "BASIC"
}
```

## テナント削除

テナントを削除します。

```http
DELETE /tenants/:id
```

### パスパラメータ

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| id | string | テナント ID |

### レスポンス

```json
{
  "success": true
}
```

## ステータスコード

| コード | 説明 |
|--------|------|
| 200 | 成功 |
| 201 | 作成成功 |
| 400 | リクエストエラー |
| 401 | 認証エラー |
| 404 | リソースが見つからない |
| 409 | 競合（スラッグ重複など） |
| 500 | サーバーエラー |

## エラーレスポンス

```json
{
  "error": "Tenant not found",
  "code": "TENANT_NOT_FOUND"
}
```

## 使用例

### cURL

```bash
# テナント一覧取得
curl -X GET http://localhost:13004/api/tenants \
  -H "Authorization: Bearer <token>"

# テナント作成
curl -X POST http://localhost:13004/api/tenants \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name": "Test Tenant", "slug": "test-tenant"}'
```

### TypeScript

```typescript
const response = await fetch('http://localhost:13004/api/tenants', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    name: 'Test Tenant',
    slug: 'test-tenant',
  }),
});

const tenant = await response.json();
```
