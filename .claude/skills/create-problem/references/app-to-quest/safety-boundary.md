# App-to-Quest Safety Boundary

This is the short safety contract for App-to-Quest mode. The fuller workflow lives in [`safety-and-review.md`](./safety-and-review.md), and the checklist to copy into drafts lives in [`review-checklist.md`](./review-checklist.md).

## Allowed Inputs

- repositories, fixtures, or analysis files the author owns or is explicitly authorized to inspect
- local source checkouts
- precomputed CodeWiki analysis such as `.codewiki/app-to-quest/analysis.json`
- sanitized docs, README files, package manifests, and local CodeWiki output
- synthetic users, data, and sandbox resources

## Prohibited Actions

- do not run active scans against deployed systems
- do not probe production URLs
- do not clone external repositories unless the author explicitly asks for that local action and confirms authorization
- do not generate real-service attack, intrusion, persistence, exfiltration, evasion, WAF bypass, or detection bypass instructions
- do not store secret values, tokens, cookies, API response bodies, request captures, database rows, or raw PII
- do not convert missing evidence into confident vulnerability claims
- do not write directly to `problems/`
- do not mark generated catalog entries as `ready`

## Required Output Boundary

All App-to-Quest output stays under:

```text
.claude/drafts/app-to-quest/<app-slug>/
```

Catalog conversion is a separate human-reviewed step that uses the normal problem scaffold command:

```bash
bun run scripts/tenkacloud-problem.ts create <id> --kind <kind>
```

## Stop Conditions

Stop and ask for human input when:

- authorization is unclear
- source analysis includes actual secret or personal data values
- the candidate needs production probing to validate
- the only scoring plan requires active exploitation of a live service
- generated wording describes evasion, persistence, exfiltration, or bypass techniques
- the selected candidate cannot become a synthetic fixture or bounded sandbox scenario
