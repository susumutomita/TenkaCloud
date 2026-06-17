# App-to-Quest Safety and Human Review

This reference defines the safety boundary and human review workflow for App-to-Quest authoring.

App-to-Quest exists to help authors turn owned or authorized applications into defensive TenkaCloud quests. It must not become an unapproved scanner, exploit generator, or production diagnostic tool.

## Safety Boundary

App-to-Quest may only work with:

- repositories, fixtures, or analysis files the author owns or is explicitly authorized to inspect
- local source checkouts
- precomputed analysis files such as `.codewiki/app-to-quest/analysis.json`
- synthetic data, synthetic users, local fixtures, and sandbox problem resources
- defensive scenarios that teach understanding, remediation, recovery, monitoring, or safe verification

App-to-Quest must not:

- run active scans against deployed systems
- probe production URLs
- generate real-service attack, intrusion, persistence, exfiltration, evasion, or bypass instructions
- generate WAF bypass or detection bypass instructions
- use real credentials, tokens, session cookies, API response bodies, request captures, or database rows
- store secret values or personal data values in drafts
- turn missing evidence into confident vulnerability claims
- write directly to `problems/` without a human selecting and reviewing one draft
- publish or mark generated catalog entries as `ready`

When unsure, stop and ask the author to confirm authorization, scope, and intended fixture boundary.

## Allowed Outputs

App-to-Quest may generate these authoring artifacts:

```text
.claude/drafts/app-to-quest/<app-slug>/
├── 00-source-summary.md
├── 01-source-app-profile.json
├── 02-risk-inventory.md
├── 03-quest-candidates.json
├── 04-problem-draft.md
└── review-notes.md
```

Allowed content:

- source file paths, route names, data class names, and configuration variable names
- confidence levels and explicit unknowns
- defensive risk statements
- safe simulation plans based on fixtures or generated sandbox resources
- participant-facing missions, hints, and success criteria
- organizer-facing review notes and catalog conversion notes

## Disallowed Outputs

Do not output:

- real exploit chains against a live service
- instructions to steal, replay, or abuse tokens
- payloads aimed at a real third-party service
- production hostnames to test
- commands that create unbounded traffic
- credential values, secret values, API response bodies, request captures, database rows, or raw PII
- wording that declares exploitability when the source profile only shows missing or weak evidence

Use placeholders such as `<redacted>`, `<synthetic-user-a>`, `<synthetic-order-id>`, and `<fixture-only-url>` when examples need concrete-looking structure.

## Secret and Personal Data Handling

Store metadata, never values.

| Data | Allowed | Disallowed |
| --- | --- | --- |
| Secret variable | `OPENAI_API_KEY` variable name, file path, usage summary | actual key value, token prefix, copied `.env` value |
| Personal data | field name such as `email` or `shippingAddress`, classification, evidence path | real email, address, phone, prompt body, user profile row |
| API evidence | route name, handler path, expected status behavior | captured authorization header, live response body, session cookie |
| Database evidence | table name, model name, field names | row values, production dump, customer record |

If an upstream analysis file contains values that look like secrets or personal data, do not copy them forward. Record that unsafe values were present and ask the author to regenerate sanitized analysis.

## Human Review Workflow

Human review is mandatory before any generated draft enters the problem catalog.

1. Confirm authorization and scope.
2. Generate or ingest source analysis.
3. Normalize unknowns, confidence, evidence, and data classes into the source app profile.
4. Review unknowns and assumptions before generating quest candidates.
5. Generate `03-quest-candidates.json`.
6. Review candidates for dangerous wording, attack framing, factual overreach, missing evidence, and unsafe simulation plans.
7. Select exactly one candidate.
8. Convert the selected candidate into `04-problem-draft.md`.
9. Review participant instructions and organizer notes separately.
10. Convert the draft into a safe fixture or sandbox problem.
11. Scaffold catalog files with `bun run scripts/tenkacloud-problem.ts create <id> --kind <kind>`.
12. Run normal problem validation and PR review before publication.

At no point should the workflow bulk-publish multiple candidates or skip directly from analysis to `problems/`.

## Review Checklist

Before catalog conversion, the problem author must confirm:

- [ ] The author owns or is authorized to analyze the source application.
- [ ] No production URL probing is required.
- [ ] No secret values, tokens, cookies, API responses, request captures, database rows, or raw PII are stored.
- [ ] Unknowns and low-confidence claims remain explicit.
- [ ] The learner mission is defensive: understand, fix, recover, monitor, or verify.
- [ ] The draft avoids exploit, intrusion, persistence, exfiltration, evasion, and bypass instructions.
- [ ] The simulation plan uses local fixtures, synthetic users, generated sandbox resources, or bounded probes.
- [ ] Participant-facing instructions are separated from organizer notes.
- [ ] `manual-review` candidates are converted to a supported scoring kind before catalog publication.
- [ ] The final problem remains `status: "draft"` until normal review passes.

## Expression Rules

Prefer:

- "The evidence does not show a server-side owner check."
- "The fixture should verify that another synthetic user's resource returns `403` or `404`."
- "The learner adds defensive validation and verifies it with bounded synthetic requests."
- "This needs human review because confidence is low."

Avoid:

- "Exploit this route."
- "Bypass the UI."
- "Steal another user's token."
- "Probe the production endpoint."
- "This is definitely vulnerable" when evidence is incomplete.

Frame every quest as defensive work. The participant should understand consequence and remediation without receiving instructions for attacking a real app.

## Stop Conditions

Stop and ask for human input when:

- authorization is unclear
- source analysis includes actual secret or personal data values
- the candidate needs production probing to validate
- the only scoring plan requires active exploitation of a live service
- generated wording starts to describe evasion, persistence, exfiltration, or bypass techniques
- the selected candidate cannot be converted to a synthetic fixture or bounded sandbox scenario

## Integration Points

Use this safety reference at every App-to-Quest phase:

| Phase | Required safety check |
| --- | --- |
| Codewiki adapter | Sanitize analysis, preserve unknowns, and store evidence paths rather than values. |
| Source app profile | Classify data and keep confidence explicit. |
| Risk-to-quest mapping | Generate only defensive candidates and cap output to 10. |
| Candidate-to-draft mapping | Separate participant instructions from organizer notes and require one selected candidate. |
| Catalog conversion | Scaffold one reviewed problem, keep status `draft`, and run normal validation. |

Future product UI promotion remains blocked until this workflow is followed consistently and source retention, credential handling, and deletion behavior are implemented outside the authoring prototype.
