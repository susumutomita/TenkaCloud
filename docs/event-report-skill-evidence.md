# Event Report Skill Evidence

## Design principles

Event Report adds narrow observations for a team, alongside the existing scores,
ranking and problem breakdown. It does not issue individual credentials or infer
skills from total points, deployments, learning goals or participation.

- Evidence must be traceable to existing event, team, problem and observation
  identifiers, declared source/result rules, observed timestamps and catalog
  identity. Do not manufacture identifiers or fill historical declarations from
  the current catalog.
- Missing or incomplete history, invalid timestamps, unrelated jobs, unknown
  catalog identity and unsupported scoring kinds must not demonstrate a skill.
  Distinguish demonstrated, not observed, insufficient evidence and not assessable.
  Deployment success or teardown alone is never an observation of the declared
  skill.
- Keep score values, ranking calculations and the existing problem breakdown
  unchanged.
- Keep Japanese and English UI, HTML, Markdown and browser print results
  consistent.
- Reconstruct public fields through an allowlist. Exclude grader configuration,
  answers, participant keys and hidden checks. Escape catalog-controlled text in
  HTML, React and Markdown.

These are design requirements, not a claim that all implementation limitations
have been resolved.

## Contract and implementation decisions

The declaration contract is
[TenkaCloudChallenge #906](https://github.com/susumutomita/TenkaCloudChallenge/issues/906),
including the endpoint label correction in
[#911](https://github.com/susumutomita/TenkaCloudChallenge/pull/911).

Supported scoring kinds, Local/Cloud snapshot and identity choices, history
retention and completeness, retry deduplication, and dated validation results are
tracked in [Issue #3343](https://github.com/susumutomita/TenkaCloud/issues/3343#issuecomment-6134897686).
The archived PR snapshot and its pending-review notes are historical context,
not a final accepted design.

## Verification

Run `make before-commit` and type checks for the modified workspaces. Verify source
matching, missing data, retries, team separation and legacy declarations. For
Cloud changes, verify capture, server-owned event pinning and incomplete history.
For Local host changes, exercise the real scoring paths with fake AWS transports.

For the built browser output rehearsal:

```sh
bun run build:host
bun run scripts/local-host/tests/skill-evidence-browser-e2e.ts
```

The runner uses an ephemeral local host and an explicitly synthetic event response.
It compares Japanese and English UI, downloaded HTML, rendered Markdown and print
PDF, saving artifacts under `.cache/skill-evidence-review`. Set
`HOST_E2E_ARTIFACT_DIR` to choose a destination, and `HOST_E2E_CHROMIUM` to select an
existing Chromium executable. It does not download a browser or prove a live AWS
run. No live AWS rehearsal, production deployment or merge is performed by these
checks.
