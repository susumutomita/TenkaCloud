# TenkaCloud

クラウド技術者向けの OSS 競技プラットフォーム
(AWS GameDay / JAM 形式の常設マルチテナント SaaS)。

## レイアウト

```text
apps/admin-console/             Control Plane UI (テナント管理)
apps/application-admin-console/ Application Plane UI (per-tenant 管理)
infrastructure/                 SBT 0.3.9 ベースの CDK スタック群
scripts/                        install / cleanup / provision-tenant 等
problems/                       GameDay / JAM 問題集 (CFn + scoring)
docs/                           アーキテクチャ・ADR・運用ガイド
```

## クイックスタート

### 必要なもの

- AWS CLI (deploy 時)
- Bun
- Docker (CDK BucketDeployment bundling)

### ローカル動作確認

```bash
bun install
bun run typecheck
bun run test
```

### AWS deploy

```bash
cp infrastructure/environments/development/.env.example \
   infrastructure/environments/development/.env
# .env に SYSTEM_ADMIN_EMAIL を入れる
make deploy ENV=development
```

詳細は [docs/](./docs/)。
