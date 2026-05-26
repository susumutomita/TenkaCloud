# Problem design retrospectives — five reference problems

> Audience: new problem authors who want to learn from existing problems before writing their own.
> Read alongside [`CONTRIBUTING.md`](./CONTRIBUTING.md) (= how to ship) and [`AUTHORING.html`](./AUTHORING.html) (= 30-minute onboarding).

This file is a design post-mortem of the five reference problems currently in the catalog. The goal is to make the *why* explicit — the constraints that shaped each problem and the trade-offs the author accepted. Reading these saves you from rediscovering the same lessons.

| # | Problem                                                                                       | Category  | Kind             | Difficulty | Cost target          |
| - | --------------------------------------------------------------------------------------------- | --------- | ---------------- | ---------- | -------------------- |
| 1 | [`hello-world`](#1-hello-world-flag)                                                          | Challenge | flag             | 1          | Zero (SSM Standard)  |
| 2 | [`hello-world-battle`](#2-hello-world-battle-uptime-flat)                                     | Battle    | uptime-flat      | 1          | Free Tier (t3.micro) |
| 3 | [`security-battle-royale`](#3-security-battle-royale-uptime-multi)                            | Battle    | uptime-multi     | 4          | < $0.10 / 90 min     |
| 4 | [`microservice-migration-battle`](#4-microservice-migration-battle-phased-polling)            | Battle    | phased-polling   | 4          | < $0.50 / 120 min    |
| 5 | [`stackstack`](#5-stackstack-phased-polling--disruptions)                                     | Battle    | phased-polling   | 4          | < $0.50 / 120 min    |

The problems are listed by increasing complexity. If you are writing your first problem, study `hello-world` and `hello-world-battle` first.

## 1. `hello-world` (flag)

**One-line design intent.** Smoke-test the entire deploy → flag-submission → score pipeline with zero AWS cost.

**Why this design.**

- `flag` is the simplest kind: one CFn deploy, one SSM Parameter, one submission, one comparison.
- Only resource is an SSM Parameter Store entry on Standard tier. Free, scoped to one team via `${NamePrefix}`.
- The Output `ParameterConsoleUrl` deeplinks straight to the AWS Console. That makes the "find the value" UX a single click rather than a CLI quest, which keeps difficulty=1 honest.
- Hints carry penalties (10 / 20 pt out of 100) so the system can be exercised end-to-end without making the problem trivial.

**Trade-off accepted.**

- "Read a parameter" is not a realistic SRE scenario. The fictional Kato-san narrative (= predecessor left it behind) is there purely so the problem **feels** like an SRE situation. The mechanism is sanity-check; the *story* is character-building.

**Reusable patterns.**

- Single-Parameter-Store flag is the right shape for any "verify the candidate can find X in the AWS Console" Challenge.
- Console deeplink Output (`ParameterConsoleUrl`) is more discoverable than CLI guidance. Copy this pattern when teaching navigation.

## 2. `hello-world-battle` (uptime-flat)

**One-line design intent.** Smallest Battle that exercises the platform's per-minute polling scoring engine, on free-tier EC2.

**Why this design.**

- One VPC, one t3.micro, one nginx, one Python `/healthz`. The CFn surface is intentionally minimal so new authors can read the whole template in one sitting.
- The `FrontendUrl` / `ApiUrl` Outputs are emitted **empty** by design (= invariant #9 in the catalog `AGENT.md`). Competitors must paste the URLs into the Participant Portal override fields. This prevents "deploy auto-earns points" and forces the contestant to engage with the portal before scoring starts.
- SSM セッション Manager is used instead of SSH. No key management, no inbound port 22, and the same recovery flow works for every team.

**Trade-off accepted.**

- Two endpoint slots could have been `uptime-multi`, but `uptime-flat` with a single combined success condition is simpler to author. The cost is that partial recovery (frontend up, API down) does not earn partial credit. Author judged that "all-or-nothing" is the right teaching message for "uptime is binary in a Battle context".

**Reusable patterns.**

- Empty Output + portal override is the canonical way to gate scoring on competitor action.
- `Ec2HostHint` Output (= public DNS hint) makes the override step a copy-paste rather than a discovery puzzle.
- t3.micro within Free Tier is a hard ceiling. Heavier compute belongs in a difficulty=3+ problem with cost warnings.

## 3. `security-battle-royale` (uptime-multi)

**One-line design intent.** Force the contestant to keep two services (nginx + Flask) returning 200 *simultaneously* while patching a real codebase under operator-fired attack probes.

**Why this design.**

- Two endpoint slots scored with `uptime-multi`: a cycle pays out only when *both* are green. This rewards holistic uptime over single-service heroics.
- Real code (MySQL + Flask + nginx in docker-compose on one EC2) so the contestant has to read someone else's code under time pressure, which is the actual SRE incident-response skill.
- `${NamePrefix}` isolation per team means cross-tenant attacks are physically impossible. The "Battle" framing is intra-team — operator probes, not other teams.
- Default `AllowedCidr: 0.0.0.0/0` because the problem is designed to be played publicly. The operator can tighten this via CFn parameter for closed events.

**Trade-off accepted.**

- A real Flask app introduces an authoring burden (the code has to be both vulnerable enough to teach and stable enough to demo). Author chose pre-baked vulnerable patterns rather than CVE-grade exploits, keeping the difficulty at 4 rather than 5.
- Cost rises to ~$0.10 per 90 minutes (t3.small). Free Tier no longer covers it. This is the cost ceiling for an unfunded contestant practice セッション.

**Reusable patterns.**

- `uptime-multi` with `failurePenalty` rewards graceful hardening (= "let some attacks through, keep 200 returning") over perfect hardening (= "lock everything down, app dies").
- "Inherited codebase" narrative removes the "this is contrived" complaint. The Kato-san character is the platform-wide convention for this kind of story setup.

## 4. `microservice-migration-battle` (phased-polling)

**One-line design intent.** Teach the strangler-fig migration pattern by paying out *more* per minute as the contestant peels services off an EC2 monolith onto managed runtimes.

**Why this design.**

- Three services (users / orders / catalog) initially co-located on one EC2 behind nginx. Each service exposes `GET /meta` so the scoring engine can ask "where do you live now?" and pay out per hosting tier.
- `phased-polling` with `platformRules` (= per-hosting payout table) is the only kind where the *scoring weight changes with the contestant's own infrastructure choices*. EC2 pays the least, Lambda / ECS / App Runner pay progressively more.
- `phases[].afterMinutes` shifts the rules at fixed offsets. This makes "you waited too long to migrate" a measurable score penalty rather than a vibe.
- Three endpoint slots, all `overridable: true`. The default URL is the EC2 monolith; the override is the new managed-runtime URL. The scoring engine probes whichever is current.

**Trade-off accepted.**

- The author had to ship Dockerfiles that load cleanly on three different runtimes (Lambda, ECS Fargate, App Runner). That is non-trivial portage work. The reward is that the contestant gets to pick which service goes where, which is the actual product decision.
- IAM permissions for the contestant to deploy Lambda / ECS / App Runner are a separate concern, called out as a follow-up. As-shipped, the problem assumes the contestant has those rights in the sandbox account.

**Reusable patterns.**

- `/meta` self-report endpoint is the canonical way to let a contestant *change* their hosting tier without the platform having to detect it. Copy this when the contestant's choice of architecture is the answer.
- `appendPath` in `endpoints[].default` lets one CFn Output (`BaseUrl`) serve multiple slots (`/users` / `/orders` / `/catalog`) cleanly.
- Phased polling without disruption is the minimum viable phase mechanic. Add disruption (see `stackstack`) when the rule-change should be operator-triggered rather than time-triggered.

## 5. `stackstack` (phased-polling + disruptions)

**One-line design intent.** The five-axis Platform Engineering Battle: harden an AI-generated app along five control axes (auth / network / rate / audit / ux) while time-based phases and random org-event disruptions punish stalling.

**Why this design.**

- Five endpoint slots, each representing a *control axis* rather than a service. This is the most ambitious shape currently in the catalog: the contestant is not migrating one app, but applying five different control disciplines in parallel.
- Each slot pays 10× more on a managed runtime than on EC2 (100 → 1,000 pt/cycle). The +30,000 all-managed bonus rewards complete migration, not partial credit.
- Phases at 30 / 60 / 90 minutes (`production-ramp`, `compliance-audit`, `incident-response`) degrade *every slot still on EC2*, not just the slow ones. This forces parallel work rather than sequential migration.
- Disruption catalog (CEO 5000-user demand, MFA mandate, PII finding, .env leak, AI-committed secret) fires at operator discretion. The contestant cannot plan the order in advance.

**Trade-off accepted.**

- The metadata.json is much larger than the other four problems. The `phases[]` × `disruptions[]` × five slots combinatorial space pushes the schema near its expressivity limit. Authors should treat `stackstack` as the upper bound on how much should live in a single problem — beyond this, split into multiple problems.
- Cost and runtime grow accordingly. Author chose to keep deploy targets that fit within sandbox-account economics, but a "real" version of this problem would burn more.

**Reusable patterns.**

- Five-axis control framing (auth / network / rate / audit / ux) is portable to other Platform Engineering scenarios. Copy the slot list and rework only the underlying app.
- Disruption catalog (= named events with `defaultAfterMinutes` and `operatorEditable` fields) is the right primitive for "the operator should be able to fire chaos at will". Avoid hardcoding the disruption schedule when the operator wants discretion.
- All-managed bonus (= one-shot large payout for completing all slots) is a clean way to model "production-ready certification" without inflating per-cycle scores.

## Patterns shared across all five

- **Fictional Kato-san predecessor narrative.** Every Battle problem opens with "the previous SRE left this behind". This is the platform's standard way to make a synthetic problem feel like a real situation. Use it.
- **`${NamePrefix}` on every resource.** Without exception. Every author who skipped this discovered the bug on the second team's deploy.
- **Empty URL Output, override required (Battles).** This is invariant #9 in the catalog `AGENT.md`. The Battle starts when the contestant says it does, not when CFn finishes.
- **`i18n.en.*` mirrors.** Every catalog problem is published in both Japanese and English. The platform's locale fallback chain is `en → ja → top-level`. Locale support is `ja` + `en` only (no other locales).
- **SSM セッション Manager over SSH.** No key management, no port 22, works for every contestant. This is the canonical recovery channel.
- **Free Tier or near-Free Tier cost.** The cost ceiling is a per-contestant practice セッション, not a funded event. Every problem author should be able to justify the cost line in the PR body.

## See also

- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — how to ship a new problem.
- [`AUTHORING.html`](./AUTHORING.html) — 30-minute onboarding with the full field reference.
- [`AI-WORKFLOW.md`](./AI-WORKFLOW.md) — using Claude Code / Codex CLI to draft a problem.
- [ADR-012](../architecture/adr-012-problem-plugin-architecture.html) — the plugin architecture underpinning all five.
