# Quest: <candidate title>

## Source App Context

- Source app: `<app-slug>`
- Suggested problem type: `<Challenge|Battle|Workshop|Assessment>`
- Suggested scoring kind: `<flag|uptime-flat|uptime-multi|phased-polling|attack-detection|manual-review>`
- Target event level: `<introductory|intermediate|advanced|expert>`
- Estimated duration: `<30-60 minutes|60-90 minutes|custom>`
- Source evidence:
  - `<sourceEvidence path or name>`

<Short explanation of what the app does and which defensive skill the participant will practice. Preserve uncertainty when confidence is low.>

## Why This Matters

<Explain the business, user, reliability, privacy, cost, or operations impact without alarmist language.>

## What Happens If Ignored

<candidate.whatHappensIfIgnored>

## Mission

You are given a synthetic fixture based on the source application's risk pattern.

> <candidate mission>

Work only against the provided fixture and generated TenkaCloud resources. Do not test production URLs or real third-party services.

## Initial Broken State

- Affected surface: `<route|endpoint|job|admin action|data flow>`
- Data or service involved: `<personal|sensitive|secret|operational|cost-sensitive|reliability-critical>`
- Broken behavior: `<safe synthetic description>`
- Evidence source: `<sourceEvidence paths or names>`

<Describe the safe fixture state the participant starts from. It must be synthetic, bounded, and reproducible.>

## Target Fixed State

The quest is complete when:

- <success criterion 1>
- <success criterion 2>
- <success criterion 3>

<Map every criterion to an observable behavior, output, endpoint response, counter, or manual review check.>

## Success Criteria

- <observable criterion 1>
- <observable criterion 2>
- <negative check that must fail safely or remain absent>

## Scoring Design

- Scoring kind: `<candidate.suggestedScoringKind>`
- Scoring signals:
  - `<signal 1>`
  - `<signal 2>`
- Planned CloudFormation outputs:
  - `<OutputKey>`: `<purpose>`
- Probe or review method:
  - `<bounded probe, flag comparison, phased check, counter check, or manual review>`
- Negative checks:
  - `<what must fail safely or remain absent>`

If the suggested scoring kind is `manual-review`, list the exact checks that must be converted into a supported scoring kind before publication.

## Safe Simulation Plan

<Describe the local fixture, synthetic users, mock provider, generated sandbox resource, bounded event source, or static inspection path. Do not require production probing.>

## Hints

1. <Orientation hint>
2. <Implementation hint>
3. <Verification hint>

## Organizer Notes

- Category: `<candidate.category>`
- Severity: `<candidate.severity>`
- Confidence: `<candidate.confidence>`
- Open questions:
  - `<source profile unknown or candidate unknown>`
- Fixture requirements:
  - `<synthetic users, fake records, mock provider, bounded event source, etc.>`
- Catalog conversion notes:
  - `<Challenge/Battle mapping, template resources, portal slots, metadata fields>`

## Safety Notes

- Use synthetic data only.
- Do not include production URLs.
- Do not store secret values, API responses, request captures, or database rows.
- Do not require unbounded traffic or real third-party API calls.
- Keep low-confidence claims framed as review questions.

## Catalog Conversion Checklist

- [ ] Choose final `Battle` or `Challenge` category.
- [ ] Convert `manual-review` to a supported scoring kind if needed.
- [ ] Run `bun run scripts/tenkacloud-problem.ts create <id> --kind <kind>`.
- [ ] Move participant-facing text into `metadata.json`.
- [ ] Build `template.yaml` with safe synthetic resources.
- [ ] Add portal components only when needed.
- [ ] Keep `metadata.status` as `draft` until normal review passes.
- [ ] Run `make validate-problems`.
- [ ] Run `bun run scripts/tenkacloud-problem.ts validate <id>`.
