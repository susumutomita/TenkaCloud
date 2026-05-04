# TenkaCloud

クラウド技術者向けの OSS 競技プラットフォーム
(AWS GameDay / JAM 形式の常設マルチテナント SaaS)。

## 状態 (2026-05-04 時点)

ProtoShip ベースへの移行中。`trunk/protoship-migration` ブランチで作業し、
完了したら `main` にマージする。

## レイアウト

```text
apps/admin-console/             Control Plane UI
apps/application-admin-console/ Application Plane (per-tenant) UI
apps/auth-proxy/                ※ 取り込み待ち (deploy 必須)
apps/sample/                    ※ 取り込み待ち
infrastructure/                 SBT 0.3.9 ベースの CDK スタック群
scripts/                        install / cleanup / provision-tenant 等
problems/                       GameDay / JAM 問題集
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
```

### AWS deploy

```bash
cp infrastructure/environments/development/.env.example \
   infrastructure/environments/development/.env
# .env に SYSTEM_ADMIN_EMAIL を入れる
make deploy ENV=development
```

`scripts/install.sh` が 3-phase で deploy する
(Backend → AdminConsole → ControlPlane CORS rebind)。

> ⚠️ 現状 `make deploy` は `apps/auth-proxy` の取り込みが完了するまで
> CDK synth でコケる。

## 移行スコープ

- `apps/auth-proxy` `apps/sample` を ProtoShip から取り込み
- GameDay scoring / battle / leaderboard の実装移植
- 問題 CFn テンプレートの apps/sample との繋ぎ込み
- 旧 docs / ADR の整理
- `trunk/protoship-migration` から `main` への最終マージ

詳細は [docs/](./docs/)。
