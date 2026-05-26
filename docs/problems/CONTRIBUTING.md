# Contributing problems to TenkaCloud — 30-minute quickstart

> Audience: external contributors who want to ship a new TenkaCloud problem in one focused PR.
> Source of truth for the file format: [`problems/SCHEMA.json`](../../problems/SCHEMA.json) + [`AUTHORING.html`](./AUTHORING.html).
> Source of truth for catalog conventions: [`problems/AGENT.md`](https://github.com/susumutomita/TenkaCloudChallenge/blob/main/AGENT.md) in the catalog submodule.

This guide is the **shortest path** for someone outside the maintainer's head to get a problem reviewed and merged. It complements `AUTHORING.html` (= the 30-minute onboarding tour) and `AGENT.md` in the catalog submodule (= the invariant list). Read this first when you want to know **what to do**; read those when you want to know **what each field means**.

Japanese mirror: [`CONTRIBUTING.ja.md`](./CONTRIBUTING.ja.md).

## Where problems live (= submodule, not this repo)

The platform repository (`TenkaCloud`) and the catalog repository (`TenkaCloudChallenge`) are physically decoupled.

```
TenkaCloud/                           ← platform (CDK + 3 SPAs + scoring engine)
└── problems/                         ← git submodule
    └── (real files live in github.com/susumutomita/TenkaCloudChallenge)
```

You submit problem PRs to **`susumutomita/TenkaCloudChallenge`**, not to `TenkaCloud`. The platform repo only needs a submodule pointer bump when a catalog change should ship.

To work locally:

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make install
# the working tree under problems/ is now a checkout of TenkaCloudChallenge
```

If you cloned without `--recurse-submodules`:

```bash
git submodule update --init --recursive problems
```

## 30-minute quickstart (= scaffold → edit → validate → PR)

### 1. Pick the scoring kind (= the most important decision)

A TenkaCloud problem ships exactly one of five built-in scoring kinds. The platform's generic scoring Lambda dispatches on this value; problem-specific scoring code is forbidden by [ADR-012](../architecture/adr-012-problem-plugin-architecture.html).

Use this decision tree:

```text
Does the competitor submit a single value (a "flag") to win?
├── Yes → kind = "flag"               (Challenge, e.g. read an SSM Parameter, find an S3 object)
└── No
    │
    Does the competitor have to keep something running?
    ├── Yes
    │   │
    │   Is there exactly one endpoint to keep alive?
    │   ├── Yes → kind = "uptime-flat"    (Battle, one nginx, one API)
    │   └── No, several endpoints together → kind = "uptime-multi"
    │       (Battle, frontend + api + worker; scoring rewards "all green at once")
    │
    └── No
        │
        Does the rule change over time (e.g. a migration deadline, a load surge)?
        ├── Yes → kind = "phased-polling"
        │   (Battle, phases[].afterMinutes shifts scoring; classic for migration races)
        │
        └── Is the goal to detect or block attacks?
            └── Yes → kind = "attack-detection"
                (Battle, WAF / SOC; scores +N per detected attack)
```

If none fits, the problem is probably **not yet a TenkaCloud problem** — file an issue first.

### 2. Scaffold the directory

```bash
bun run scripts/tenkacloud-problem.ts create my-problem --kind flag
# or for guided interactive input:
bun run scripts/tenkacloud-problem.ts create
```

The CLI creates `problems/<category>/my-problem/{metadata.json,template.yaml}` from `.claude/templates/problems/<kind>/`. `<category>` is inferred from `<kind>` (flag → `challenges/`, otherwise `battles/`); override with `--category Battle|Challenge`.

Alternative: in Claude Code, run `/create-problem`. The skill walks through the same steps interactively.

### 3. Edit the scaffold

The scaffold contains `__PROBLEM_NAME__`, `__TAG__`, `__LEARNING_GOAL_1__`, `__HINT_1__` and similar placeholders. **Grep for `__` and replace every occurrence** — JSON Schema accepts placeholders because they are strings, but the catalog UI and scoring engine will misbehave.

Minimum edits:

- `name`, `shortDescription`, `description` — write them as if the reader has zero context. Battles usually open with a one-paragraph fictional incident.
- `tags` — kebab-case, at least one.
- `learningGoals` — at least one bullet.
- `i18n.en.*` — required mirror for `name` / `shortDescription` / `description` / `learningGoals`. Locale support is `ja` + `en` only (no other locales).
- `template.yaml` — replace placeholder resources with real CFn. Every resource name, tag, and Group name must be prefixed with `${NamePrefix}` so multiple teams can deploy into the same AWS account.

### 4. Validate locally

```bash
# JSON Schema validation across the whole catalog
make validate-problems

# Per-problem cross-checks (Outputs ↔ metadata wiring, dashboard slot files)
bun run scripts/tenkacloud-problem.ts validate my-problem

# Optional: dry-run the scoring engine without deploying CFn
bun run scripts/tenkacloud-problem.ts dry-run my-problem --submitted "expected-flag-value"

# Inspect the rendered metadata + template summary
bun run scripts/tenkacloud-problem.ts inspect my-problem
```

If `make validate-problems` or `validate` errors, see [Validation errors](#validation-errors-and-how-to-read-them) below.

### 5. Deploy once into a sandbox AWS account (= "tested" status)

The platform never marks a problem `ready` until at least one human has deployed it end to end. Use a personal sandbox AWS account:

```bash
aws cloudformation deploy \
  --template-file problems/<category>/my-problem/template.yaml \
  --stack-name tc-my-problem-test \
  --parameter-overrides NamePrefix=tc-my-problem-test \
  --capabilities CAPABILITY_NAMED_IAM
```

Then exercise the scoring path manually (submit the flag, hit the endpoints, wait for a disruption to fire — whichever applies). If it scores, the problem is "tested" in the lifecycle sense (see below).

Tear down:

```bash
aws cloudformation delete-stack --stack-name tc-my-problem-test
```

### 6. Open the PR (= against the submodule repo)

In the `problems/` working tree:

```bash
cd problems
git checkout -b feat/my-problem
git add battles/my-problem  # or challenges/my-problem
git commit -m "feat: add my-problem"
git push origin feat/my-problem
gh pr create --repo susumutomita/TenkaCloudChallenge \
  --title "feat: add my-problem" \
  --body "..."
```

PR body checklist:

- What category, kind, and difficulty.
- Test plan: which `validate` / `dry-run` commands you ran, plus the AWS account you sandbox-deployed into (no account IDs).
- Whether the problem is `draft` (most first PRs), `tested`, or `ready` (see lifecycle below).
- Any cost the participant will incur (target: zero outside Free Tier).

A submodule-pointer bump PR against `TenkaCloud` is **not your responsibility** — the maintainer or a separate PR handles that.

## Lifecycle: draft → tested → ready → official → deprecated

`metadata.json` `status` is a JSON Schema enum with three values: `draft`, `ready`, `deprecated`. The full five-stage lifecycle uses these three plus two conventions tracked in PR descriptions, the catalog `CATALOG.md`, or commit history.

| Stage          | `status` field      | Means                                                                       | Visible in catalog? |
| -------------- | ------------------- | --------------------------------------------------------------------------- | ------------------- |
| **draft**      | `"status": "draft"` | Author work-in-progress. Scaffold compiles, schema passes, **not yet deployed end-to-end.** | No (filtered out)   |
| **tested**     | `"status": "draft"` | Author has deployed once into a sandbox AWS account and confirmed scoring. Note "tested in AWS sandbox" in PR body. | No                  |
| **ready**      | `"status": "ready"` | Maintainer review passed. Public catalog entry. Anyone can spin it up at an event. | Yes                 |
| **official**   | `"status": "ready"` | Used at least once in a real public event (JAWS-UG, CCoE training). Add an `official-yyyy-mm` tag and link the event in `README.md`. | Yes                 |
| **deprecated** | `"status": "deprecated"` | Replaced or no longer maintained. Catalog filters by default. Keep the dir for historical reference. | No                  |

Promotion from `draft` to `ready` is a separate PR (not the original add) so reviewers can compare before/after. Mention the test event or sandbox results in that PR body.

## Validation errors and how to read them

The CLI validator (`scripts/tenkacloud-problem.ts validate`) and `make validate-problems` produce messages like the table below. Each row maps a real error to its fix.

| Symptom (substring of the error)                                            | Likely cause                                                                       | Fix                                                                                                                                  |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `scoring.kind="..." is not a recognized kind`                               | Typo in `scoring.kind`                                                             | Set it to exactly one of `flag` / `uptime-flat` / `uptime-multi` / `phased-polling` / `attack-detection`.                            |
| `scoring.flagOutputKey="X" not found in template.yaml Outputs`              | `metadata.scoring.flagOutputKey` references a CFn `Output` key that doesn't exist  | Open `template.yaml`, add an `Outputs.X:` entry, or fix the metadata key. Both sides must match exactly.                             |
| `scoring.statsOutputKey="X" not found in template.yaml Outputs`             | Same as above for `attack-detection`                                               | Add an `Outputs.X:` entry whose `Value` is the integer attack count.                                                                 |
| `endpoints[slot=N].default.key="X" not found in template.yaml Outputs`      | `endpoints[].default.key` points at a missing Output                               | Add the `Outputs.X:` entry (typically the public URL of the endpoint slot).                                                          |
| `dashboard.slots["X"]="path" file not found at ...`                         | A `dashboard.slots` entry references a portal plugin file that does not exist      | Either create the `.tsx` file at the referenced path, or remove the slot entry.                                                      |
| `metadata.id="X" does not match dir name "Y"`                               | `metadata.id` and the directory name diverged                                      | Rename the directory or fix `metadata.id`. They must be identical.                                                                   |
| `runtime block must declare provider / engine / entry`                      | Partial `runtime` field (e.g. only `entry`)                                        | Either set all three keys or drop the `runtime` block (the validator falls back to legacy `cfnTemplate`).                            |
| `runtime.entry="A" and cfnTemplate="B" must match`                          | Both `runtime` and `cfnTemplate` are set but disagree                              | Make `runtime.entry === cfnTemplate` during the ADR-023 compatibility window.                                                        |
| `Runtime <provider>/<engine> is recognized but not executable`              | Reserved future runtime (e.g. `azure/arm`, `kubernetes/helm`)                      | Switch to `aws/cloudformation`. Other providers parse but are not yet executable.                                                    |
| `cfnTemplate file "..." not found`                                          | Filename mismatch                                                                  | Ensure the file referenced by `cfnTemplate` (or `runtime.entry`) exists in the problem directory.                                    |
| `metadata.json parse error: ...`                                            | Invalid JSON (trailing comma, unquoted key)                                        | Run the file through a JSON formatter; placeholders must stay quoted.                                                                |

For schema errors from `make validate-problems` that include `instancePath` (= JSON pointer like `/scoring/points`), open `metadata.json`, follow that path, and fix the offending value. The schema's `description` fields ([`problems/SCHEMA.json`](../../problems/SCHEMA.json)) explain each property.

### Common `template.yaml` mistakes

These are not caught by JSON Schema but are caught by CFn at deploy time or by AWS cost surprise:

- **Missing `${NamePrefix}` on a resource name** — two teams collide at deploy time. Always wrap names with `!Sub "${NamePrefix}-..."`.
- **`!Sub` without closing brace** — `!Sub "tc-${NamePrefix-bucket"` instead of `!Sub "tc-${NamePrefix}-bucket"`. Read the line CFn reports and look for the missing `}`.
- **Non-idempotent disruption Lambda** — EventBridge Scheduler re-fires; wrap `tc qdisc add ...` with `|| true` so EEXIST does not crash later cycles.
- **PAY_PER_REQUEST DynamoDB** — forbidden. Use `BillingMode: PROVISIONED` with 1 RCU / 1 WCU; the platform's CDK Aspect enforces this for platform tables, but problem templates must self-discipline.
- **`Resource: "*"` IAM** — only allowed for CloudShell and a documented list. The catalog's `AGENT.md` lists the exception comment markers; do not remove them.

## AI-assisted authoring (= optional, additive)

Claude Code ships with a `/create-problem` skill that runs the same scaffold + edit flow with an AI in the loop. It is not required — every step is reproducible by hand. See [`AI-WORKFLOW.md`](./AI-WORKFLOW.md) for the recommended prompts.

## Checklist before opening the PR

- [ ] `metadata.id` matches the directory name.
- [ ] `category` is `"Battle"` or `"Challenge"` (capitalized).
- [ ] `status` is `"draft"` for a first submission.
- [ ] `scoring.kind` is one of the five built-ins.
- [ ] Every `__PLACEHOLDER__` in `metadata.json` has been replaced.
- [ ] Every endpoint / scoring key referenced from `metadata.json` exists as a key in `template.yaml` `Outputs:`.
- [ ] Every resource name in `template.yaml` is prefixed with `${NamePrefix}`.
- [ ] `make validate-problems` passes.
- [ ] `bun run scripts/tenkacloud-problem.ts validate <id>` passes.
- [ ] Deploy + scoring tested at least once in a sandbox AWS account (PR body mentions it).
- [ ] `i18n.en.*` mirrors are filled in for `name` / `shortDescription` / `description` / `learningGoals`.
- [ ] PR body describes Summary, Test plan, Regression analysis, Physical impact.

## See also

- [`AUTHORING.html`](./AUTHORING.html) — 30-minute onboarding with the full field list.
- [`AI-WORKFLOW.md`](./AI-WORKFLOW.md) — Claude Code / Codex CLI workflow for problem authoring.
- [`EXAMPLES.md`](./EXAMPLES.md) — design retrospectives on the five reference problems.
- [`problems/AGENT.md`](https://github.com/susumutomita/TenkaCloudChallenge/blob/main/AGENT.md) — catalog repo invariants (deploy-time rules enforced by `bun run validate`).
- [ADR-012](../architecture/adr-012-problem-plugin-architecture.html) — the plugin architecture that makes this possible.
- [ADR-023](../architecture/adr-023-provider-specific-problem-runtime.html) — the `runtime` field and future multi-provider support.
