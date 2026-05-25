# AI-assisted problem authoring workflow

> Audience: contributors who want to use Claude Code or Codex CLI as the *drafting tool* for a TenkaCloud problem.
> Prerequisite: read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first. AI assistance is **additive**, not required.

This document is the human-readable companion to the `/create-problem` Claude Code skill. The skill itself is at `.claude/skills/create-problem/SKILL.md`. Use this file when you want to understand the recommended human-driven prompts and review checkpoints around the skill, or when you are using Codex CLI (which does not load `.claude/skills/`).

## When AI assistance helps

AI is good at:

- Filling in metadata fields once you have decided the design (= `name` / `description` / `learningGoals` translations, tag lists, hint copy).
- Catching missing `${NamePrefix}` prefixes by reading the template carefully.
- Drafting `i18n.en.*` mirrors from a Japanese-first description (or vice versa).
- Translating a vague "I want a problem where the contestant must split a monolith" into a concrete `scoring.kind` choice.

AI is bad at:

- Knowing which AWS services are in the AWS Free Tier today.
- Estimating whether your disruption Lambda is genuinely idempotent.
- Knowing the deploy cost of your template without actually deploying it.

Treat AI as a drafting partner. Every output still has to pass `make validate-problems`, `bun run scripts/tenkacloud-problem.ts validate <id>`, and a real sandbox-account deploy.

## Recommended workflow with Claude Code

### Step 0. Set the role

Before any prompt, point Claude at `CLAUDE.md` and `AGENTS.md` (= top-level repository instructions) so it knows the platform's prohibitions (no `npx`, no `rm`, HTTP status codes via `StatusCodes.*`, polling over SSE, etc.). The repo's harness will catch obvious violations, but it is faster if Claude knows up front.

### Step 1. Use the `/create-problem` skill

In the Claude Code REPL:

```text
/create-problem
```

The skill walks through:

1. **Title and 1-line description.** What is the problem called and what does the contestant do in one sentence?
2. **Learning goals.** Two or three bullets describing what the contestant should walk away understanding.
3. **Difficulty and duration.** 1 = entry, 5 = expert. Duration is a free-form string like `60〜90 分`.
4. **Scoring kind.** The skill walks you through the decision tree from `CONTRIBUTING.md`. Pick exactly one of the five built-ins.
5. **Scaffold generation.** The skill invokes `bun run scripts/tenkacloud-problem.ts create <id> --kind <kind>` and shows the resulting files.
6. **Edit guidance.** The skill enumerates every `__PLACEHOLDER__` left in the scaffold and prompts for replacement values.

After Step 5, **stop and read the generated files yourself** before letting the skill drive the placeholder edits. The fastest review is `git diff` against an empty branch.

### Step 2. Hand-edit the riskiest parts

These need a human's eye, even after the skill suggests text:

- **`template.yaml` resource names and IAM policies.** AI is fluent in CFn syntax but routinely drops `${NamePrefix}` from at least one resource name. Grep the template for resource names that do not contain `!Sub`.
- **AWS cost estimate.** Ask the skill to estimate, then verify against the AWS Pricing Calculator or your own knowledge. If the answer involves PAY_PER_REQUEST DynamoDB, NAT Gateway, or large EBS volumes, push back.
- **Disruption idempotency.** If the problem uses an EventBridge Scheduler + Lambda, ask Claude to explain in plain English why the Lambda is safe to re-fire. If the explanation includes "the first call creates a resource", the Lambda is not idempotent — fix it.

### Step 3. Validate with the CLI

The skill prompts these, but verify manually:

```bash
make validate-problems
bun run scripts/tenkacloud-problem.ts validate <id>
bun run scripts/tenkacloud-problem.ts dry-run <id> --submitted "expected-flag-value"
bun run scripts/tenkacloud-problem.ts inspect <id>
```

If any fail, paste the full error back into Claude with "what does this mean and how do I fix it?" The CLI's error messages are designed to map to concrete fixes (see the table in `CONTRIBUTING.md`), but Claude can read the surrounding context to disambiguate.

### Step 4. Deploy into a sandbox AWS account

This is the only step Claude cannot do for you. Use a personal AWS account, not a shared production account:

```bash
aws cloudformation deploy \
  --template-file problems/<category>/<id>/template.yaml \
  --stack-name tc-<id>-test \
  --parameter-overrides NamePrefix=tc-<id>-test \
  --capabilities CAPABILITY_NAMED_IAM
```

Exercise the scoring path (= submit a flag, hit the endpoints, wait for a phase, fire a disruption). Capture the AWS Console screenshots or the `aws cloudformation describe-stacks` output for the PR body.

### Step 5. Tear down

```bash
aws cloudformation delete-stack --stack-name tc-<id>-test
```

### Step 6. Open the PR

The catalog repo is a submodule, so the PR goes to `susumutomita/TenkaCloudChallenge`, not to `TenkaCloud`. See `CONTRIBUTING.md` for the exact commands. Claude can draft the PR body — ask it to include Summary, Test plan, Regression analysis, and Physical impact sections.

## Workflow with Codex CLI

Codex CLI loads `AGENTS.md` (= the repository-level agent guide) but not the `.claude/skills/` directory. The `/create-problem` skill is therefore not available. Instead, give Codex plain natural-language instructions equivalent to the skill's steps:

```text
Draft a new TenkaCloud problem with these properties:
- title: "<title>"
- one-line description: "<sentence>"
- learning goals: <bullets>
- difficulty: <1-5>
- duration: "<free text>"
- scoring kind: <one of flag / uptime-flat / uptime-multi / phased-polling / attack-detection>

Use the CLI:
  bun run scripts/tenkacloud-problem.ts create <id> --kind <kind>

Then fill in the placeholders in metadata.json, write the template.yaml,
and run:
  make validate-problems
  bun run scripts/tenkacloud-problem.ts validate <id>

Open a PR to susumutomita/TenkaCloudChallenge (the catalog submodule).
The PR body must include Summary, Test plan, Regression analysis, and
Physical impact sections.
```

Codex CLI follows the role split in `AGENTS.md`: it can write `apps/`, `scripts/`, and `problems/` content, but does not touch CDK (`infrastructure/`) or IAM templates on its own initiative. Problem authoring is fully in scope.

## Prompts that work well

### "Translate this problem statement into a scoring kind."

> I want a problem where the contestant must keep a Lambda function healthy while operator-fired probes try to overload it. There is no flag. The score should reward sustained 200 responses. Which built-in scoring kind?

Expected answer: `uptime-flat` (one endpoint, sustained health). If the contestant must keep multiple Lambdas healthy and a cycle pays only when all are green, `uptime-multi`.

### "Fill in `i18n.en.*` from the Japanese fields."

> Given this Japanese `description`, write the matching `i18n.en.description` field. Keep the tone matter-of-fact, keep the fictional Kato-san narrative as 'Kato-san' (no honorifics). Maintain code blocks verbatim.

This is the highest-leverage AI use case. The output is almost always usable with light editing.

### "Why is my `validate` failing?"

> I ran `bun run scripts/tenkacloud-problem.ts validate my-problem` and got `scoring.flagOutputKey="FlagValue" not found in template.yaml Outputs`. Here is my template.yaml. What is wrong?

AI is good at reading the template and spotting that `Outputs:` has `FlagValueParam:` instead of `FlagValue:`.

### "Estimate the AWS cost of this template."

> Estimate the per-hour AWS cost of this CFn template, assuming us-east-1 pricing as of today. Flag any resource that is not in the AWS Free Tier.

The answer is a starting point, not authoritative. Always verify against the AWS Pricing Calculator before publishing.

## Prompts that do not work well

### "Decide whether this problem is a good idea."

AI cannot judge whether your problem teaches anything novel, fits the catalog's identity, or duplicates an existing problem. Ask a human reviewer.

### "Write the whole problem from a vague brief."

The author still has to make the design decisions (= what's the scoring axis, what's the failure mode, what's the cost ceiling). AI is good at filling forms once the design is fixed. It is bad at design itself.

### "Pick the AWS resources for me."

AWS Free Tier eligibility changes over time. NAT Gateway costs money. EBS gp3 volumes do not. RDS Free Tier eligibility resets per account. AI's training data on AWS pricing is not reliable enough to be a primary source.

## Review checkpoints (= what a human must verify)

Before opening the PR, regardless of how much AI helped:

- [ ] The problem teaches something a human would want to learn.
- [ ] The `${NamePrefix}` prefix appears on every resource name in `template.yaml`.
- [ ] The Outputs referenced by `metadata.json` exist verbatim in `template.yaml`.
- [ ] The deploy cost is documented in the PR body (target: zero or near-zero per contestant セッション).
- [ ] The scoring kind matches the actual scoring axis (= no `flag` problems that need polling, no `uptime-flat` problems that should be `uptime-multi`).
- [ ] The Japanese and English descriptions tell the same story.
- [ ] At least one sandbox-account deploy + scoring run happened.

The harness, validator, and `make before-commit` catch many bugs, but they cannot catch design mistakes. Human review is the last gate.

## See also

- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — the human workflow (start here).
- [`AUTHORING.html`](./AUTHORING.html) — 30-minute onboarding with the full field reference.
- [`EXAMPLES.md`](./EXAMPLES.md) — five reference problems with design retrospectives.
- `.claude/skills/create-problem/SKILL.md` — the `/create-problem` skill source.
- [`AGENTS.md`](../../AGENTS.md) — repository-level agent guide (loaded by both Claude Code and Codex CLI).
