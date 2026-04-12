# TenkaCloud 概要

この文書は、TenkaCloud の責務分割と文書の入口を短く把握するための概要です。詳細な手順は [QUICKSTART.md](./QUICKSTART.md)、設計判断は [architecture/architecture.md](./architecture/architecture.md)、不変条件は [architecture/harness.md](./architecture/harness.md) を参照してください。

## 何を作っているか

TenkaCloud は、クラウド競技イベントを常設化するための OSS プラットフォームです。単発のイベント運営だけでなく、継続的なテナント運用、問題管理、スコアリング、ランキングを 1 つのプロダクトで扱います。

## システム境界

### 1. Control Plane

プラットフォーム運営者向けの共通領域です。

- テナント管理
- 設定管理
- 共有 API への導線
- 監査、プロビジョニング要求、全体運用

Control Plane は tenant manager です。tenant runtime や problem runtime を直接ホストしません。

実体は以下のとおりです。

- UI: `apps/control-plane`
- サービス群: `backend/services/control-plane/*`

### 2. Application Plane

各テナントや参加者が触る競技領域です。

- GameDay イベント
- Battle セッション
- 問題閲覧と挑戦
- ランキング、プロフィール
- tenant admin UI
- competitor AWS account への問題デプロイ

Application Plane は tenant ごとに 1 つです。tenant は company 単位であり、department 単位では分けません。

実体は以下のとおりです。

- UI: `apps/application-plane`
- サービス群: `backend/services/application-plane/*`

## 現在のリポジトリ構成

```text
TenkaCloud/
├── apps/
│   ├── control-plane/
│   └── application-plane/
├── backend/services/
│   ├── control-plane/
│   ├── application-plane/
│   └── shared/
├── packages/
├── problems/
├── docs/
├── docs-site/
├── infrastructure/
└── Makefile
```

## ローカル開発の前提

- `make install`: 依存関係インストール
- `make start`: Local emulator と各開発サーバーを起動
- `make before-commit`: 文書更新を含む最終検証

主要ポートは以下のとおりです。

| コンポーネント | URL |
|---|---|
| Control Plane | `http://localhost:13000/control` |
| Application Plane | `http://localhost:13001/` |
| Tenant API | `http://localhost:13004/api/tenants` |
| Problem API | `http://localhost:3100/api` |
| GameDay API | `http://localhost:3020/api/gameday` |
| Local emulator | `http://localhost:4566` |

## 認証方針

- 本番相当では Auth0 を使う
- ローカル確認では `AUTH_SKIP=1` を使える

古い文書にある `Keycloak`、`Cognito`、`frontend/` ディレクトリ前提は現行リポジトリの正本ではありません。

## 仕様の読み方

- UI の仕様は `apps/*/app` とそのテストを優先して確認する
- API の仕様は `backend/services/**/src` を優先して確認する
- アーキテクチャ境界と one-pass 完了条件は `docs/architecture/harness.md` を優先する
- 歴史的な計画や草案は `Plan.md` や `docs/plans/` に残るが、仕様の正本ではない

## 次に読む文書

- まず起動したい: [QUICKSTART.md](./QUICKSTART.md)
- 全体設計を把握したい: [architecture/architecture.md](./architecture/architecture.md)
- ADR を追いたい: [decisions](./decisions/)
