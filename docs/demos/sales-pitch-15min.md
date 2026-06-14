# 15-minute sales / facilitator pitch

> 日本語版: [sales-pitch-15min.ja.md](./sales-pitch-15min.ja.md)

This is the 15-minute version of the quickstart, intended for facilitators running a sales walkthrough or a community organizer pitch. Same flow as [`quickstart-5min.md`](./quickstart-5min.md), but with **pain → fit talking points** and **pricing tier references** at each step.

## Opening (≈ 1 min)

**Pain.** Cloud training inside enterprises today usually falls into one of two failure modes.

- **Slide-only training**: developers sit through a deck, never touch a console, and forget everything within a week.
- **Free-form sandbox**: developers get an AWS account, no scope, no scoring, no progress visibility — and the platform team owns blast-RADIUS incidents forever.

**Fit.** TenkaCloud sits in between. Organizers deploy curated problems into isolated environments. Participants solve them in real AWS. Scoring and progress are wired in. Blast RADIUS is bounded by the problem template plus a read-only `ParticipantViewerRole`.

**Positioning line.**

> TenkaCloud is an open-source cloud-competition platform on real AWS. Organizers deploy hands-on problems into isolated environments, participants solve them in the cloud, and problem packs can be reused and contributed like OSS.

## Step 1 — Clone and install (≈ 1 min)

**Action.** Same as quickstart Step 1.

**Talking point.** "The platform itself is Apache 2.0. We do not gate features behind a commercial fork. Customer-specific extensions go into private problem repositories, not into the platform — that boundary is enforced by `ADR-008` and the submodule layout."

**Pricing hint.** Self-host is free. Managed-tier pricing lives at the SaaS layer, not the OSS platform.

## Step 2 — Deploy Lite mode (≈ 2 min)

**Action.** Same as quickstart Step 2. While `make deploy` runs, walk through the cost story.

**Talking point.** "DynamoDB tables are forced to 1 RCU / 1 WCU by a CDK Aspect. CloudFront, S3, and Lambda all fit inside the Free Tier for a small event. We have customers running a 30-person event for the cost of a coffee."

**Pricing hint.** Starter / Hosted Event run on the shared pooled `application-admin-console` (cheaper). Annual Arena buyers who need per-tenant isolation (compliance, data residency) get a dedicated silo stack.

## Step 3 — Create the event (≈ 1 min)

**Action.** Same as quickstart Step 3.

**Talking point.** "Events are pure metadata. You can run a dress rehearsal on a single team before opening it to 200 people. The platform does not change behavior based on event size — same Lambdas, same DDB, same EventBridge."

**Pricing hint.** Per-event branding (logo, custom welcome copy) is included from Hosted Event tier upward. Lite mode (free) ships the open-source default.

## Step 4 — Add the `hello-world` problem (≈ 2 min)

**Action.** Same as quickstart Step 4. Open `problems/challenges/hello-world/` in a second tab and show the three files.

**Talking point.** "This is a problem. Three files: `metadata.json` (catalog + scoring config), `template.yaml` (one-page CFn), and an optional `portal/` plugin. Anyone — including your enterprise's own SRE team — can author one without forking the platform. That is `ADR-012`, the problem-plugin architecture."

**Pricing hint.** The community-contributed catalog is free. The enterprise problem pack (security operations / multi-region failover / data-mesh drills) is curated and licensed separately. See [`problems/CATALOG.md`](../../problems/CATALOG.md).

## Step 5 — Bulk-deploy to teams (≈ 3 min)

**Action.** Same as quickstart Step 5. While the deploy runs, walk through `template.yaml` on screen.

**Talking point.** "The problem is deployed via CloudFormation `CreateStack` into a **separate AWS account** owned by the team. We AssumeRole using an `ExternalId` that is unique per tenant — `CLAUDE.md` calls this out as non-negotiable. The platform team does not own the team's runtime; the team's account does."

**Pricing hint.** Cross-account `AssumeRole` is included at every tier. The one-time competitor-side bootstrap is `infrastructure/templates/competitor-bootstrap.yaml`, a single CFn that creates the role with `ExternalId`.

## Step 6 — Solve and score (≈ 3 min)

**Action.** Same as quickstart Step 6. After the score increments, switch back to the admin console scoreboard.

**Talking point.** "Scoring is one of six built-in kinds — `flag`, `multi-flag`, `uptime-flat`, `uptime-multi`, `phased-polling`, `attack-detection`. Each problem picks one. The platform has a single generic scoring Lambda that dispatches to the right kind — no problem-specific code in the platform. That keeps the operational surface small."

**Pricing hint.** Real-time scoreboard refresh, multi-team dashboards, and disruption-phase visibility ship at Hosted Event tier and above. Starter has the same scoring path with simpler dashboards.

## Closing (≈ 2 min)

Cover three points:

1. **Reality check.** What we ship today: cross-account isolated deploy, six scoring kinds, EventBridge state reconciliation (`ADR-014`), polling-based UI (no SSE — see `AGENTS.md`). What we are working toward: voting-based community catalog (`ADR-024`), provider-specific runtimes for non-AWS (`ADR-023`). We do not claim "production-grade multi-cloud" or "full SOC2" today.
2. **Operating model.** Lite mode = `make deploy`, 1 organizer / 1 event, 10-minute setup. SaaS mode = `make deploy-saas`, multi-tenant, pooled + silo tier mix, 15 to 20 minutes to bring up the control plane.
3. **CTA.** Pick a starter problem (`hello-world`, `s3-public-bucket`, `lambda-cold-start`). Run one dry-run with your own SRE team. The longest commitment is one `make deploy` run.

## Pain → fit mapping summary

| Pain                                        | TenkaCloud fit                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| "Our training is slides; nothing sticks."   | Hands-on real-AWS problems with deterministic scoring path.                          |
| "Sandbox accounts blow up our blast RADIUS."| Per-team isolated account + `ExternalId` AssumeRole + scoped `ParticipantViewerRole`. |
| "Each event needs custom scoring."          | Six scoring kinds (`flag` / `multi-flag` / `uptime-flat` / `uptime-multi` / `phased-polling` / `attack-detection`). |
| "We need event-day operations to be calm."  | EventBridge-driven reconciliation (ADR-014), polling-based UI, idempotent teardown.  |
| "We want our SRE team to author problems."  | Three files per problem. `ADR-012` problem-plugin architecture. No platform fork.    |
| "We may want to leave AWS in the future."   | `ADR-023` provider-specific runtime roadmap. Today: AWS only; honest about scope.    |

## Pricing tier reference

These are the published commercial tiers on the landing page. Numbers below match `landing/index.html` (`#pricing`).

| Tier         | Price             | Scope                       | Use case                                                            |
| ------------ | ----------------- | --------------------------- | ------------------------------------------------------------------- |
| Starter      | 500,000 JPY / run | Up to 2 teams               | Trial run, prove the workflow with one small group.                 |
| Hosted Event | 1,500,000 JPY / run | Up to 5 teams (≈ 20 people) | One-off event with full ops support (deploy / on-call / Red Team).  |
| Annual Arena | 6,000,000 JPY / year | Multiple events            | Repeatable in-house training program with branded portal / catalog. |

Under the hood, SaaS mode (`make deploy-saas`) further splits tenants into pooled vs silo Application Planes (BASIC / STANDARD / PREMIUM share one pooled stack; PLATINUM gets a dedicated silo stack). Buyers do not need to pick that — it is selected for them based on the chosen commercial tier.

Lite mode (`make deploy`) does not use tiers at all — it is the OSS self-host path, free, one-organizer / one-event.

## Where to go next

- [`docs/demos/architecture-tour-30min.md`](./architecture-tour-30min.md) — the technical deep-dive for CCoE / platform-team evaluators
- [`problems/README.md`](../../problems/README.md) — write your own problem
- [`docs/architecture/OVERVIEW.md`](../architecture/OVERVIEW.md) — 10-minute architecture overview
- [`ROADMAP.md`](../../ROADMAP.md) — what is shipped vs in flight (sales-team honesty card)
