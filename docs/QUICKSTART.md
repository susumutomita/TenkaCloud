# TenkaCloud Quick Start

この手順は、ローカル開発を最短で始めるための正本です。アーキテクチャ不変条件は [architecture/harness.md](./architecture/harness.md) を参照してください。

## 前提

以下がローカルに必要です。

| ツール | 用途 |
|---|---|
| Docker Desktop | Local emulator の起動 |
| Bun | パッケージ管理と開発実行 |
| AWS CLI | エミュレータ確認用 |
| Terraform | Auth0 セットアップ時のみ使用 |

## 最短手順

### 1. 依存関係を入れる

```bash
make install
```

### 2. 起動する

```bash
make start
```

`make start` は以下をまとめて起動します。

- Cloud emulator (`Kumo` / `LocalStack` / `Floci`)
- `DynamoDB Local`
- Control Plane UI
- Application Plane UI
- tenant-management
- problem-service
- gameday-service
- battle-service
- scoring-service
- leaderboard-service

one-pass を詰めるときは通常の `make start` ではなく、次を使います。

```bash
make start-one-pass-local
```

これは local provisioning publish を有効にし、dev identity header で admin / participant を切り替える one-pass 用の起動方法です。AWS 系 API は `http://localhost:4566`、DynamoDB は `http://localhost:8000` を使います。通常確認の `make start` より強い前提を持ちます。

### 3. ブラウザで確認する

- Control Plane: `http://localhost:13000/control`
- Application Plane: `http://localhost:13001/`

補助 URL は以下のとおりです。

- Tenant API: `http://localhost:13004/api/tenants`
- Problem API: `http://localhost:3100/api`
- GameDay API: `http://localhost:3020/api/gameday`
- Cloud emulator: `http://localhost:4566`
- DynamoDB Local: `http://localhost:8000`

## 認証

ローカル開発では `make start` が `AUTH_SKIP=1` と `NEXT_PUBLIC_AUTH_SKIP=1` を注入します。UI と API の結線確認だけなら、追加設定なしで進められます。

Auth0 を使って本番相当で試す場合は [AUTH0_SETUP.md](./AUTH0_SETUP.md) を参照してください。

## 個別起動

全体起動ではなく一部だけ見たい場合は以下のとおりです。

```bash
make dev       # Control Plane のみ
make dev-app   # Application Plane のみ
```

バックエンドを個別に触る場合の例は以下のとおりです。

```bash
cd server/application/microservices/tenant-management
bun run dev
```

```bash
cd server/application/microservices/problem-service
bun run dev
```

## 動作確認

### one-pass の最小確認

ローカルで「一部ページが開く」だけでは完了扱いにしません。最低限、次の one-pass を確認します。

1. `make start-one-pass-local` を実行する
2. 別ターミナルで `make test_one_pass_local` を実行する
3. tenant 作成、provisioning、Application Plane 到達、local provider での problem deploy、event 作成、competitor account 登録、participant join、`attack / defense / vote` が自動で通ることを確認する
4. local の `aws-console` は fail-closed、AWS の成功系は [`docs/guides/one-pass-aws.md`](guides/one-pass-aws.md) の runbook で確認する

この one-pass は `docs/architecture/harness.md` の `ONE_PASS_LOCAL` と同じです。

### one-pass 用の起動

通常の `make start` は日常開発用です。one-pass では admin 権限と provisioning backend を有効にした専用起動を使います。

```bash
make start-one-pass-local
```

このターゲットでは次を有効にします。

- `PROVISIONING_ENABLED=true`
- `AWS_ENDPOINT_URL=http://localhost:4566`
- `DYNAMODB_ENDPOINT=http://localhost:8000`
- `EVENT_BUS_NAME=tenkacloud-local-tenant-events`
- `AUTH_SKIP_ROLES=participant`
- admin / competitor への切り替えは dev identity header で行う

実行コマンドは次です。

```bash
make test_one_pass_local
```

未実装の箇所は `BLOCKED` として表示され、終了コードは non-zero になります。これは partial success を完了扱いにしないためです。

### tenant-management

```bash
curl http://localhost:13004/health
```

期待値は以下のとおりです。

```json
{"status":"ok","service":"tenant-management"}
```

### 問題 API

```bash
curl http://localhost:3100/api/health
```

### GameDay API

```bash
curl http://localhost:3020/api/gameday/health
```

## よく使うコマンド

| コマンド | 説明 |
|---|---|
| `make install` | 依存関係をインストール |
| `make start` | ローカル環境を起動 |
| `make stop` | ローカル環境を停止 |
| `make restart` | 再起動 |
| `make status` | サービス状態を表示 |
| `make test` | カバレッジ付きテスト |
| `make before-commit` | lint, format, typecheck, test, build |
| `make gameday-seed` | GameDay デモデータ投入 |

## トラブルシューティング

### Docker が起動していない

```bash
docker ps
```

失敗する場合は Docker Desktop を起動してから再実行します。

### tenant-management に繋がらない

まずヘルスチェックを確認します。

```bash
curl http://localhost:13004/health
```

Control Plane から失敗する場合は `TENANT_API_BASE_URL=http://localhost:13004/api` が使われているか確認します。

### Cloud emulator または DynamoDB Local が起動しない

```bash
docker compose logs kumo
docker compose logs dynamodb-local
```

その後、必要なら以下を実行します。

```bash
make stop
make start
```

### ポート競合

使っているポートは以下のとおりです。

- `13000`
- `13001`
- `13004`
- `3100`
- `3020`
- `4566`
- `8000`

競合プロセスは `lsof -i :13000` のように確認してください。

## 補足

- `Plan.md` や `docs/plans/` には履歴的な設計メモが含まれるが、セットアップ手順の正本ではない。
- `docs-site/` は公開向けの要約であり、内部向けの正本は `docs/` である。
- 一時的な切り分け手順や個人メモはこの文書に追加しない。
