# Candidate-to-Draft Mapping

This reference defines how App-to-Quest turns one reviewed QuestCandidate into a problem draft Markdown file that a human author can later move into the TenkaCloud problem catalog.

This step still belongs to authoring. It does not write `problems/<category>/<id>/metadata.json`, does not write `template.yaml`, and does not publish the draft. The output is a reviewable Markdown design packet.

## Inputs

Read:

```text
.claude/drafts/app-to-quest/<app-slug>/01-source-app-profile.json
.claude/drafts/app-to-quest/<app-slug>/03-quest-candidates.json
```

The author must select exactly one candidate from `03-quest-candidates.json` before this mapping runs. Generate a draft only for that selected candidate.

Required context:

| Input | Use |
| --- | --- |
| selected `QuestCandidate` | Main source for scenario, mission, success criteria, scoring plan, hints, and safety notes. |
| `source-app-profile.summary` | Context for the application overview. |
| `source-app-profile.actors` | Participant role assumptions and organizer review notes. |
| `source-app-profile.entrypoints` | Candidate route, endpoint, webhook, job, or admin surface references. |
| `source-app-profile.dataInventory` | Data classes involved in the scenario. |
| `source-app-profile.unknowns` | Open questions that must remain in organizer notes. |
| target event level | Draft difficulty, expected duration, and amount of scaffolding. |
| requested problem type | Challenge, Battle, Workshop, or Assessment. |

## Output

Write one Markdown file for the selected candidate:

```text
.claude/drafts/app-to-quest/<app-slug>/problem-drafts/quest-###-<candidate-id>.md
```

Use [`problem-draft.md`](./problem-draft.md) as the exact section skeleton. The draft must be detailed enough for a human author to turn it into a normal TenkaCloud problem, but it must remain separate from the catalog until reviewed.

## Required Sections

The draft must include these sections in this order:

1. `Source App Context`
2. `Why This Matters`
3. `What Happens If Ignored`
4. `Mission`
5. `Initial Broken State`
6. `Target Fixed State`
7. `Success Criteria`
8. `Scoring Design`
9. `Safe Simulation Plan`
10. `Hints`
11. `Organizer Notes`
12. `Safety Notes`
13. `Catalog Conversion Checklist`

Do not merge participant-facing instructions with organizer-only notes. Participants should receive the mission, constraints, hints, and success criteria. Organizers should receive source evidence, unknowns, scoring assumptions, fixture requirements, and safety review notes.

## Field Mapping

| QuestCandidate field | Draft section | Rule |
| --- | --- | --- |
| `title` | H1 and `Source App Context` | Keep human-readable. Avoid exploit-focused titles. |
| `category` | `Source App Context` and `Organizer Notes` | Explain the learning theme, not just the risk label. |
| `severity` | `Organizer Notes` | Use for author prioritization. Do not turn severity into scare copy for participants. |
| `sourceEvidence` | `Organizer Notes` | Preserve file paths and route names. Do not include secret values, database rows, or API response bodies. |
| `riskStatement` | `Source App Context` and `Initial Broken State` | Convert to a defensive scenario. Keep uncertainty explicit. |
| `businessImpact` | `Why This Matters` | Explain why the scenario matters to operators and builders. |
| `whatHappensIfIgnored` | `What Happens If Ignored` | Required verbatim or lightly edited for clarity. |
| `learnerExperience` | `Mission` | Explain what the participant will do during the quest. |
| `mission` | `Mission` and `Target Fixed State` | Convert to imperative instructions. |
| `successCriteria` | `Success Criteria`, `Scoring Design`, and `Target Fixed State` | Every criterion must be observable, reviewable, or scorable. |
| `scoringSignals` | `Scoring Design` | Convert to concrete probes, flags, counters, or manual review checks. |
| `safeSimulationPlan` | `Initial Broken State`, `Safe Simulation Plan`, `Scoring Design`, and `Safety Notes` | Keep the simulation local, synthetic, bounded, and non-production. |
| `remediationHints` | `Hints` and `Organizer Notes` | Hints are short nudges. Organizer notes can include implementation guidance. |
| `suggestedProblemType` | `Source App Context` and `Catalog Conversion Checklist` | Map `challenge` to Challenge, `battle` to Battle, and keep `assessment` or `workshop` as authoring-only until converted. |
| `suggestedScoringKind` | `Scoring Design` and `Catalog Conversion Checklist` | `manual-review` must be converted before catalog publication. |
| `confidence` | `Organizer Notes` | Low confidence requires explicit review questions. |

## Scoring Design Requirements

The `Scoring Design` section must be specific enough that a problem author can build the scoring assets.

For each `suggestedScoringKind`:

| Kind | Draft must include |
| --- | --- |
| `flag` | The condition that reveals or produces the flag, the CloudFormation output key to plan for, and at least one negative check. |
| `uptime-flat` | The endpoint slot, expected healthy status, probe path, and failure behavior. |
| `uptime-multi` | Each endpoint slot, the all-ok condition, and the failure penalty or no-score behavior. |
| `phased-polling` | Each phase, trigger timing, expected response per phase, and rollback or recovery expectation. |
| `attack-detection` | Synthetic event source, counter output key, bounded event volume, and detection success criteria. |
| `manual-review` | The exact human checks and what must change before formal catalog conversion. |

Success criteria must be concrete. Prefer statements like:

- Own synthetic resource returns success.
- Other synthetic user's resource returns `403` or `404`.
- Health endpoint returns success for all required components.
- Detection counter increments for bounded synthetic events.
- Secret-like placeholders are absent from client-visible output.

Avoid criteria like:

- "Improve security."
- "Make the app safe."
- "Add best practices."
- "Fix everything related to auth."

## Initial and Target States

`Initial Broken State` should describe the intentionally vulnerable, unreliable, or incomplete state that a problem fixture would provide. It must be safe and synthetic.

`Target Fixed State` should describe the minimum acceptable learner result. It must map back to `successCriteria` and `scoringSignals`.

Do not require learners to attack a live service to see the broken state. Use local fixtures, generated TenkaCloud resources, synthetic users, synthetic events, static code inspection, or bounded probes.

## Hints

Hints should help the participant progress without giving away the full answer. Use three levels:

1. orientation hint
2. implementation hint
3. verification hint

Organizer notes can include the intended fix path, common mistakes, and synthetic-fixture verification guidance. They still must not include real-service exploitation steps or secret values.

## Safety Rules

Do not include:

- production URLs to test
- real credentials, tokens, API responses, request captures, or database rows
- instructions to bypass WAF, monitoring, rate limits, or detection
- commands that create unbounded traffic
- payloads intended for a real third-party service
- claims that a vulnerability is exploitable when evidence is low confidence

Use neutral defensive language. The draft teaches how to recognize impact, build a safe fixture, and verify a fix.

## Manual Catalog Conversion

The draft is not a catalog entry. A human author must later:

1. Choose a supported TenkaCloud category: `Battle` or `Challenge`.
2. Choose a supported scoring kind from the existing six.
3. Run `bun run scripts/tenkacloud-problem.ts create <id> --kind <kind>`.
4. Move participant-facing text into `metadata.json`.
5. Build `template.yaml` with safe synthetic resources.
6. Add portal components only when the problem needs custom participant UI.
7. Run `make validate-problems`.
8. Run `bun run scripts/tenkacloud-problem.ts validate <id>`.

If `suggestedProblemType` is `workshop` or `assessment`, convert it to a Challenge or Battle before catalog publication, or keep it as a non-catalog authoring artifact.

## App-to-Quest Mode Integration

The `app-to-quest` mode should read this file after the author selects one candidate. It should write `problem-drafts/quest-###-<candidate-id>.md`, show the draft path, copy `review-checklist.md`, and stop for human review before writing catalog files.
