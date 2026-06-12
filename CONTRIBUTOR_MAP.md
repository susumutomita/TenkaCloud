# TenkaCloud Contributor Map

> "I want to do X. Where do I read and where do I edit?" navigation guide. For the architectural narrative, read [`docs/architecture/OVERVIEW.md`](./docs/architecture/OVERVIEW.md) first. For directory-level "where is X" lookups, see [`docs/architecture/MODULE_MAP.md`](./docs/architecture/MODULE_MAP.md). For term definitions, see [`docs/architecture/GLOSSARY.md`](./docs/architecture/GLOSSARY.md).

This document is intentionally **task-oriented**. Each section starts with a concrete goal and lists what to read, what to edit, and what gates to clear.

---

## First-time setup (15 minutes)

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud
cd TenkaCloud
make install
make help                    # see every workflow target
```

Then read in this order:

1. [`CLAUDE.md`](./CLAUDE.md) — project rules + commands + prohibitions
2. [`docs/architecture/OVERVIEW.md`](./docs/architecture/OVERVIEW.md) — the 10-minute architectural picture
3. [`docs/architecture/GLOSSARY.md`](./docs/architecture/GLOSSARY.md) — definitions for terms you'll hit immediately
4. The ADR for whichever subsystem you're touching ([`docs/architecture/adr-*.html`](./docs/architecture))

Before opening a PR, run the gates in this order:

```bash
make harness          # architecture invariants (see docs/architecture/harness.md)
make before-commit    # lint / typecheck / vitest / validate-problems / template checks / synth
```

Both must be green. If something fails, fix the code; do not edit `biome.json` / `vitest.config.ts` / `tsconfig.json` to mask it (= explicit prohibition in CLAUDE.md).

---

## "I want to playtest existing problems"

**Read**:

- [`docs/community/ONBOARDING.html`](./docs/community/ONBOARDING.html) — Tester role expectations + recognition.
- [`docs/community/PLAYTEST-CHECKLIST.html`](./docs/community/PLAYTEST-CHECKLIST.html) — 30-minute protocol (pick a problem → `make deploy` Lite mode → register team → solve → score → file a structured report).

**Edit**:

- Nothing in this repo. Output is a new issue on the catalog repo ([TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge/issues/new?labels=problem-feedback)) for problem-specific bugs, or on this repo for platform-side bugs.

**Gates**: none. Filing the issue itself is the deliverable.

**Recognition**: Your handle stays on the GitHub issue history. Frequent testers land in `CONTRIBUTORS.md` under "Tester squad". See [Recognition](./docs/community/ONBOARDING.html#recognition).

---

## "I want to review problems"

**Read**:

- [`docs/community/ONBOARDING.html`](./docs/community/ONBOARDING.html) — community roles and recognition paths.
- [`docs/community/PROBLEM-REVIEW-CHECKLIST.html`](./docs/community/PROBLEM-REVIEW-CHECKLIST.html) — 6-section rubric (scoring fairness / hint progression / no-skip-by-luck / time-to-solve / scenario realism / template security).
- [ADR-012](./docs/architecture/adr-012-problem-plugin-architecture.html) — the plugin contract; useful when you read `metadata.json`.

**Edit**:

- Nothing. Output is PR review comments on open problem PRs at [TenkaCloudChallenge/pulls](https://github.com/susumutomita/TenkaCloudChallenge/pulls).
- Use the reviewer summary template in section 8 of the checklist for the top-level review comment.

**Gates**: none for you. Maintainers use your review as a merge gate.

**Recognition**: GitHub PR review log + `CONTRIBUTORS.md` "Reviewers" + Discord role badge.

---

## "I want to add a new problem"

**Read**:

- [`problems/CATALOG.md`](./problems/CATALOG.md) (or `.en.md`) — catalog repo's authoring narrative
- [`docs/architecture/adr-012-problem-plugin-architecture.html`](./docs/architecture/adr-012-problem-plugin-architecture.html) — the plugin contract
- [`docs/problems/AUTHORING.html`](./docs/problems/AUTHORING.html) — 30-minute scaffolding walkthrough

**Edit**:

- The `problems/` submodule is the catalog repo [TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge). Commit your `metadata.json` + `template.yaml` + optional `portal/` / `services/` **there**, not in the platform repo.
- Generate the scaffold via `bun run scripts/tenkacloud-problem.ts create <id> --kind <kind>` or invoke the `/create-problem` Claude Code skill.

**After the catalog repo merges your PR**:

A maintainer of this platform repo bumps the submodule pointer:

```bash
git submodule update --remote problems
git add problems
git commit -m "chore(catalog): bump TenkaCloudChallenge to <sha>"
```

The next `make deploy` picks up your new problem automatically.

**Gates**:

- Catalog repo runs `bun run validate` on PR (= ajv schema + cross-ref check).
- Platform repo runs `make validate-problems` on the same metadata after the submodule pointer is bumped.

---

## "I want to fix a Lambda bug"

**Read**:

- [`docs/architecture/MODULE_MAP.md`](./docs/architecture/MODULE_MAP.md) — find the right handler under `infrastructure/lib/problem-deploy/handlers/`
- Most handlers carry an issue number in their comments (e.g., `// Issue #862`); read that issue for context.

**Edit**:

- The handler file under `infrastructure/lib/problem-deploy/handlers/<role>/`.
- Add or update a test under `infrastructure/test/problem-deploy/` ([`INVARIANT_PR_TESTS_COUPLED_WITH_CHANGE`](./docs/architecture/harness.md)).

**Constraints**:

- HTTP status codes: use `StatusCodes` from `http-status-codes`, never numeric literals (= AGENTS.md rule).
- Handlers must not call `fetch(` directly — push HTTP calls down to Service / Repository (= harness rule).
- Auth: every Lambda goes through Cognito JWT. No `AUTH_SKIP`.

**Gates**:

- `make before-commit` runs vitest with coverage.
- `make harness` checks the no-`fetch`-in-handlers and HTTP-status-code rules.

---

## "I want to add a new admin UI feature"

**Read**:

- [`apps/admin-console/README.md`](./apps/admin-console/README.md) and the screenshot folder.
- ADR-020 (authorization model) — what System Admin can and can't see.
- [Cloudscape Design System](https://cloudscape.design/components/) — pick UI components from here as the default.

**Edit**:

- `apps/admin-console/src/` for SystemAdmin UI, `apps/application-admin-console/src/` for Tenant Admin UI.
- If the feature needs a new backend route, add the route under the appropriate handler in `infrastructure/lib/`.
- `runtime-config.json` flow: if you introduce a new backend URL, update the hosting stack env AND `apps/<app>/src/config.ts` `loadConfig()`.

**Constraints**:

- No tenant logic in app code ([`INVARIANT_APP_CODE_IS_UNMODIFIED`](./docs/architecture/harness.md)). `apps/*/dist/` is shared across tenants; differences flow through `runtime-config.json`.
- Polling only ([AGENTS.md prohibition](./AGENTS.md#prohibited)). No SSE / WebSocket. Supplement with EventBridge-driven reconciliation per [ADR-014](./docs/architecture/adr-014-eventbridge-driven-state-reconciliation.html).

**Gates**:

- Per-app `vitest`. CI runs them via `make test-coverage`.
- Visual smoke: run each SPA's dev server with `cd apps/<app> && make dev` (ports 5173/5174/5175).

---

## "I want to add a Battle disruption"

**Read**:

- [ADR-013](./docs/architecture/adr-013-disruption-phase2-condition-triggered.html) — disruption phase 2 (condition-triggered) design
- [`SCHEMA.json`](./problems/SCHEMA.json) `disruptions[]` field — declare in metadata
- `infrastructure/lib/problem-deploy/handlers/event-handler/disruption-fire.ts` — the firing handler

**Edit**:

- In the catalog repo (submodule): add `disruptions[]` to your problem's `metadata.json` with a `trigger.kind` (`after-deploy` / `team-score-above` / `phase-entered`).
- If the trigger logic doesn't exist yet (= rare; the 3 above cover most needs), add a new trigger kind in `disruption-fire.ts` + a unit test.

**Gates**: same as Lambda bug fix.

---

## "I want to write a new ADR"

**Read**:

- Existing ADRs under [`docs/architecture/adr-*.html`](./docs/architecture) for style reference. Pick an ADR close to your topic and skim it.
- The `adr-must-be-html` and `adr-self-contained` rules in [`docs/architecture/harness.md`](./docs/architecture/harness.md).

**Edit**:

- Create `docs/architecture/adr-NNN-<kebab-slug>.html`. Number = next unused. **Do not** create ADRs in Markdown — harness will fail.
- Write background / decision / impact / alternatives / migration plan. Use HTML's expressive features (row spans, color, SVG, collapsible sections). Each ADR is OSS-readable in isolation.

**Constraints**:

- ADRs must be **self-contained**. Do not leave chat context, rolling-update metadata, role-split notes like `Claude proposes / user owns`, or unresolved TODOs.
- If you cite another ADR, link to it explicitly.

**Gates**: `make harness` validates the ADR contract. Existing violations are baselined at `.claude/harness/baselines/adr-self-contained.json` so only new regressions fail.

---

## "I want to change CDK / IAM / a CFn template"

**This is the user's territory** (= [AGENTS.md role-split](./AGENTS.md#role-split)). If you are an AI agent: propose, don't act. Write a PR description with the diff and let the user decide.

If you are the user (or have explicit authorization):

**Read**:

- The relevant stack under `infrastructure/lib/`.
- Aspects under `infrastructure/lib/cdk-aspect/` — they enforce cross-cutting policies (DDB low-capacity, KMS pending window, etc).
- ADRs about IAM (ADR-002, ADR-009, ADR-017 for TrustBridge).

**Edit**:

- The CDK stack. Add or update unit tests under `infrastructure/test/` with `Template.fromStack(stack)` assertions.
- If you add a new cross-cutting policy, add a new Aspect and apply it in `app-wiring/wire.ts`.

**Constraints**:

- AssumeRole into competitor accounts **always requires `ExternalId`**. No exceptions.
- DynamoDB: PROVISIONED 1/1 only. PAY_PER_REQUEST is forbidden (Aspect will override).
- No `npx` (= use `bunx` or `nlx`). No `rm` (= use `git rm`).

**Gates**:

- `cdk synth` runs in `make before-commit` to catch CFn generation errors.
- `make harness` + cdk-nag rules in CI.

---

## "I want to update a CLI command"

**Read**:

- [`apps/cli/README.md`](./apps/cli/README.md) — Phase 1 OAuth scaffold.
- ADR-010 (api-first-cli-mcp) — the operator API-first model.

**Edit**:

- `apps/cli/bin/tenkacloud.ts` for the subcommand router.
- `apps/cli/src/` for OAuth / API calls.
- Add a vitest case under `apps/cli/test/`.

**Constraints**:

- CLI subcommands should be machine-friendly: `--json` flag, explicit exit codes, idempotency where applicable. This makes them usable by AI agents and automation.

**Gates**: `bun run --filter @TenkaCloud/cli test` + `make before-commit`.

---

## "I want to sell TenkaCloud" (or field an inbound)

**Read**:

- [`docs/commercial/PACKAGES.html`](./docs/commercial/PACKAGES.html) — formal scope, deliverables, exclusions, delivery model, and pricing structure for the four commercial offerings (Hosted Event / Annual Arena / Custom Problem / CCoE Enablement add-on).
- [`docs/commercial/SALES-PLAYBOOK.html`](./docs/commercial/SALES-PLAYBOOK.html) — one-page elevator + qualifying questions + common objections + next-step CTA per package.
- The "Self-host vs operated" section of [`README.md`](./README.md#self-host-vs-operated) — the OSS &harr; commercial framing that buyers land on first.
- The `#pricing` section of the [landing page](https://susumutomita.github.io/TenkaCloud/#pricing) — public starting prices and the contact form a prospect actually uses.

**Edit (only if the offering itself changes)**:

- `docs/commercial/PACKAGES.html` — scope source of truth. Touch this when you change what is in / out of a package.
- `docs/commercial/SALES-PLAYBOOK.html` — conversational source of truth. Touch this when an objection keeps coming up or when the qualifying questions need tightening.
- `landing/index.html` + `landing/app.js` — the public-facing summary (pricing cards + "Commercial Offerings" section). The packages page is the source of truth; the landing page is a short pointer.
- `README.md` "Commercial" subsection — keep in sync with the packages page (do not duplicate scope; link).

**Constraints**:

- **OSS is free.** Do not pitch a paid package to someone who is happy self-hosting. Route them to the Quickstart instead.
- **Productized vs. consulting.** Hosted Event / Annual Arena / Custom Problem each have fixed shape. Open-ended advisory work is CCoE Enablement — surface that explicitly, never fold it in.
- **No production access.** Custom Problem is a sanitized scenario. If a prospect insists on production data / live credentials, stop and route to security review.

**Gates**:

- Edits to `docs/commercial/*.html` pass `make harness` (HTML ADR rules also cover commercial docs) and `make before-commit`.
- Edits to `landing/index.html` + `landing/app.js` must keep both `ja` and `en` i18n keys in sync (the harness checks structural parity).

---

## "I want to decide if we're ready to launch"

**Read**:

- [`docs/go-to-market/launch-readiness.html`](./docs/go-to-market/launch-readiness.html) — the phase-gate checklist for OSS reveal (Phase A), first paid Hosted Event (Phase B), and enterprise annual discussion (Phase C). Each phase lists the required items with Status (Done / Gap / Roadmap) + linked evidence (PR# / file path), plus the items that are *not* required for that gate.
- [`docs/go-to-market/community-first-launch.html`](./docs/go-to-market/community-first-launch.html) — the *signal* side: how to validate buyer intent with a small community-first release. This pairs with the gate doc (the gate decides *if we can*; the signal doc decides *if we should*).
- The "Known limitations" section of `launch-readiness.html` — the customer-safe phrasing for what we do not have today (no SOC2 cert, no multi-cloud, no universal cloud problem compiler, no Web3 voting impl, no full self-service SaaS). Say these out loud in pitches.

**Edit (when a phase decision is made)**:

- `docs/go-to-market/launch-readiness.html` `§8 Decision log` — append a row when a Phase A / B / C go / no-go is called. Never rewrite history; the point of the log is the audit trail of *why we decided what we decided with the evidence we had*.
- The Status badges in §1–§3 — flip rows from `Gap` to `Done` only when the linked PR has actually merged or a real dry-run has actually been executed. Roadmap items move to Done only when they ship inside the phase's required scope.

**Constraints**:

- **The gate is "enough, not perfect."** Do not turn `Required` rows into a wish list. If you want to add a row, justify it against the phase's decision question, not against your own ambition for the product.
- **`Not required` rows stay listed.** They are verbatim from [`#1370`](https://github.com/susumutomita/TenkaCloud/issues/1370) so the boundary is auditable. Silently dropping them hides the trade-off we agreed to.
- **The decision log is append-only.** If a previous decision turned out to be wrong, write a new row that supersedes it; do not edit the old row.

**Gates**:

- This doc is HTML by hand (no markdown source). It is out of scope of the harness `adr-must-be-html` / `adr-self-contained` rules (those only match `docs/architecture/adr-*`), but the same self-contained spirit applies: write for an OSS reader landing cold.
- `make before-commit` must still pass; the doc is link-checked through the existing markdownlint / textlint surface where it is referenced from markdown.

---

## "I want to investigate a production incident"

**Read**:

- `docs/operations/` — runbooks (HTML).
- The relevant Lambda's CloudWatch Log Group. Most Lambdas emit structured logs prefixed with `[<role>]` and tagged with `jobId` / `tenantId` for correlation.
- The TrustBridge shadow audit log (Issue #795 / ADR-017) for cross-account actions.

**No code change unless rolling out a fix.** Document findings in a follow-up issue.

---

## "I want to understand or audit the security posture"

**Read**:

- [`docs/security/HARDENING-CHECKLIST.html`](./docs/security/HARDENING-CHECKLIST.html) — the item-by-item commercial hosted-event security baseline. Each control links to its evidence (file path / harness rule ID / ADR / runbook) and is tagged **Implemented / Gap / Roadmap**.
- [`docs/security/README.md`](./docs/security/README.md) — landing + verification commands (each control has a `grep` / `make` / test command to run locally).
- [`SECURITY.md`](./SECURITY.md) — private vulnerability disclosure channel (do not file public issues for sensitive disclosures).
- [`docs/architecture/harness.md`](./docs/architecture/harness.md) — machine-checked invariants and enforcement rules (`secrets-manager-forbidden`, `handler-must-not-call-fetch`, `iam-wildcard-needs-justify`, `handler-tenant-isolation`, etc).

**If you want to add a new control**:

- Closing a documented gap usually means adding a harness rule under `.claude/harness/src/rules/` with a unit test under the same directory. Then update the relevant checklist row's status badge and evidence cell.
- Stand-alone PR per rule, with the rule rationale in the body. Do not bundle rule additions with feature work.

**Gates**:

- `make harness` + `make harness-test` validate new rules.
- `make before-commit` includes `make check-template-security` + `make audit-deps`.

---

## "I want to update CI / lint / format config"

Avoid this unless absolutely necessary. CLAUDE.md explicitly forbids editing `biome.json` / `vitest.config.ts` / `tsconfig.json` to mask code failures. The correct path is almost always to fix the code.

Legitimate config edits:

- Adding a new package to `package.json` `trustedDependencies` — **always a stand-alone PR** with manual script verification in the PR body (= supply-chain hardening; AGENTS.md "Supply chain security").
- Adjusting CI workflow steps for new infrastructure (e.g., a new submodule, a new check). Document the rationale in the commit.
- Bumping `biome` or other locked tool versions — run `biome migrate` and document.

**Gates**: full `make before-commit` + CI green.

---

## "I want to scope out a brand-new subsystem"

You probably want an ADR first. See "I want to write a new ADR" above.

For inspiration, look at how recent large changes were proposed:

- ADR-012 (problem plugin architecture) — set up the plugin contract for problems
- ADR-016 (TenkaCloud Lite) — split the deploy mode in two
- ADR-017 (TrustBridge) — added a new cross-cutting audit layer
- ADR-022 (inter-team coordination plugin) — extended the plugin model for Battle interactions

Open a draft PR with just the ADR. Iterate on the design before writing implementation code.

---

## Common surprises

| Surprise                                                                 | What's happening                                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| "I edited a problem and `make deploy` doesn't pick it up"                | Problems live in the `problems/` **submodule**. Bump the pointer or edit in the catalog repo.     |
| "`make deploy` is fast, why does the docs mention 3 phases?"              | `make deploy` is **Lite mode** (= 2 stacks). 3-phase install is `make deploy-saas` only.          |
| "Why is DynamoDB so slow on my new table?"                                 | The `DynamoDbLowCapacity` Aspect forces 1 RCU / 1 WCU. Override only with a justified config bump. |
| "Cognito UserPool keeps getting recreated"                                 | The DestroyPolicySetter Aspect sets `RemovalPolicy.DESTROY` for dev. Production envs override.   |
| "CI fails on a problem I didn't touch"                                     | Submodule pointer drift. Run `git submodule update --init --recursive`.                           |
| "ADR-NNN is mentioned in code but the file doesn't exist"                  | Several ADR numbers were tentatively reserved during design; check open issues for the real ADR.  |
| "The `_legacy/` dir is gone but Git log still references it"              | Phase 1 of the catalog split (= TenkaCloudChallenge#3) deleted it. History is intact via Git log. |
| "I see TrustBridge mentioned but the code doesn't block anything"          | TrustBridge is in **shadow mode** by design. Phase 2 of ADR-017 flips it to enforcement.          |

---

## Who to ask

- Architecture / design decisions → open an issue with the `discussion` label
- Bugs → open an issue with a repro + the relevant Lambda log excerpt
- Security → see [SECURITY.md](./SECURITY.md). Do not file public issues for sensitive disclosures.
- General questions → [GitHub Discussions](https://github.com/susumutomita/TenkaCloud/discussions)
