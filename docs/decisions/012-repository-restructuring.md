# ADR-012: リポジトリ構造の再編

- **Status**: Accepted
- **Date**: 2026-04-14
- **Deciders**: susumutomita

## Context

リポジトリのディレクトリ構成に一貫性がなく、コードの所在がわかりにくい。

### 現状の問題

1. **shared が 3 箇所に分散**: `packages/core`, `packages/shared`, `backend/services/shared` — 何をどこに置くべきか不明
2. **`packages/core` がバックエンド専用**: `aws`, `scoring` はバックエンド関心事なのに `packages` にある
3. **`packages/shared` がフロント専用**: `components` が入っているが名前から判別できない
4. **深いネスト**: `backend/services/application-plane/problem-service/` — 4 階層
5. **死んだコード**: `reference/`（SBT 参考実装）、`tmp/`、Terraform と CDK の共存
6. **ドキュメントが 2 箇所**: `docs/` と `docs-site/`
7. **Makefile の肥大化**: 起動ターゲット 9 個、停止ターゲット 7 個、DynamoDB 待機ループ 3 重複、`start-infrastructure` 二重定義

### SBT への移行

ADR-011 で SBT (`@cdklabs/sbt-aws`) を採用し、Control Plane / Application Plane のプレーン構造を採ることが決まった。ディレクトリ構成もこれに合わせる。

## Decision

### 1. ディレクトリ構成をプレーンベースに再編する

```
tenkacloud/
├── control-plane/
│   ├── app/                          ← Next.js (旧 apps/control-plane)
│   └── services/
│       └── tenant-management/        ← 旧 backend/services/control-plane/tenant-management
│
├── application-plane/
│   ├── app/                          ← Next.js (旧 apps/application-plane)
│   └── services/
│       ├── problem-service/          ← 旧 backend/services/application-plane/problem-service
│       ├── gameday-service/          ← 旧 backend/services/application-plane/gameday-service
│       ├── battle-service/           ← 旧 backend/services/application-plane/battle-service
│       ├── scoring-service/          ← 旧 backend/services/application-plane/scoring-service
│       └── leaderboard-service/      ← 旧 backend/services/application-plane/leaderboard-service
│
├── packages/                         ← 共有ライブラリ（統合・再分類）
│   ├── dynamodb/                     ← 旧 backend/services/shared/dynamodb
│   ├── events/                       ← 旧 backend/services/shared/events
│   ├── auth/                         ← 旧 backend/services/shared/auth0
│   ├── cloud/                        ← 旧 backend/services/shared/cloud-abstraction
│   ├── types/                        ← 旧 packages/core/types + packages/shared/types を統合
│   ├── scoring/                      ← 旧 packages/core/scoring
│   ├── quality/                      ← 旧 packages/shared/quality
│   └── ui/                           ← 旧 packages/shared/components + packages/design-system を統合
│
├── infrastructure/
│   ├── cdk/                          ← SBT CDK スタック（旧 infrastructure/cdk）
│   └── nginx/                        ← リバースプロキシ設定
│
├── problems/                         ← GameDay 問題テンプレート
│   └── gameday/
│
├── docs/                             ← ドキュメント（docs-site を統合）
│   ├── architecture/
│   ├── decisions/
│   └── guides/
│
└── scripts/                          ← ビルド・開発スクリプト
```

### 2. 削除するもの

| 対象 | 理由 |
|---|---|
| `reference/` | SBT 参考実装。必要時に GitHub から参照すればよい |
| `tmp/` | 一時ファイル。`.gitignore` に追加 |
| `infrastructure/terraform/` | CDK + SBT に一本化（ADR-011） |
| `docs-site/` | `docs/` に統合 |
| `backend/services/control-plane/provisioning/` | SBT の ApplicationPlane が担う |
| `backend/services/control-plane/provisioning-completion/` | 同上 |
| `backend/services/application-plane/tenant-provisioner/` | 同上 |
| `packages/core/` | `packages/types`, `packages/scoring` に分解 |
| `packages/shared/` | `packages/ui`, `packages/quality`, `packages/types` に分解 |
| `packages/design-system/` | `packages/ui` に統合 |
| `backend/services/shared/` | `packages/` に昇格 |

### 3. Makefile を必要最小限に絞る

**Before (36 ターゲット)**:
start, start-compose, start-infrastructure, start-infrastructure-bg, start-dev-servers, start-local, start-one-pass-local, start-aws, start-all, start-kumo, start-localstack, start-floci, stop, stop-compose, stop-local, stop-dev-servers, stop-all, stop-control-plane, stop-infrastructure, restart, restart-all, docker-build, docker-run, docker-stop, check-docker, check-docker-hub, docker-status, ...

**After (14 ターゲット)**:

```makefile
# === 開発 ===
make start              # ローカル全起動（エミュレータ + DynamoDB + dev サーバー）
make start-aws          # 実 AWS 接続モード
make stop               # 全停止
make status             # サービス状態表示

# === 品質 ===
make before-commit      # lint + format + typecheck + test + build
make test               # テスト（カバレッジ付き）
make test-quick         # テスト（カバレッジなし）

# === セットアップ ===
make install            # 依存関係インストール
make seed               # シードデータ投入

# === インフラ ===
make cdk-deploy         # CDK デプロイ
make cdk-destroy        # CDK 削除

# === その他 ===
make build              # プロダクションビルド
make help               # ヘルプ
```

削除するターゲットは以下の通り。
- `start-compose`, `start-all`, `stop-all`, `restart-all` — `start` / `stop` に統合
- `start-infrastructure`, `start-infrastructure-bg`, `stop-infrastructure` — `start` に統合
- `start-dev-servers`, `stop-dev-servers` — `start` に統合
- `start-kumo`, `start-localstack`, `start-floci` — `CLOUD_EMULATOR=xxx make start` で切り替え
- `start-one-pass-local` — `make start` のオプション化
- `docker-build`, `docker-run`, `docker-stop` — `start-compose` に統合済みで不要
- `check-docker-hub` — 過剰
- `auth0-*` (5 個) — CDK に移行
- `setup-dynamodb` — `start` に統合

### 4. 移行手順

破壊的な一括変更ではなく、以下の順序で段階的に実行する。

**Phase 1: 削除（リスク低）**
1. `reference/`, `tmp/` を削除
2. `docs-site/` を `docs/` に統合
3. 死んだ provisioning Lambda コード（`provisioning/`, `provisioning-completion/`, `tenant-provisioner/`）を削除
4. `infrastructure/terraform/` を削除（CDK に移行済み）

**Phase 2: packages 統合（リスク中）**
1. `backend/services/shared/*` を `packages/*` に移動
2. `packages/core/` を分解して `packages/types`, `packages/scoring` に
3. `packages/shared/` を分解して `packages/ui`, `packages/quality` に
4. `packages/design-system/` を `packages/ui` に統合
5. 全 import パスを更新

**Phase 3: プレーン構造化（リスク高）**
1. `apps/control-plane/` → `control-plane/app/`
2. `apps/application-plane/` → `application-plane/app/`
3. `backend/services/control-plane/*` → `control-plane/services/*`
4. `backend/services/application-plane/*` → `application-plane/services/*`
5. Dockerfile, docker-compose.yml, CI ワークフローの全パス更新

**Phase 4: Makefile 整理**
1. 重複ターゲットを統合
2. DynamoDB 待機ループを共通関数化
3. 死んだターゲット（auth0-*, docker-*）を削除
4. ヘルプを更新

## Consequences

- **Good**: ディレクトリ構成が SBT のプレーンモデルと一致し、「どこに何があるか」が自明になる。shared の分散が解消される。Makefile が半分以下になる。
- **Bad**: Phase 3 は全ファイルの import パス、Dockerfile、CI 設定に影響するため、一時的に大きな差分が出る。段階的にやっても各 Phase 内では一括変更が必要。
- **Tradeoff**: Git blame の履歴が切れる。`git log --follow` で追えるが、コードレビューは diff が大きくなる。

## References

- [ADR-011: SBT Control Plane と二層 Application Plane 構成](./011-sbt-control-plane-and-two-layer-application-plane.md)
- [@cdklabs/sbt-aws](https://github.com/awslabs/sbt-aws)
