# Microservice Migration Battle

> 日本語版: [README.md](./README.md)
>
> **Status: Phase 1 (draft)** — Phase 1 only ships the monolith problem files (3 services co-tenant on a single EC2). The score engine / registration UI / EC2 degradation cron / phase progression are added in Phase 2 / Phase 3 (= follow-ups to issue #572).

A Battle problem in which a monolith of three services (`users` / `orders` / `catalog`) co-tenant on a single EC2 must be split out, during a 90–120 minute event, into three different hosting environments: **Lambda + API Gateway**, **Amazon ECS (Fargate)**, and **AWS App Runner**.

## Overview

- Category: Battle (real-time PvP)
- Difficulty: 4 / 5
- Estimated time: 90 – 120 min
- Learning goals:
  - Experience an incremental monolith → microservices migration (strangler fig pattern).
  - Compare the spectrum of Lambda function / managed container / orchestrated container on real infrastructure.
  - Decide which service to extract first under a score-degradation constraint.
  - Read the code and remove an intentionally-injected slow code path (`?legacy=true`).

## Architecture

### Initial state (right after deploy / what Phase 1 ships)

```text
┌─────────────── EC2 (t3.small, Amazon Linux 2023) ───────────────┐
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                       │
│  │  users   │  │  orders  │  │ catalog  │  ← co-tenant via       │
│  │  :3001   │  │  :3002   │  │  :3003   │     docker compose     │
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
                       │ Score Engine polls every 1 minute
                       │ (implemented in Phase 2)
                       │ /users/score, /orders/score, /catalog/score
```

### Target end-state (= what a fully-split competitor produces)

```text
                ┌────────── Lambda + API Gateway ───────────┐
                │  /users   → handler (Hono on Lambda)        │
                └─────────────────────────────────────────────┘

                ┌────────── ECS Fargate Service ─────────────┐
                │  /orders  → ALB → Fargate Task (container)  │
                └─────────────────────────────────────────────┘

                ┌────────── AWS App Runner ──────────────────┐
                │  /catalog → App Runner Service (container)  │
                └─────────────────────────────────────────────┘
```

> Which service goes to which hosting target is up to the competitor. With 3! = 6 combinations, the assignment becomes each team's strategic call.

## Service spec

All three services are isomorphic (Hono on Node.js 20; only port and service name differ).

| service   | port | self-reported platform (`/meta`) | handlers                       |
| --------- | ---- | -------------------------------- | ------------------------------ |
| `users`   | 3001 | `ec2`                            | `/meta`, `/score`, `/healthz`  |
| `orders`  | 3002 | `ec2`                            | same as above                  |
| `catalog` | 3003 | `ec2`                            | same as above                  |

### Endpoints

Common HTTP routes:

- `GET /meta` → `{ "service": "<name>", "platform": "ec2" | "lambda" | "ecs" | "apprunner", "version": "1.0.0" }`
- `GET /score` → `{ "score": <int> }` (fast path, ~5ms)
- `GET /score?legacy=true` → same shape, but with an intentional **2-second sleep** (= late-game gimmick; in Phase 2 the score engine switches to this)
- `GET /healthz` → `{ "ok": true, "service": "<name>" }`

### Local development

```bash
cd problems/battles/microservice-migration-battle/services
docker compose up --build
curl http://localhost/users/score
curl http://localhost/orders/score
curl http://localhost/catalog/score
```

## Scoring rules (spec for the Phase 2 score engine)

| State                                          | Per check | Per hour |
| ---------------------------------------------- | --------- | -------- |
| Unregistered / non-200 / timeout               | -100      | -6,000   |
| EC2 response (pre-degradation)                 | +100      | +6,000   |
| EC2 response (post-degradation)                | +10       | +600     |
| Hosted on Lambda + API GW                      | +1,000    | +60,000  |
| Hosted on ECS Fargate                          | +1,000    | +60,000  |
| Hosted on App Runner                           | +1,000    | +60,000  |
| All 3 services fully separated                 | +5,000 (one-time bundle bonus) |        |
| Slow-endpoint response (>1.5s)                 | +10       | +600     |

Hosting is identified by the `platform` field returned from `GET /meta` as self-reporting (a Phase 1 design choice).

## Phase timeline

| Time       | Phase              | What happens                                                                                |
| ---------- | ------------------ | -------------------------------------------------------------------------------------------- |
| 0 min      | start              | EC2 deploy complete / 3 services up / `BaseUrl` issued                                       |
| 60 min     | EC2 degradation    | `tc qdisc` injects latency (Phase 2) → EC2 award drops from +100 to +10                      |
| 90 min     | legacy switch      | Score Engine switches `/score` → `/score?legacy=true` → the slow path becomes visible        |
| 90–120 min | rewrite + redeploy | Read the code, remove the `legacy` branch, redeploy to each hosting target                   |

## Hints: minimum deploy for each hosting target

> In every case you can reuse this repo's `services/<name>/Dockerfile` as-is.

### Lambda + API Gateway

1. Wrap Hono with the `hono/aws-lambda` adapter (export the handler).
2. Bundle with `npm install -g esbuild`, or run a container image with `npx tsx`.
3. `aws lambda create-function --package-type Image --code ImageUri=<ECR URI>` to create the function.
4. In API Gateway HTTP API, point the integration target to the Lambda function.
5. Set the env var `PLATFORM=lambda`.

### ECS Fargate

1. `docker build -t <ECR URI>:latest services/orders` → ECR push.
2. Task Definition (CPU 256 / Memory 512, container port 3002, `PLATFORM=ecs`).
3. ECS Cluster + Service (1 task), register against the ALB Target Group (port 3002).
4. Forward `/orders/*` to the Target Group via an ALB Listener Rule.

### App Runner

1. `docker build -t <ECR URI>:latest services/catalog` → ECR push.
2. Create an App Runner Service (Source = ECR, port 3003, `PLATFORM=apprunner`).
3. Register the issued App Runner URL directly as the endpoint.

> Minimum IaC examples per target will land under `services/iac-examples/` in Phase 2.

## Retrospective (= why all three hosting flavors at once)

| Axis             | Lambda + API GW          | ECS Fargate                       | App Runner                          |
| ---------------- | ------------------------ | --------------------------------- | ----------------------------------- |
| Unit             | function (event-driven)  | container + cluster management    | container (managed)                 |
| Scale            | per-request, cold start  | per-task (Auto Scaling Group)     | per-request, auto                   |
| Setup overhead   | light (one HTTP API)     | heavy (VPC / ALB / Service / TaskDef) | medium (one URL, no VPC)        |
| Main takeaway    | event-driven, async      | orchestration, persistence, network | managed container, source deploy   |

The intent is to let competitors experience the spectrum Lambda (function) ↔ App Runner (managed container) ↔ ECS (orchestrated container) in a single competition.

## Not shipped in Phase 1 (= follow-up PRs)

- The score engine (1-minute polling Lambda + EventBridge Scheduler).
- DDB table for the registration endpoint.
- Phase progression (`degradationMinutes` / `legacySwitchMinutes`).
- EC2 degradation cron (`tc qdisc`).
- The 3-slot endpoint registration UI in `participant-portal`.
- The phase-timeline card in the Battle Portal.

These will be implemented in Phase 2 / Phase 3 follow-up issues.

## Known limitations

- The slow code path (2-second sleep on `?legacy=true`) is publicly visible in this repo. Until ADR-008 (= moving problem implementations to a private repo, issue #574) ships, the gimmick can be read in advance.
