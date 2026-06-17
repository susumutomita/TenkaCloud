# App-to-Quest Mode

App-to-Quest mode turns an owned or authorized source application analysis into reviewable TenkaCloud Quest draft material. It is a local authoring workflow for `.claude/skills/create-problem`; it is not platform runtime, not a scanner, and not an automatic problem publisher.

## Scope

Allowed:

- read author-provided CodeWiki analysis or local documentation
- normalize evidence into a source app profile
- generate a risk inventory and QuestCandidate list
- convert selected candidates into Markdown problem drafts
- keep all output under `.claude/drafts/app-to-quest/<app-slug>/`

Not allowed:

- clone external repositories without the author asking for that exact local action
- probe production URLs or run active scans
- store secret values, cookies, API responses, database rows, request captures, or raw PII
- write directly to `problems/`
- mark generated catalog entries as ready

Read [`safety-boundary.md`](./safety-boundary.md) before starting.

## Inputs

Preferred input:

```text
.codewiki/app-to-quest/analysis.json
```

Validate this file with [`codewiki-analysis.schema.json`](./codewiki-analysis.schema.json), then map it with [`codewiki-adapter.md`](./codewiki-adapter.md).

Temporary inputs are allowed when CodeWiki export is unavailable:

```text
.codewiki/index.html
codewiki-output.md
README.md + package.json + docs/*
```

Temporary inputs have lower confidence. Do not infer missing facts; preserve unknowns.

## Required First Questions

Ask these before generating output:

1. Where is the analysis input?
2. Does the author or their organization own or have permission to inspect the source app?
3. What `<app-slug>` should be used for `.claude/drafts/app-to-quest/<app-slug>/`?
4. What is the purpose: `assessment`, `workshop`, `battle`, or `challenge`?
5. Who is the target participant: `non-security developer`, `junior engineer`, `SRE`, or `security engineer`?

Stop if authorization or fixture boundaries are unclear.

## Output Layout

Write only under:

```text
.claude/drafts/app-to-quest/<app-slug>/
├── 00-source-summary.md
├── 01-source-app-profile.json
├── 02-risk-inventory.md
├── 03-quest-candidates.json
├── problem-drafts/
│   └── quest-001-<candidate-id>.md
└── review-checklist.md
```

Do not write `problems/<category>/<id>/` from App-to-Quest mode. Formal catalog conversion happens later with:

```bash
bun run scripts/tenkacloud-problem.ts create <id> --kind <kind>
```

## Workflow

### Step A: Input Confirmation

Confirm input path, authorization, slug, purpose, and target participant. Reject unclear authorization and unsafe production-probing requests.

### Step B: Source App Profile

Create `01-source-app-profile.json` using [`source-app-profile.schema.json`](./source-app-profile.schema.json). Extract:

- app summary
- tech stack
- user roles and trust levels
- data inventory
- public, authenticated, admin, webhook, and job entrypoints
- authentication model
- authorization boundaries
- storage locations
- external services
- AI data flow
- secret handling
- logging and auditability
- deployment model
- backup, deletion, and retention evidence
- cost-sensitive paths
- unknowns and confidence

### Step C: Risk Inventory

Create `02-risk-inventory.md`. Classify risks as:

- `security`
- `privacy`
- `reliability`
- `operations`
- `cost`
- `ai-safety`

Each risk should include source evidence, risk statement, what happens if ignored, affected users or data, likelihood, impact, confidence, and a safe simulation idea.

### Step D: Quest Candidates

Create `03-quest-candidates.json` with 5 to 10 candidates when enough evidence exists. Validate it with [`quest-candidate.schema.json`](./quest-candidate.schema.json).

Each candidate must include title, category, severity, source evidence, risk statement, business impact, what happens if ignored, learner experience, mission, success criteria, scoring signals, safe simulation plan, remediation hints, suggested problem type, suggested scoring kind, and confidence.

### Step E: Problem Drafts

After human review, convert the selected candidate into a Markdown draft under `problem-drafts/`. Use [`candidate-to-draft.md`](./candidate-to-draft.md) and [`problem-draft.md`](./problem-draft.md).

Each draft must contain:

- Source app context
- Why this matters
- What happens if ignored
- Mission
- Initial broken state
- Target fixed state
- Success criteria
- Scoring design
- Safe simulation plan
- Hints
- Organizer notes
- Safety notes

### Step F: Human Review Checklist

Copy [`review-checklist.md`](./review-checklist.md) into the draft directory and leave it for the author to complete before catalog conversion.

## Completion Criteria

App-to-Quest mode is complete when:

- output is under `.claude/drafts/app-to-quest/<app-slug>/`
- `01-source-app-profile.json` and `03-quest-candidates.json` match their schemas
- unknowns remain explicit
- no secret values or personal data values are copied
- candidates use defensive wording and safe simulation plans
- `problem-drafts/` contains only the human-selected draft material
- `review-checklist.md` exists
- no `apps/*`, `packages/*`, `infrastructure/*`, or `problems/*` files were created by the mode
