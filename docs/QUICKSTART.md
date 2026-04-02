# TenkaCloud Quick Start

この手順は、ローカル開発を最短で始めるための正本です。

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

- Local emulator
- Control Plane UI
- Application Plane UI
- tenant-management
- problem-service
- gameday-service
- battle-service
- scoring-service
- leaderboard-service

### 3. ブラウザで確認する

- Control Plane: `http://localhost:13000/control`
- Application Plane: `http://localhost:13001/`

補助 URL は以下のとおりです。

- Tenant API: `http://localhost:13004/api/tenants`
- Problem API: `http://localhost:3100/api`
- GameDay API: `http://localhost:3020/api/gameday`
- Local emulator: `http://localhost:4566`

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
cd backend/services/control-plane/tenant-management
bun run dev
```

```bash
cd backend/services/application-plane/problem-service
bun run dev
```

## 動作確認

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

### Local emulator が起動しない

```bash
docker compose logs localstack
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

競合プロセスは `lsof -i :13000` のように確認してください。

## 補足

- `Plan.md` や `docs/plans/` には履歴的な設計メモが含まれるが、セットアップ手順の正本ではない。
- `docs-site/` は公開向けの要約であり、内部向けの正本は `docs/` である。
- 一時的な切り分け手順や個人メモはこの文書に追加しない。
