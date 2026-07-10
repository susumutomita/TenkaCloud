# Issue 2191 — writeup release plan

> **Status: Shipped** — delivered in PR #2338; #2191 closed 2026-07-03. Kept as
> a historical plan document.

## Policy

- Cloud events: release a writeup only when the event gate is `scoring_ended` and the team has
  completed that problem.
- Local drill mode: release a writeup immediately after the whole problem is completed.
- Keep spoiler-bearing writeups out of participant API responses until release. Store the cloud
  copy only in the participant backend Lambda bundle, not in the participant SPA catalog.
- Require Japanese and English writeups as a pair.

## Delivery

1. Extend the challenge metadata schema and author bilingual SQL injection and IDOR explanations.
2. Discover bilingual writeups at synth time and inject them only into the participant backend.
3. Apply the event-ended and solved guards before constructing the participant wire response.
4. Apply the solved guard in local play.
5. Render only API-provided writeups and verify hidden/released states with regression tests.
