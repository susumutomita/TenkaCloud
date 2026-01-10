# Problem API

問題管理 API のリファレンスです。

## エンドポイント

**Base URL**: `http://localhost:13002/api/admin`

## 認証

すべてのエンドポイントは認証が必要です。リクエストヘッダーに Bearer トークンとテナント ID を含めてください。

```
Authorization: Bearer <access_token>
x-tenant-id: <tenant_id>
```

## 問題一覧取得

問題の一覧を取得します。

```http
GET /problems
```

### クエリパラメータ

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| difficulty | string | 難易度フィルタ（EASY, MEDIUM, HARD, EXPERT） |
| category | string | カテゴリフィルタ |
| limit | number | 取得件数（デフォルト: 20） |
| cursor | string | ページネーションカーソル |

### レスポンス

```json
{
  "problems": [
    {
      "id": "problem-123",
      "title": "S3 バケットの作成",
      "description": "指定された条件でS3バケットを作成してください",
      "difficulty": "EASY",
      "category": "storage",
      "points": 100,
      "timeLimit": 300,
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ],
  "nextCursor": "cursor-token"
}
```

## 問題詳細取得

特定の問題の詳細を取得します。

```http
GET /problems/:id
```

### レスポンス

```json
{
  "id": "problem-123",
  "title": "S3 バケットの作成",
  "description": "指定された条件でS3バケットを作成してください",
  "difficulty": "EASY",
  "category": "storage",
  "points": 100,
  "timeLimit": 300,
  "requirements": [
    "バケット名は 'tenkacloud-' で始まること",
    "バージョニングが有効であること",
    "パブリックアクセスがブロックされていること"
  ],
  "hints": [
    "aws s3api create-bucket コマンドを使用できます"
  ],
  "validationScript": "...",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z"
}
```

## 問題作成

新しい問題を作成します。

```http
POST /problems
```

### リクエストボディ

```json
{
  "title": "Lambda 関数のデプロイ",
  "description": "Node.js の Lambda 関数をデプロイしてください",
  "difficulty": "MEDIUM",
  "category": "compute",
  "points": 200,
  "timeLimit": 600,
  "requirements": [
    "ランタイムは Node.js 20.x",
    "メモリは 256MB",
    "タイムアウトは 30 秒"
  ],
  "hints": [
    "AWS CLI または SAM を使用できます"
  ]
}
```

## 問題更新

既存の問題を更新します。

```http
PUT /problems/:id
```

## 問題削除

問題を削除します。

```http
DELETE /problems/:id
```

## AI 問題生成

AI を使用して問題を自動生成します。

```http
POST /ai/generate
```

### リクエストボディ

```json
{
  "category": "networking",
  "difficulty": "MEDIUM",
  "topic": "VPC とサブネットの構成",
  "requirements": "マルチ AZ 構成で高可用性を実現"
}
```

### レスポンス

```json
{
  "generated": {
    "title": "マルチ AZ VPC の構築",
    "description": "高可用性を実現するマルチ AZ VPC を構築してください",
    "difficulty": "MEDIUM",
    "category": "networking",
    "points": 250,
    "timeLimit": 900,
    "requirements": [
      "2 つのアベイラビリティゾーンを使用",
      "パブリックサブネットとプライベートサブネットを各 AZ に作成",
      "NAT Gateway を配置"
    ],
    "hints": [
      "VPC CIDR は /16 を推奨します",
      "サブネットは /24 で分割できます"
    ]
  }
}
```

## AI 問題プレビュー

生成される問題をプレビューします（保存なし）。

```http
POST /ai/preview
```

リクエスト/レスポンスは `/ai/generate` と同じです。

## 難易度

| 値 | 説明 | 目安ポイント |
|----|------|-------------|
| EASY | 初級 | 50-100 |
| MEDIUM | 中級 | 150-250 |
| HARD | 上級 | 300-400 |
| EXPERT | エキスパート | 500+ |

## カテゴリ

| 値 | 説明 |
|----|------|
| compute | コンピューティング（EC2, Lambda, ECS など） |
| storage | ストレージ（S3, EBS, EFS など） |
| database | データベース（RDS, DynamoDB など） |
| networking | ネットワーキング（VPC, Route53 など） |
| security | セキュリティ（IAM, KMS など） |
| serverless | サーバーレス（Lambda, API Gateway など） |
| containers | コンテナ（ECS, EKS など） |
| devops | DevOps（CodePipeline, CloudFormation など） |

## エラーレスポンス

```json
{
  "error": "Problem not found",
  "code": "PROBLEM_NOT_FOUND"
}
```

## 使用例

### 問題の作成と AI 生成

```typescript
// 手動で問題を作成
const manualProblem = await fetch('/api/admin/problems', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'x-tenant-id': tenantId,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    title: 'EC2 インスタンスの起動',
    difficulty: 'EASY',
    category: 'compute',
    // ...
  }),
});

// AI で問題を生成
const aiProblem = await fetch('/api/admin/ai/generate', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'x-tenant-id': tenantId,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    category: 'security',
    difficulty: 'HARD',
    topic: 'IAM ポリシーの最小権限設計',
  }),
});
```
