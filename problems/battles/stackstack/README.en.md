# StackStack — AI to Production Last Mile

> 日本語版: [README.md](./README.md)

A Battle that gamifies the **AI → Production last mile** in an era where anyone can generate apps with AI. It is neither a coding race nor a CTF; it is a contest of Platform Team operational quality — shipping fast AND safely AND under governance.

| Field          | Value                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------- |
| Category       | Battle (real-time PvP)                                                                             |
| Difficulty     | 4 / 5                                                                                              |
| Estimated time | 90–120 min                                                                                         |
| status         | `draft`                                                                                            |
| Scoring        | `phased-polling` (EC2 = 100pt / managed = 1,000pt / all-slot managed bonus = +5,000pt one-time)    |

## What you do

Players act as the Platform Team for a company with 100 internal AI Builders pushing out fragile apps. Each app must be hardened across 5 control axes (Security / Network / Rate / Audit / UX availability). Score is composite, not just speed: it depends on the balance across all 5 axes plus the team's response to random organizational events (CEO demanding a 5000-person demo, Legal finding PII, .env leaks, Claude committing secrets).

## 5 control axes (= 5 endpoint slots)

| slot      | axis                                | initial state                       | hardened state                                  |
| --------- | ----------------------------------- | ----------------------------------- | ----------------------------------------------- |
| `auth`    | Authentication / Authorization      | naive Basic auth on EC2 (`ec2`)     | Cognito / SSO via managed runtime               |
| `network` | Network controls (S3 / WAF / IAM)   | Public S3 + wildcard IAM (`ec2`)    | OAC + scoped IAM via managed runtime            |
| `rate`    | Rate limit / DoS protection         | unthrottled Flask (`ec2`)           | API GW throttle / Lambda concurrency cap        |
| `audit`   | Logging / Compliance                | stdout only (`ec2`)                 | CloudTrail + Athena + WORM bucket               |
| `ux`      | User-facing availability            | single EC2 (`ec2`)                  | Multi-AZ + ALB + Auto Scaling                   |

Each slot self-reports its hosting platform via `/meta`. The initial deploy puts all five on EC2 (low score: 100 pt/cycle/slot). Hardening = re-hosting to Lambda + API GW / ECS Fargate / App Runner — which inherently brings managed security defaults — and registering the new URL via the portal override. Once `/meta` returns `"lambda" | "ecs" | "apprunner"`, the slot's payout jumps to 1,000 pt/cycle.

## Time-based phases

| Time   | phase              | What happens                                                                                                |
| ------ | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| 0 min  | start              | All slots naive on EC2 (≈ 500 pt/min baseline)                                                              |
| 30 min | production-ramp    | `ux` slot degrades to `degradedPoints` (10 pt) if still on EC2 (CEO 5000-user demo pressure)                |
| 60 min | compliance-audit   | `audit` slot degrades to `degradedPoints` if still on EC2 (Legal review pressure)                           |
| 90 min | incident-response  | All slots switch to `/score?legacy=true`, requiring redeploy without the legacy path the AI Builder injected |

## Random org events (disruptions)

Operator-fired catalog:

| id                    | name                              | Effect                                                  |
| --------------------- | --------------------------------- | ------------------------------------------------------- |
| `ceo-5000-users`      | CEO demands a 5000-user demo      | -500 pt/cycle while `ux` slot stays on EC2              |
| `mfa-mandate`         | Security Team mandates MFA        | `auth` on `ec2` for >10 min → disqualified              |
| `legal-pii-found`     | Legal finds PII                   | -500 pt/cycle while `audit` slot is on EC2              |
| `env-credential-leak` | `.env` leaks                      | `auth` slot returns 503 for 5 minutes (failurePenalty)  |
| `ai-committed-secret` | Claude commits a secret           | `network` + `audit` both return 503 for 3 minutes       |

## All-managed bonus

If every one of the 5 slots is hosted on `lambda` / `ecs` / `apprunner`, **+5,000 pt one-time bonus** ("production-ready" certification). One slot left on EC2 disqualifies the bonus.

## Scope: Phase 1 vs Phase 2

### Phase 1 (= this problem today)

- ✅ Individual-team hardening mechanics via the existing `phased-polling` engine.
- ✅ Disruption catalog declared via `disruptions[]` (operator-fired).
- ✅ 5-axis subscore display via `dashboard.slots/StatusPanel.tsx`.

### Phase 2 (= requires platform extension; separate ADR / PR)

- **Inter-team coordination plugin** (ADR-022): inter-team primitives vary by problem (microservice-migration's service router / security-battle-royale's alliances / etc.). Rather than hardcoding one mechanism into the platform, ADR-022 defines a plugin contract where problems declare the primitive and the platform dispatches. StackStack's specific inter-team primitive will be declared after ADR-022 lands.
- **AI Agent / platform usage status**: player-triggered platform actions from the portal. Requires an extension to the portal plugin SDK.

### Explicitly rejected

- **Tenant-spanning shared resource registry** (SSO Proxy 2 slots first-come / Security Review queue / Claude API quota): the security design exceeds the current platform's maturity, so it is removed from the Phase 2 plan. Replaced by an inter-team primitive that stays inside tenant boundaries via ADR-022.

Phase 1 alone is enough to experience the StackStack core (5 axes + random events + phased timeline).

## Learning goals

- Practice the judgment and ordering required to take an AI-generated app to production across 5 control axes.
- Understand how migrating to managed runtimes (Lambda / ECS / App Runner) auto-bootstraps hardening defaults.
- Train Platform Team decision-making under random organizational events (CEO demand / Legal audit / .env leak).
- Articulate the boundary between Phase 2 (inter-team coordination plugin = ADR-022) and Phase 1 (individual-team hardening) as an ADR.

## Related files

- [`metadata.json`](./metadata.json) — problem metadata (source of truth for slots / scoring / phases / disruptions)
- [`template.yaml`](./template.yaml) — one-page CFn template
- [`portal/StatusPanel.tsx`](./portal/StatusPanel.tsx) — dashboard plugin that surfaces the 5-axis subscore + phase + disruption state
