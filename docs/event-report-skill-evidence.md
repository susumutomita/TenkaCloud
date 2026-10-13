# Event Report Skill Evidence

Event Report adds narrow observations for a team, alongside the existing scores,
ranking and problem breakdown. It does not issue individual credentials or infer
skills from total points, deployments, learning goals or participation.

The declaration contract is TenkaCloudChallenge #906, including the endpoint label
correction in #911. The platform accepts single `flag`/`verify` accepted answers
and successful `uptime`/`uptime-flat`/`uptime-multi` observations. Other scoring
kinds, including multi-checkpoint and coordination, remain unassessed.

## Event identity and retained evidence

Local hosting stores an allowlisted declaration and the scoring kind on the event
when it captures the problem. Its SHA-256 identity covers the exact metadata and
runtime definition snapshot. Cloud hosting includes the public declarations in its
existing immutable execution catalog and copies them into the event at creation.
The cloud identity is the existing catalog content digest. Neither identity is a
Git commit or a new score-event ID. Historical events receive no declaration from
the current catalog, and report reads require no additional S3 access.

Each evidence row includes the existing event, team, problem and deployment job
identifiers, the declared source/result rule, observed timestamps and the snapshot
digest. Retained observations can remain assessable after teardown. Deployment
success or teardown alone is never an observation of the declared skill.

The pure aggregation distinguishes demonstrated, not observed, insufficient
evidence and not assessable. Missing history, invalid timestamps, unrelated jobs,
unknown snapshot identity and unsupported scoring kinds cannot demonstrate a
skill. Retries with the same observed job/time/source/result tuple are deduplicated
without manufacturing an ID. Cloud history reports incompleteness using the
actual DynamoDB continuation cursor, SQL row limits, invalid public rows and the
existing per-team display limit. Score values and ranking calculations remain
unchanged.

## Output and verification

One resolved view feeds the Japanese and English UI, HTML, Markdown and browser
print section. Public fields are reconstructed through an allowlist; grader
configuration, answers, participant keys and hidden checks are excluded. HTML,
React and Markdown escape catalog-controlled text.

Run `make before-commit` and type checks for the modified workspaces. The targeted
unit suites cover source matching, missing data, retries, team separation and
legacy declarations. Cloud contract suites also cover capture, server-owned event
pinning and incomplete history. Local host tests exercise the real scoring paths
with fake AWS transports.

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
