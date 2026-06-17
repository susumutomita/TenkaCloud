# Quest: <candidate title>

## Problem Overview

- Source app: `<app-slug>`
- Suggested problem type: `<Challenge|Battle|Workshop|Assessment>`
- Suggested scoring kind: `<flag|uptime-flat|uptime-multi|phased-polling|attack-detection|manual-review>`
- Target event level: `<introductory|intermediate|advanced|expert>`
- Estimated duration: `<30-60 minutes|60-90 minutes|custom>`

<Short explanation of what the app does, why this quest matters, and which defensive skill the participant will practice. Include the business impact without using alarmist language.>

## Participant Instructions

You are given a synthetic fixture based on the source application's risk pattern. Your mission is:

> <candidate mission>

Work only against the provided fixture and generated TenkaCloud resources. Do not test production URLs or real third-party services.

## Risk Scenario

<Defensive scenario derived from candidate.riskStatement. Preserve uncertainty when confidence is low. Mention relevant route, data class, actor, or operation without including secret values or real data.>

## What Happens If Ignored

<candidate.whatHappensIfIgnored>

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

## Scoring Plan

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

## Hints

1. <Orientation hint>
2. <Implementation hint>
3. <Verification hint>

## Remediation Guide

<Organizer-facing implementation guidance. Explain the intended fix path, common mistakes, and how to verify the fix in the synthetic fixture. Do not include real-service attack steps or secret values.>

## Organizer Notes

- Category: `<candidate.category>`
- Severity: `<candidate.severity>`
- Confidence: `<candidate.confidence>`
- Source evidence:
  - `<sourceEvidence item>`
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
- [ ] Run `make validate-problems`.
- [ ] Run `bun run scripts/tenkacloud-problem.ts validate <id>`.
