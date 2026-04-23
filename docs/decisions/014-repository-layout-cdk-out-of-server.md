# ADR-014: Repository Layout — CDK out of server/

- **Status**: Accepted
- **Date**: 2026-04-23
- **Deciders**: susumutomita

## Context

PR #414 で SBT 0.3.9 ベースの CDK スタック群 (`server/lib/`, `server/bin/cdk.ts`, `server/test/`, `server/cdk.json`, etc.) を `server/` 直下に置いたが、`server/` には同時に Hono バックエンドのソース (`server/application/microservices/`, `server/application/libs/`, `server/application/reverseproxy/`) も入っており、ディレクトリの責務が混在している。

新規参加者やエージェントが `server/` を見たときに「これはバックエンドサーバ?」「CDK?」「両方?」を判断できず、コード探索コストが高い。`server/application/` という中間階層も冗長で、`server/application/microservices/tenant-management/src/...` のような長いパスがオンボーディングのノイズになっている。

## Decision

### 1. CDK は `infrastructure/cdk/` に分離

```
旧                                  新
server/bin/cdk.ts                → infrastructure/cdk/bin/cdk.ts
server/lib/                      → infrastructure/cdk/lib/
server/test/                     → infrastructure/cdk/test/
server/cdk.json                  → infrastructure/cdk/cdk.json
server/Makefile                  → infrastructure/cdk/Makefile
server/package.json              → infrastructure/cdk/package.json
server/tsconfig.json             → infrastructure/cdk/tsconfig.json
server/vitest.config.ts          → infrastructure/cdk/vitest.config.ts
server/biome.json                → infrastructure/cdk/biome.json
server/environments/             → infrastructure/cdk/environments/
```

`infrastructure/templates/competitor-deploy-role.yaml` は維持 (COMPETITOR_ONBOARDING_GUIDE が依存)。

### 2. `server/application/` の中間階層を撤去

```
旧                                  新
server/application/microservices/ → server/microservices/
server/application/libs/         → server/libs/
server/application/reverseproxy/ → server/reverseproxy/
```

`server/` は **Hono バックエンドの専有ディレクトリ** にする。

### 3. 確定後の top-level

```
TenkaCloud/
├── client/                       Next.js フロント (AdminWeb, Application)
├── server/                       Hono バックエンド (microservices, libs, reverseproxy)
├── infrastructure/
│   ├── cdk/                      SBT 0.3.9 ベースの CDK
│   └── templates/                CFn テンプレート (competitor IAM Role 等)
├── packages/                     共有ライブラリ (quality harness 検出ロジック等)
├── scripts/                      開発スクリプト + CDK orchestration
├── docs/                         architecture/, decisions/, guides/, plans/
└── problems/                     GameDay/JAM 問題セット
```

### 4. 更新が必要な参照

機械的に書き換える対象は以下のとおり。

- `scripts/install.sh`, `cleanup.sh`, `provision-tenant.sh`, `deprovision-tenant.sh`, `update-tenant.sh` の `cd server` を `cd infrastructure/cdk` に
- ルート `package.json` の workspaces
- 各 `server/microservices/*/Dockerfile` の COPY パス (`../libs/` 等)
- ルート `Makefile` の `make -C server` 系を `make -C infrastructure/cdk` に
- `.github/workflows/*.yml` の paths と作業ディレクトリ
- `README.md`, `AGENTS.md`, `docs/QUICKSTART.md`, `docs/architecture/*.md`, ADR-011, ADR-013 のパス参照
- `docker-compose.yml` の build context

### 5. 削除する vestige

- `infrastructure/.gitignore` (中身が空に近い、不要)
- `infrastructure/.npmignore` (npm パッケージ化しないので不要)
- `infrastructure/templates/sample-s3-security.yaml` (どこからも参照なし、サンプル意図不明)

## Consequences

- **Good**: `server/` を見ただけで Hono バックエンドだと分かる。`infrastructure/` を見れば IaC が全部入っている。新規参加者の探索コストが下がる。
- **Good**: `server/application/microservices/` の冗長な中間階層がなくなり、相対パスが短くなる。
- **Good**: ADR-013 の SBT wire format invariant は変わらない (CDK 配置場所のみ変わる)。
- **Bad**: 一度に変える参照が多い (Makefile, scripts, Dockerfile, CI, docs)。レビュー負荷が高い PR になる。
- **Bad**: 既存ブランチ・進行中の PR とのマージコンフリクトが発生する。
- **Tradeoff**: 段階的な移行 (CDK だけ先・application 昇格は後) も検討したが、両方やらないと `server/application/` が浮く中途半端な状態になるので一気に進める。

## References

- [ADR-011: SBT Control Plane と二層 Application Plane 構成](./011-sbt-control-plane-and-two-layer-application-plane.md)
- [ADR-012: Repository Restructuring](./012-repository-restructuring.md)
- [ADR-013: SBT Control Plane Onboarding Wire Format](./013-sbt-control-plane-onboarding-wire-format.md)
