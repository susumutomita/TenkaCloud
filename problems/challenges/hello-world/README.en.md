# Hello World (Sample)

> 日本語版: [README.md](./README.md)

The **minimal sample** for Challenge / flag submission. Read a value from SSM Parameter Store, paste it into the Participant Portal, and earn +100 pt. Use it as a sanity check for the deploy → flag-submit → score path end-to-end.

| Field          | Value                                                       |
| -------------- | ----------------------------------------------------------- |
| Category       | Challenge (self-paced)                                      |
| Difficulty     | 1 / 5 (beginner)                                            |
| Estimated time | 1 min                                                       |
| status         | `ready`                                                     |
| Scoring        | `flag` (`points`: 100, `wrongAnswerPenalty`: 5)             |

## Story

Welcome to TenkaCloud Inc. Today is your first day. Your predecessor SRE, Kato-san, abruptly resigned last week and left a single mysterious SSM Parameter in production.

Sasaki-san, the CTO, says: "I think he left it for smoke testing... probably." Details unknown. Searching Slack DMs turns up nothing. The Notion handover note just says: "look at SSM `hello`."

Your mission: open AWS Console or CLI, read the value at `/{NamePrefix}/hello`, and paste it into the Participant Portal flag-submission box. Correct match → +100 pt.

The canonical worldbuilding lives in [`docs/lore/world.html`](../../../docs/lore/world.html).

## What gets deployed

- `AWS::SSM::Parameter` (`/{NamePrefix}/hello`, Standard tier, value `Hello from {NamePrefix}`)
- `ParticipantViewerRole` — IAM Role competitors AssumeRole into for read-only AWS Console access
  - `ssm:GetParameter` / `GetParameters` / `GetParametersByPath` scoped **only to their own prefix**
  - `cloudformation:DescribeStacks` etc. scoped **only to their own stack**
  - Cannot peek at other tenants' parameters / stacks (ADR-021)

No EC2 / VPC / public endpoint is created. SSM Standard tier is free.

## How to solve

```bash
# Via CLI
aws ssm get-parameter --name /{NamePrefix}/hello --query Parameter.Value --output text
# → "Hello from {NamePrefix}"
```

Or click through to the Parameter Store detail page in AWS Console — the deep link is published as the `ParameterConsoleUrl` output in [`template.yaml`](./template.yaml) and exposed to competitors via the Participant Portal.

> The Parameter Store **list** page in Console requires `ssm:DescribeParameters`, which `ParticipantViewerRole` intentionally lacks to prevent cross-tenant leakage (ADR-021). Listing from the console is deliberately blocked, so use the deep link from the Portal.

Paste the value into the Participant Portal flag submission box and submit. Correct → +100 pt. Wrong → -5 pt.

## Hints (cost score if used)

| hint   | Content                                                                                                            | Penalty |
| ------ | ------------------------------------------------------------------------------------------------------------------ | ------- |
| hint-1 | Read the value via AWS Console (SSM Parameter Store) or `aws ssm get-parameter --name /{NamePrefix}/hello`.        | -10     |
| hint-2 | The value follows the form `Hello from tc-...` and includes the stack-name prefix (= the value of NamePrefix).     | -20     |

## Scoring

| State                         | Score |
| ----------------------------- | ----- |
| Correct (= value matches)     | +100  |
| Wrong                         | -5    |

## Learning goals

- Experience reading a value from SSM Parameter Store via AWS Console / CLI.
- Verify that TenkaCloud's deploy → flag-submit → score pipeline works end-to-end.

## Related files

- [`metadata.json`](./metadata.json) — problem metadata
- [`template.yaml`](./template.yaml) — one-page CFn template (SSM Parameter + a scoped IAM Role only)
