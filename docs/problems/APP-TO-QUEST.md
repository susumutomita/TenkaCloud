# App-to-Quest Placement and Scope

This is the design memo for App-to-Quest Generator epic #1824. It defines where the first implementation belongs, what it should produce, and when the feature is mature enough to move into the TenkaCloud product UI.

## Decision

The first App-to-Quest implementation belongs in the problem authoring skill, not in the TenkaCloud platform runtime.

The initial entrypoint should be an `app-to-quest` mode in `.claude/skills/create-problem/SKILL.md` or the equivalent natural-language workflow for agents that cannot load Claude Code skills. It should help a problem author turn an owned or authorized application into draft TenkaCloud problem assets:

- `metadata.json`
- `template.yaml`
- optional `portal/` components
- an authoring report that records assumptions, rejected ideas, safety notes, and required human review

The platform should continue to execute only already-authored problem catalog entries. It should not ingest arbitrary GitHub URLs, crawl applications, generate problems, or publish generated drafts from the application UI in the first phase.

## Why the Authoring Skill Owns the First Version

| Reason | Detail |
| --- | --- |
| Faster validation | Problem authors can test the workflow locally without adding UI, job orchestration, account linking, or long-running backend workers. |
| Clear trust boundary | The authoring skill runs in a contributor workspace where the human already controls the source code and generated files. |
| Better review ergonomics | The output is a normal Git diff against `problems/<category>/<id>/`, so reviewers can inspect every generated artifact before it reaches the catalog. |
| Lower platform risk | The product runtime avoids accepting arbitrary source locations, credentials, or large repository payloads. |
| Fits existing authoring flow | The current `/create-problem` skill already asks for problem goals, scoring kind, scaffold generation, validation, sandbox deploy, and PR body details. |

## Why the Platform UI Does Not Own the First Version

Putting App-to-Quest directly into the product UI would require several unrelated product commitments at once:

- user authentication and authorization for repository access
- external GitHub integration and token storage
- background job orchestration for repository analysis
- source retention and deletion rules
- security review for generated attack-like language
- safe publication workflow from generated draft to problem catalog
- operator-facing error recovery for incomplete or ambiguous analysis

Those requirements are real, but they are not needed to learn whether App-to-Quest produces useful problem drafts. The product UI should wait until the authoring workflow has stable input and output contracts.

## Initial Scope

The skill-centered version should do the following:

1. Ask the author to confirm they own or have permission to analyze the target application.
2. Ingest a local fixture, local repository checkout, or precomputed analysis file.
3. Normalize the input into a source app profile.
4. Identify reliability, security, deployment, and operations risks that can be turned into defensive or recovery-focused quests.
5. Map risks to TenkaCloud scoring kinds and problem templates.
6. Generate one or more problem draft candidates.
7. Ask the author to select exactly one candidate before writing catalog files.
8. Scaffold the draft through the existing problem CLI conventions.
9. Record assumptions, missing evidence, rejected unsafe ideas, and human review notes.
10. Stop before publication and require the author to review the generated diff.

The first version should prefer local fixtures and explicit analysis files over remote repository crawling. That keeps the proof of value inside the existing contributor workflow.

## Later Scope

Later work can add:

- adapters for specific analysis formats such as `codewiki analysis.json`
- richer source app profile fields
- risk-to-quest mapping rules
- multiple draft candidates with scoring estimates
- automatic portal component suggestions
- reusable authoring reports
- a Raycast or CLI command that wraps the skill flow

These are still authoring features. They do not require a TenkaCloud product UI until the workflow is stable and safe.

## Candidate Skill Flow

An `app-to-quest` mode should guide the author through these prompts:

1. **Authorization check.** Is this your application or do you have permission to analyze it?
2. **Input source.** Is the input a local fixture, local repository, or analysis JSON file?
3. **Application summary.** What does the app do, and which parts are in scope?
4. **Risk focus.** Should the quest emphasize security, reliability, migration, observability, incident response, or deployment safety?
5. **Quest candidates.** Review 3-5 candidates with scoring kind, learning goal, safety notes, and required infrastructure.
6. **Selection.** Pick one candidate; do not scaffold multiple catalog entries in one pass.
7. **Scaffold.** Generate `metadata.json` and `template.yaml` using the existing `tenkacloud-problem.ts create` conventions.
8. **Review stop.** Show the authoring report and require human review before validation and PR work.

## Entrypoint Sketch

For Claude Code, the authoring skill can expose this as:

```text
/create-problem app-to-quest
```

For Codex CLI or another agent that cannot invoke `.claude/skills/`, use equivalent natural language:

```text
Use the App-to-Quest authoring workflow for this local fixture or analysis file.
Confirm authorization, normalize it into a source app profile, propose safe defensive quest candidates,
and stop for human review before writing one selected problem draft.
```

Both entrypoints should produce the same authoring report and should stop before publication.

## Output Contract

Generated drafts should follow the existing 3-asset model from ADR-012:

```
problems/<category>/<id>/
├── metadata.json
├── template.yaml
└── portal/
```

The draft may also include an author-only note such as `README.md` when the generated design needs assumptions, review notes, or local fixture instructions. Participant-facing instructions should remain in `metadata.json` and optional portal components.

The source application analysis should first normalize into [`source-app-profile.schema.json`](./source-app-profile.schema.json). That schema preserves app summary, actors, data inventory, auth boundaries, public and admin entrypoints, external services, AI data flows, deployment assumptions, operational signals, cost-sensitive paths, evidence, confidence, and explicit unknowns.

## Platform Contract

The platform runtime should stay simple:

- It reads problem catalog entries that already passed review.
- It deploys the referenced `template.yaml` into competitor accounts.
- It evaluates the declared scoring kind.
- It renders declared participant portal slots.

The platform should not need to know whether a problem started from a human brief, a local fixture, an analysis file, or a future App-to-Quest adapter.

## Promotion Criteria for Product UI

App-to-Quest can move from authoring skill to product UI only after these conditions are true:

- the source app profile schema is stable enough for multiple application types
- at least two analysis adapters have been validated against local fixtures
- risk-to-quest mapping rules produce useful candidates without generating attack instructions
- generated drafts consistently pass problem validation after normal author edits
- the human review workflow is documented and followed
- source retention, credential handling, and deletion rules are defined
- background job progress and failure states are understood
- there is a clear user who benefits from in-product generation rather than local authoring

Until then, the platform should import reviewed problems, not generate them.

## References

- Epic: #1824
- Follow-up safety workflow: #1830
- Safety and human review reference: [`../../.claude/skills/create-problem/references/app-to-quest/safety-and-review.md`](../../.claude/skills/create-problem/references/app-to-quest/safety-and-review.md)
- Existing authoring skill: `.claude/skills/create-problem/SKILL.md`
- AI authoring workflow: [`AI-WORKFLOW.md`](./AI-WORKFLOW.md)
- Problem authoring guide: [`AUTHORING.html`](./AUTHORING.html)
- Problem plugin architecture: [`../architecture/adr-012-problem-plugin-architecture.html`](../architecture/adr-012-problem-plugin-architecture.html)
