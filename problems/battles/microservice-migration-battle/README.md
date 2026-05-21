# Microservice Migration Battle

> English version: [README.en.md](./README.en.md)
>
> **Status: Phase 1 (draft)** — Phase 1 では EC2 上のモノリス問題ファイル一式のみを出荷する。スコアエンジン / 登録 UI / EC2 劣化 cron / フェーズ進行ロジックは Phase 2 / Phase 3 で追加される (= issue #572 のフォローアップ)。

EC2 1 台に同居する 3 サービス (`users` / `orders` / `catalog`) のモノリスを、競技時間 90〜120 分の間に **Lambda + API Gateway / Amazon ECS (Fargate) / AWS App Runner** の 3 種類の異なるホスティングへマイクロサービスとして分割していく Battle 問題。

## 競技概要

- カテゴリ: Battle (リアルタイム対戦)
- 難易度: 4 / 5
- 想定時間: 90 〜 120 分
- 学習目的:
  - モノリス → マイクロサービスへの段階的移行 (strangler fig パターン) を体験する
  - Lambda function / managed container / orchestrated container のスペクトラムを実機で比較する
  - スコア劣化制約下で「どのサービスから分離すべきか」の優先順位を判断する
  - コード内に意図的に仕込まれた遅延コードパス (`?legacy=true`) を読み解いて除去する

## アーキテクチャ

### 初期状態 (deploy 直後 / Phase 1 で実装する範囲)

```text
┌─────────────── EC2 (t3.small, Amazon Linux 2023) ───────────────┐
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                       │
│  │  users   │  │  orders  │  │ catalog  │  ← docker compose      │
│  │  :3001   │  │  :3002   │  │  :3003   │     で同居             │
│  └──────────┘  └──────────┘  └──────────┘                       │
│         ▲             ▲             ▲                            │
│         └─────────────┴─────────────┘                            │
│                       │                                          │
│  ┌────────────────────────────────────────────┐                  │
│  │  nginx :80  →  /users/*   /orders/*        │                  │
│  │             →  /catalog/*                  │                  │
│  └────────────────────────────────────────────┘                  │
└──────────────────────────────────────────────────────────────────┘
                       ▲
                       │ Score Engine が 1 分毎 polling
                       │ (Phase 2 で実装)
                       │ /users/score, /orders/score, /catalog/score
```

### 想定終形 (= 競技者がフル分割した姿)

```text
                ┌────────── Lambda + API Gateway ───────────┐
                │  /users   → handler (Hono on Lambda)        │
                └─────────────────────────────────────────────┘

                ┌────────── ECS Fargate Service ─────────────┐
                │  /orders  → ALB → Fargate Task (Container)  │
                └─────────────────────────────────────────────┘

                ┌────────── AWS App Runner ──────────────────┐
                │  /catalog → App Runner Service (Container)  │
                └─────────────────────────────────────────────┘
```

> どのサービスをどのホスティングに割り当てるかは競技者の自由。3! = 6 通りの組み合わせがあり、各チームの戦略になる。

## 各サービスの仕様

3 サービスは同型 (= Hono on Node.js 20、ports と service 名だけ違う)。

| service   | port | platform 自己申告 (`/meta`) | ハンドラ           |
| --------- | ---- | --------------------------- | ------------------ |
| `users`   | 3001 | `ec2`                       | `/meta`, `/score`, `/healthz` |
| `orders`  | 3002 | `ec2`                       | 同上               |
| `catalog` | 3003 | `ec2`                       | 同上               |

### エンドポイント

各サービス共通の HTTP routes。

- `GET /meta` → `{ "service": "<name>", "platform": "ec2" | "lambda" | "ecs" | "apprunner", "version": "1.0.0" }`
- `GET /score` → `{ "score": <int> }` (fast path、~5ms)
- `GET /score?legacy=true` → 同じ shape を返すが **2 秒の意図的遅延** が入る (= 競技終盤ギミック、Phase 2 で score engine が切替対象にする)
- `GET /healthz` → `{ "ok": true, "service": "<name>" }`

### ローカル開発

```bash
cd problems/battles/microservice-migration-battle/services
docker compose up --build
curl http://localhost/users/score
curl http://localhost/orders/score
curl http://localhost/catalog/score
```

## 採点ルール (Phase 2 で実装する score engine の仕様)

| 状態                                       | 1 check あたり | 1 時間換算 |
| ------------------------------------------ | -------------- | ---------- |
| 未登録 / 200 以外 / timeout                | -100           | -6,000     |
| EC2 上のレスポンス (劣化前)                | +100           | +6,000     |
| EC2 上のレスポンス (劣化後)                | +10            | +600       |
| Lambda + API GW にホスティング済           | +1,000         | +60,000    |
| ECS Fargate にホスティング済               | +1,000         | +60,000    |
| App Runner にホスティング済                | +1,000         | +60,000    |
| 3 サービス全て分離完了                     | +5,000 (一括ボーナス、1 回限り) |          |
| 遅延 endpoint (応答 > 1.5 秒) を返した     | +10            | +600       |

ホスティング判定は `GET /meta` の `platform` フィールドを自己申告として読む (Phase 1 設計判断)。

## フェーズタイムライン

| 時刻       | フェーズ           | 内容                                                                  |
| ---------- | ------------------ | --------------------------------------------------------------------- |
| 0 分       | 開始               | EC2 deploy 完了 / 3 サービス起動 / `BaseUrl` 払い出し                 |
| 60 分後    | EC2 劣化           | `tc qdisc` で latency 注入 (Phase 2 実装) → EC2 加点が +100 → +10 に減 |
| 90 分後    | legacy switch      | Score Engine が `/score` → `/score?legacy=true` に切替 → 遅延発覚      |
| 90〜120 分 | 仕込み除去 + 再 deploy | コードを読んで `legacy` 分岐を消し、各ホスティングに再 push          |

## ヒント: 各ホスティングへの最小デプロイ

> いずれも本リポジトリの `services/<name>/Dockerfile` をそのまま使える。

### Lambda + API Gateway

1. Hono を `hono/aws-lambda` adapter で wrap (handler を export)
2. `npm install -g esbuild` で bundle、または container image で `npx tsx` 起動
3. `aws lambda create-function --package-type Image --code ImageUri=<ECR URI>` で関数化
4. API Gateway HTTP API → integration target に Lambda function を指定
5. 環境変数 `PLATFORM=lambda` を設定

### ECS Fargate

1. `docker build -t <ECR URI>:latest services/orders` → ECR push
2. Task Definition (CPU 256 / Memory 512、container port 3002、`PLATFORM=ecs`)
3. ECS Cluster + Service (1 task)、ALB Target Group (port 3002) に登録
4. ALB の Listener Rule で `/orders/*` を Target Group に転送

### App Runner

1. `docker build -t <ECR URI>:latest services/catalog` → ECR push
2. App Runner Service 作成 (Source = ECR、port 3003、`PLATFORM=apprunner`)
3. 払い出された App Runner URL をそのまま endpoint として登録

> 各 IaC 最小例は Phase 2 で `services/iac-examples/` 配下に追加予定。

## 競技後の振り返り (= なぜこの 3 種を並行体験するのか)

| 観点         | Lambda + API GW         | ECS Fargate                       | App Runner                          |
| ------------ | ----------------------- | --------------------------------- | ----------------------------------- |
| 単位         | 関数 (event-driven)     | コンテナ + クラスタ管理           | コンテナ (managed)                  |
| スケール     | per-request, cold start | per-task (Auto Scaling Group)     | per-request, auto                   |
| 設定の重さ   | 軽 (HTTP API 1 発)      | 重 (VPC / ALB / Service / TaskDef) | 中 (URL 1 発、VPC 不要)             |
| 主な学び     | event-driven, 非同期    | orchestration, 永続化, network    | managed container, source deploy    |

Lambda (関数) ↔ App Runner (managed container) ↔ ECS (orchestrated container) の 3 段階のスペクトラムを 1 競技で体験できるよう設計してある。

## Phase 1 で出荷しないもの (= 後続 PR)

- スコアエンジン (1 分間隔 polling Lambda + EventBridge Scheduler)
- 登録エンドポイントの DDB テーブル
- フェーズ進行管理 (degradationMinutes / legacySwitchMinutes)
- EC2 劣化 cron (`tc qdisc`)
- participant-portal の endpoint 登録 UI (3 slot)
- Battle Portal のフェーズタイムライン card

これらは Phase 2 / Phase 3 の follow-up issue で実装する。

## 既知の制限

- 遅延コードパス (`?legacy=true` で 2 秒 sleep) は本リポジトリ内で公開されているため、ADR-008 (= 問題実装の private repo 化、issue #574) が ship するまで仕掛けは事前に読まれる可能性がある。
