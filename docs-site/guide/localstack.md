# LocalStack セットアップ

LocalStack は AWS サービスをローカルでエミュレートするツールです。TenkaCloud の開発環境では、LocalStack を使用して AWS リソースをローカルで動作させます。

## 概要

LocalStack 起動時に以下の AWS リソースが自動作成されます。

| サービス | リソース | 用途 |
|----------|----------|------|
| DynamoDB | `TenkaCloud-dev` | メインテーブル（Single-Table Design） |
| Cognito | `tenkacloud-users` | ユーザープール |
| S3 | `tenkacloud-assets` | 静的アセット |
| S3 | `tenkacloud-uploads` | ユーザーアップロード |
| S3 | `tenkacloud-logs` | ログ保存 |
| SQS | `battle-events` | バトルイベントキュー |
| SQS | `scoring-tasks` | 採点タスクキュー |
| EventBridge | `tenkacloud-events` | イベントバス |
| Lambda | 各種 | プロビジョニング処理 |

## 起動方法

```bash
# Docker Desktop を起動してから実行
make start
```

このコマンドで以下が実行されます。

1. LocalStack コンテナの起動
2. 初期化スクリプト（`localstack-init.sh`）の実行
3. Terraform によるインフラデプロイ
4. フロントエンド開発サーバーの起動

## データ永続化

LocalStack のデータは `PERSISTENCE=1` 設定により、コンテナ再起動後も保持されます。

```yaml
# docker-compose.yml
localstack:
  environment:
    - PERSISTENCE=1
  volumes:
    - localstack_data:/var/lib/localstack
```

`docker compose down -v` を実行するとボリュームが削除され、データが消失するため注意してください。

## リソース確認コマンド

```bash
# DynamoDB テーブル一覧
awslocal dynamodb list-tables

# テーブル詳細
awslocal dynamodb describe-table --table-name TenkaCloud-dev

# S3 バケット一覧
awslocal s3 ls

# Lambda 関数一覧
awslocal lambda list-functions --query 'Functions[].FunctionName'

# SQS キュー一覧
awslocal sqs list-queues

# Cognito ユーザープール一覧
awslocal cognito-idp list-user-pools --max-results 10

# EventBridge イベントバス一覧
awslocal events list-event-buses --query 'EventBuses[].Name'
```

## DynamoDB の確認

### テーブルスキャン

```bash
awslocal dynamodb scan --table-name TenkaCloud-dev
```

### 特定アイテムの取得

```bash
awslocal dynamodb get-item \
  --table-name TenkaCloud-dev \
  --key '{"PK": {"S": "TENANT#xxx"}, "SK": {"S": "METADATA"}}'
```

### GSI クエリ

```bash
# GSI2 で EntityType が TENANT のアイテムを取得
awslocal dynamodb query \
  --table-name TenkaCloud-dev \
  --index-name GSI2 \
  --key-condition-expression "EntityType = :type" \
  --expression-attribute-values '{":type": {"S": "TENANT"}}'
```

## Lambda ログの確認

```bash
# Provisioning Lambda のログ
awslocal logs tail /aws/lambda/tenkacloud-local-provisioning --follow

# Tenant Provisioner のログ
awslocal logs tail /aws/lambda/tenkacloud-local-tenant-provisioner --follow

# Provisioning Completion のログ
awslocal logs tail /aws/lambda/tenkacloud-local-provisioning-completion --follow
```

## トラブルシューティング

### LocalStack が起動しない

```bash
# ログを確認
docker compose logs localstack

# 再起動
make stop && make start
```

### リソースが作成されない

```bash
# ヘルスチェック
curl http://localhost:4566/_localstack/health

# サービス状態を確認（dynamodb が available か確認）
curl -s http://localhost:4566/_localstack/health | jq '.services'
```

### データが消えた

`docker compose down -v` を実行するとボリュームが削除されます。`docker compose down`（`-v` なし）または `make stop` を使用してください。

## 環境変数

バックエンドサービスで使用する環境変数の例を示します。

```bash
DYNAMODB_TABLE_NAME=TenkaCloud-dev
DYNAMODB_ENDPOINT=http://localhost:4566
AWS_REGION=ap-northeast-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
```

## 関連ファイル

| ファイル | 説明 |
|----------|------|
| `docker-compose.yml` | LocalStack コンテナ定義 |
| `scripts/localstack-init.sh` | 初期化スクリプト |
| `scripts/local-setup.sh` | セットアップスクリプト |
| `infrastructure/terraform/environments/local/` | Terraform 設定 |
