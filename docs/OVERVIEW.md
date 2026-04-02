# TenkaCloud 概要

この文書は、TenkaCloud の「いま動いている構成」を短く把握するための入口です。詳細な手順は [QUICKSTART.md](./QUICKSTART.md)、設計判断は [architecture/architecture.md](./architecture/architecture.md) を参照してください。

## 何を作っているか

TenkaCloud は、クラウド競技イベントを常設化するための OSS プラットフォームです。単発のイベント運営だけでなく、継続的なテナント運用、問題管理、スコアリング、ランキングを一つのプロダクトで扱います。

## 現在のシステム境界

### 1. Control Plane

プラットフォーム運営者向けの共通領域です。

- テナント管理
- 設定管理
- 共有 API への導線
- 今後の監査、プロビジョニング、全体運用

実体:

- UI: `apps/control-plane`
- サービス群: `backend/services/control-plane/*`

### 2. Application Plane

各テナントや参加者が触る競技領域です。

- GameDay イベント
- Battle セッション
- 問題閲覧と挑戦
- ランキング、プロフィール

実体:

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

主要ポート:

| コンポーネント | URL |
|---|---|
| Control Plane | `http://localhost:13000/control` |
| Application Plane | `http://localhost:13001/` |
| Tenant API | `http://localhost:13004/api/tenants` |
| Problem API | `http://localhost:3100/api` |
| GameDay API | `http://localhost:3020/api/gameday` |
| Local emulator | `http://localhost:4566` |

## 認証の現行方針

- 本番相当: Auth0
- ローカル確認: `AUTH_SKIP=1`

古い文書にある `Keycloak`、`Cognito`、`frontend/` ディレクトリ前提は現行リポジトリの正本ではありません。

## 実装状況の見方

- UI の現在地は `apps/*/app` とそのテストを優先して確認する
- API の現在地は `backend/services/**/src` を優先して確認する
- 歴史的な計画や草案は `Plan.md` や `docs/plans/` に残っているが、仕様の正本ではない

## 次に読む文書

- まず起動したい: [QUICKSTART.md](./QUICKSTART.md)
- 全体設計を把握したい: [architecture/architecture.md](./architecture/architecture.md)
- ADR を追いたい: [decisions](./decisions/)
