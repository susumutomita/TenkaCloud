# App-to-Quest Review Checklist

Complete this checklist before converting any App-to-Quest draft into a formal TenkaCloud problem.

## Authorization

- [ ] The author owns or is authorized to analyze the source application.
- [ ] The input files are local or explicitly provided by the author.
- [ ] No external repository was cloned without explicit author instruction.
- [ ] No production URL probing or active scanning is required.

## Data Handling

- [ ] No secret values, tokens, cookies, API responses, request captures, database rows, or raw PII are stored.
- [ ] Secret and personal data references are metadata only: variable names, field names, file paths, classifications, or summaries.
- [ ] Upstream unsafe values were redacted or the author was asked to regenerate sanitized analysis.
- [ ] `unknown` values were not filled with guesses.

## Candidate Quality

- [ ] Each candidate has concrete source evidence or remains clearly low confidence.
- [ ] `whatHappensIfIgnored` is realistic and not alarmist.
- [ ] The learner mission is defensive: understand, fix, recover, monitor, or verify.
- [ ] The draft avoids exploit, intrusion, persistence, exfiltration, evasion, and bypass instructions.
- [ ] The safe simulation plan uses local fixtures, synthetic users, generated sandbox resources, bounded probes, or static inspection.

## Scoring and Catalog Conversion

- [ ] Success criteria are observable, reviewable, or scorable.
- [ ] A supported TenkaCloud scoring kind is chosen before catalog publication.
- [ ] `manual-review` candidates are converted to `flag`, `uptime-flat`, `uptime-multi`, `phased-polling`, or `attack-detection`, or left outside the catalog.
- [ ] Participant-facing instructions are separated from organizer notes.
- [ ] The final problem remains `status: "draft"` until normal review passes.
- [ ] `make validate-problems` and `bun run scripts/tenkacloud-problem.ts validate <id>` pass after formal catalog conversion.
