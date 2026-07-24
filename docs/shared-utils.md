# Shared helper catalog

Duplication starts the moment someone (human or AI agent) writes a helper that
already exists — nobody's memory covers the whole codebase, so the only reliable
prevention is a catalog you check **before** writing. This file is that catalog.

Operational rule (the prevention half of the duplication defense; the detection
half is the CI jscpd ratchet, `make dup-check`, and the dead-code report,
`make dead-code`):

1. **Before writing a new helper / util / validator**, scan this catalog and
   `git grep` for an existing implementation. Reuse or extract instead of
   re-implementing.
2. **When you add a shared helper**, add one line here in the same PR. A helper
   that is not listed here is a helper the next contributor will re-implement.
3. AI agents read this file via AGENTS.md — keeping it current is what makes the
   rule bind for them too.

## Workspace packages (`packages/*`)

Import these with `workspace:*` from any app or from `infrastructure`.

| Package | What it provides |
| ------- | ---------------- |
| `@tenkacloud/auth-client` | Cognito Hosted UI OAuth 2.0 Code + PKCE client shared by the admin SPAs |
| `@tenkacloud/coordination-plugin-sdk` | ADR-028 inter-team coordination plugin contract (state machine + 5 hooks) |
| `@tenkacloud/format` | Pure formatters for SPAs — `formatRelativeTime` (ja/en) |
| `@tenkacloud/portal-contracts` | Participant portal API wire contract — one definition for backend handler + SPA |
| `@tenkacloud/portal-plugin-sdk` | Type definitions for participant-portal problem plugins (ADR-012 Phase 5) |
| `@tenkacloud/problem-cost` | Offline heuristic AWS cost estimation for a problem's CFn template |
| `@tenkacloud/problem-runtime` | Problem runtime classification (normalize / executable / reserved, ADR-023/026/027) |
| `@tenkacloud/problem-sdk` | Public problem-pack authoring contract: stable types, validators, diagnostic codes |
| `@tenkacloud/problem-test` (`packages/problem-test-harness`) | Offline problem test harness — contract validation + scoring/probe runs with injected fakes |
| `@tenkacloud/saml-utils` | SAML metadata validation + attribute mapper for Control/Application Plane SSO |
| `@TenkaCloud/trust-bridge` | Cross-cloud authority transfer (signed CloudActionIntent → short-lived credentials, ADR-017) |
| `@tenkacloud/web-kit` | Shared SPA UI primitives — `createCoreApiClient`, `AuthProvider`/`useAuth`, `EmptyState`, boot error rendering |

## Script-side pure-logic modules (`scripts/lib/`)

Reused by operator CLIs and deploy scripts; import directly by relative path.

| Module | What it provides |
| ------ | ---------------- |
| `capacity-model.ts` | DynamoDB 1/1-capacity throughput model (teams-before-throttle, #1667) |
| `disruption-live-fire.ts` | Disruption live-fire pure logic (fire → probe → auto-revert, #1419/#1666) |
| `iam-description-ascii.ts` | IAM Description ASCII/Latin-1 gate logic (#664) |
| `landing/onboarding-videos/render.ts` | Onboarding video renderer helpers: HTML escaping, binary resolution, checked command execution, and guarded temporary-workspace cleanup |
| `retained-tables.ts` | Post-destroy RETAIN-table enumeration for billing warnings (#2444) |
| `scale-event-capacity.ts` | Event-window capacity scaling logic |

## Infrastructure shared modules (`infrastructure/lib/problem-deploy/handlers/shared/`)

| Module | What it provides |
| ------ | ---------------- |
| `runtime/adapter.ts` | `mergeCompositeParameters` / `optionalParametersField` — the Composite-bound-parameter merge idioms shared by every `ProblemRuntimeAdapter` (`aws-cfn-adapter.ts`, `azure-bicep-adapter.ts`, `gcp-infra-manager-adapter.ts`, `sakura-apprun-adapter.ts`) and `prepared-dispatch.ts` (#2747) |

## Where a new helper belongs

- Shared across ≥2 SPAs (or SPA + Lambda): a `packages/*` workspace — extend the
  closest existing package before creating a new one.
- Shared across operator scripts: `scripts/lib/` as a pure-logic module with its
  own test.
- Used once, in one place: keep it local to that module. Do not force-extract —
  "happens to look similar" is not "same responsibility"; the jscpd baseline
  deliberately tolerates intentional responsibility-split similarity.
