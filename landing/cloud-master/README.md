# Cloud Master

Japanese frontend-only recognition survival at `/cloud-master/`, linked from the LP.
No accounts, persistence, analytics, packet capture, AWS calls, or game backend.

## Rules and controls

The objective stays fixed throughout a round. Pick any matching card immediately,
including an upper card, by tapping it or pressing its 1–3 slot key.
Each round has three visible lives. A wrong pick costs one life and continues.
A required target reaching the striped line costs one life and freezes every
card and the game clock for an explanation. Explicit acknowledgment resumes play.
The last-life mistake is explained before results. Nonmatches pass harmlessly.

Three cards remain in play. Correct picks give 100 points plus a 20-point chain
increment, capped at a 100-point bonus. Correct picks keep flowing. Misses pause for explanations;
all attempted cards can also be reviewed after the round.
If only nonmatches remain, one is automatically passed after 900 ms to admit
another authored target. No live card is relabeled. New cards have a 300 ms input
guard against a second tap landing on a replacement.

P or Escape pauses. Hidden tabs and an unfocused browser pause until manual resume.
Reduced motion keeps cards stationary while their deadline bars continue.
Untimed practice supports pick/pass decisions with explanations and no game over.
The opening field includes a skippable, tappable demonstration.

New rounds use browser-generated random seeds. The same seed can be retried.
Seeded generation changes order, authored conditions, and synthetic parameters;
it never randomly changes the meaning of an existing question. Distractor
categories rotate before recycling and immediately repeated questions are avoided.
The score is casual practice data, inspectable in the browser, not certification.

## Modes and source semantics

- Foundations: six scenario families, each with five condition/answer variants.
- HTTP: identify plaintext HTTP/1.1 requests among responses and other synthetic
  protocol displays. Port 443 or opaque TLS records do not establish HTTP.
- AWS API: identify EC2 StartInstances with DryRun=false among permission checks,
  stop requests, and describe requests. Cards show decoded Query API parameters,
  not IAM action notation, CloudTrail records, or evidence of execution success.

Protocol cards show up to three lines on the field; review retains the full
synthetic example. AWS always retains the decisive DryRun parameter.
All identifiers and message content are synthetic and non-secret.

Official references used for the authored answer key:

- [HTTP/1.1 request and status lines, RFC 9112](https://www.rfc-editor.org/rfc/rfc9112.html)
- [SMTP EHLO, RFC 5321](https://www.rfc-editor.org/rfc/rfc5321.html#section-4.1.1.1)
- [EC2 StartInstances and DryRun](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_StartInstances.html)
- [EC2 StopInstances](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_StopInstances.html)
- [EC2 DescribeInstances](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeInstances.html)
- [X Web Intents](https://docs.x.com/x-for-websites/web-intents/overview)

X sharing opens a user-triggered native intent with title, mode, score, correct
count, and current game URL. Posting stays in X. Preview URLs are labeled as
previews; localhost uses this PR's existing branch preview. No X SDK or tracking
script is loaded. A copy action and selectable-text fallback work independently.

## Verify and deploy

From the repository root:

```sh
python3 -m http.server 4173 --directory landing
bun test scripts/landing/cloud-master.test.ts
make before-commit
```

Open `http://localhost:4173/cloud-master/`. The static files need no build step.
Use the existing `tenkacloud-www` Cloudflare Pages project, output `landing/`.
Review the same PR branch preview; do not overwrite the full LP with this folder.
Production merge and publication are separate operations.

Browser QA covers clean first views, complete desktop/mobile rounds, early picks,
life loss, paused target misses, benign pass-through, duplicate/stale clicks, pause,
keyboard focus, reduced motion, generated share intents, and copy fallback.
Physical devices and iOS Safari are separate from Chromium touch emulation.
