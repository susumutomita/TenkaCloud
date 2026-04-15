# ADR-012: PoC からの再構築 — AWS SaaS Reference Architecture 準拠

- **Status**: Accepted
- **Date**: 2026-04-15
- **Deciders**: susumutomita

## Context

PoC を通じて何を作るべきかが明確になりました。しかし現在のコードベースは以下の問題を抱えており、段階的リファクタリングよりも正しい構造で書き直す方が合理的です。

### 現状の問題

1. **ディレクトリ構成に一貫性がない**: `apps/`, `backend/`, `packages/` がフラットに並び、粒度がバラバラ
2. **shared が 3 箇所に分散**: `packages/core`, `packages/shared`, `backend/services/shared`
3. **DynamoDB シングルテーブルを全サービスが共有**: 1 サービスのスキーマ変更が全体に影響し、独立デプロイが不可能
4. **Makefile が 36 ターゲットに肥大化**: 重複定義、コピー&ペーストのループ、死んだターゲットが混在
5. **死んだコード**: `reference/`, `tmp/`, Terraform と CDK の共存、空の provisioning Lambda
6. **AI エージェントが局所最適で積み上げた**: Codex ブランチが構造を見ずにコードを足し続けた結果のスパゲティ

### 方針転換

PoC のコードを捨て、[AWS SaaS Reference Architecture (ECS)](https://github.com/aws-samples/saas-reference-architecture-ecs) と粒度を揃えた構造で再構築する。ビジネスロジック（Hono ハンドラ、React コンポーネント、テストコード）は移植する。

## Decision

### 1. AWS SaaS Reference Architecture に準拠したディレクトリ構成

```
tenkacloud/
├── client/                               ← フロントエンド
│   ├── AdminWeb/                         ← Control Plane UI (Next.js)
│   └── Application/                      ← Application Plane UI (Next.js)
│
├── server/                               ← バックエンド + インフラ
│   ├── application/
│   │   ├── libs/                         ← サービス間共有ライブラリ
│   │   │   ├── auth/                     ← 認証ヘルパー
│   │   │   ├── events/                   ← EventBridge イベント型定義
│   │   │   └── types/                    ← 共有型定義
│   │   ├── microservices/                ← 各サービス（DB 独立）
│   │   │   ├── tenant-management/
│   │   │   ├── problem-service/
│   │   │   ├── gameday-service/
│   │   │   ├── battle-service/
│   │   │   ├── scoring-service/
│   │   │   └── leaderboard-service/
│   │   └── reverseproxy/                ← nginx 設定
│   ├── lib/                              ← CDK (SBT ControlPlane + ApplicationPlane)
│   └── bin/                              ← CDK エントリポイント
│
├── scripts/                              ← ビルド・開発スクリプト
├── problems/                             ← GameDay 問題テンプレート
└── docs/                                 ← ドキュメント
```

### 2. サービスごとに DB を独立させる

PoC ではシングルテーブル `TenkaCloud-dev` を全サービスが共有していた。再構築ではサービスごとに DynamoDB テーブルを持ち、独立してデプロイ可能にする。

```
microservices/
├── tenant-management/
│   ├── src/
│   ├── Dockerfile
│   └── cdk/                ← このサービスの DynamoDB テーブル定義
│       └── table.ts        ← TenkaCloud-TenantManagement
│
├── problem-service/
│   ├── src/
│   ├── Dockerfile
│   └── cdk/
│       └── table.ts        ← TenkaCloud-Problems
│
├── gameday-service/
│   ├── src/
│   ├── Dockerfile
│   └── cdk/
│       └── table.ts        ← TenkaCloud-GameDay
│
├── battle-service/
│   └── ...                 ← TenkaCloud-Battle
├── scoring-service/
│   └── ...                 ← TenkaCloud-Scoring
└── leaderboard-service/
    └── ...                 ← TenkaCloud-Leaderboard
```

**各サービスの DB 責務:**

| サービス | テーブル | PK/SK パターン |
|---|---|---|
| tenant-management | TenkaCloud-Tenants | `TENANT#{id}` / `METADATA`, `USER#{id}` |
| problem-service | TenkaCloud-Problems | `PROBLEM#{id}` / `METADATA`, `EVENT#{id}` |
| gameday-service | TenkaCloud-GameDay | `GAMEDAY#{eventId}` / `TEAM#{id}`, `PARTICIPANT#{id}` |
| battle-service | TenkaCloud-Battle | `BATTLE#{id}` / `ROUND#{id}` |
| scoring-service | TenkaCloud-Scoring | `SCORE#{teamId}` / `PROBLEM#{id}` |
| leaderboard-service | TenkaCloud-Leaderboard | `LEADERBOARD#{eventId}` / `RANK#{position}` |

**サービス間のデータ参照はイベント駆動または API 呼び出しで行う。DB を直接参照しない。**

### 3. 独立デプロイ

各サービスは以下を自己完結で持つ。

```
microservices/problem-service/
├── src/                    ← ビジネスロジック
│   ├── routes/
│   ├── services/
│   ├── repositories/       ← このサービス専用の DynamoDB アクセス
│   └── index.ts
├── __tests__/
├── cdk/                    ← このサービスの CDK スタック（テーブル + IAM）
├── Dockerfile
├── package.json
└── tsconfig.json
```

デプロイは `cdk deploy ProblemServiceStack` のようにサービス単位で行える。他のサービスに影響しない。

### 4. サービス間通信

```
tenant-management
  → EventBridge: tenant.created
        ↓
problem-service, gameday-service (イベント受信)

gameday-service
  → HTTP: GET /api/problems/{id} → problem-service
  → EventBridge: problem.deploy.requested → ProblemDeployPlane
```

DB を共有しないため、サービス間の結合はイベントと API のみ。

### 5. Makefile を必要最小限に絞る

```makefile
# === 開発 ===
make start              # ローカル全起動
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

### 6. 捨てるものと持っていくもの

**捨てるもの（構造）:**

| 対象 | 理由 |
|---|---|
| ディレクトリ構成全体 | 一貫性がなく修正するより作り直す方が早い |
| DynamoDB シングルテーブル設計 | サービスごとにテーブルを分離する |
| Makefile | 36 ターゲットの積み上げを整理するより書き直す方が早い |
| Terraform | CDK + SBT に置き換え |
| provisioning Lambda | SBT ApplicationPlane が担う |
| docker-compose 群 | 構造変更後に合わせて書き直し |
| 3 箇所の shared | `server/application/libs/` に集約して作り直し |
| CI ワークフロー | パスが全部変わるので書き直し |
| `reference/`, `tmp/`, `docs-site/` | 不要 |

**持っていくもの（ロジック）:**

| 対象 | 理由 |
|---|---|
| Hono サービスのハンドラ・ルーティング | ビジネスロジックは動いている |
| React コンポーネント (Cloudscape) | UI は動いている |
| テストコード | 1000+ テスト、99％+ カバレッジ |
| ADR (011, 012) | 設計判断はそのまま有効 |
| PK/SK パターンの設計知見 | テーブルは分離するがパターン自体は流用可能 |

### 7. 移行手順

```
1. 新しいブランチ (v2) を空の正しい構造で作る
   client/ + server/ + scripts/ + docs/ + problems/

2. server/application/libs/ を先に移植（auth, events, types）

3. サービスを 1 つずつ移植
   - DB を分離（専用テーブル定義 + リポジトリ層の書き換え）
   - テストを一緒に移植
   - 移植するたびに make before-commit を通す

4. client/ を移植（AdminWeb, Application）

5. server/lib/ に SBT スタックを構築（インフラ担当）

6. Makefile, docker-compose, CI を新構造で書き直す

7. 旧ディレクトリを削除
```

## Consequences

- **Good**: AWS SaaS Reference Architecture と同じ粒度になり、構造が自明になる。サービスが DB ごと独立するため、個別にデプロイ・スケール・修正できる。サービス間の結合がイベントと API に限定されるため、変更の影響範囲が明確になる。
- **Good**: PoC で検証済みのビジネスロジックとテストを移植するため、「何を作るか」の不確実性がない。
- **Bad**: 全コードの移植作業が発生する。テーブル分離に伴いリポジトリ層の書き換えが必要。サービス間の結合データ（例: gameday-service が problem のデータを参照するケース）を API / イベントに置き換える設計作業が追加で必要。
- **Tradeoff**: Git の履歴は実質リセットになる。PoC の Git blame は失われるが、ADR と移植元のコミットで追跡可能。

## References

- [AWS SaaS Reference Architecture (ECS)](https://github.com/aws-samples/saas-reference-architecture-ecs)
- [ADR-011: SBT Control Plane と二層 Application Plane 構成](./011-sbt-control-plane-and-two-layer-application-plane.md)
- [@cdklabs/sbt-aws](https://github.com/awslabs/sbt-aws)
