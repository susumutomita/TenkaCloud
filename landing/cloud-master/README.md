# APIの番人。 — 目指せクラウドマスター

Frontend-only survival game at `/cloud-master/`. Protect a synthetic AWS environment:
left swipe or tap to flag, right swipe to allow. Normal cards can also fall through.
Cards show decoded SDK inputs or explicitly different synthetic telemetry, with
resource/purpose/baseline context. No AWS requests, attack execution or backend.

## Decisions, survival and feedback

Three lives. False positives cost one and continue. Dangerous allow/miss costs one
and freezes every card and active time for the actual-item explanation; explicit
acknowledgment resumes. The final mistake explains before results. Normal manual
allow/passive passage earns10 once. Correct detection earns authored game danger
×10; these are not actual AWS severity values. Only correct10-point dangerous hits
receive120ms hitstop. Survival time freezes in hitstop, explanations, explicit and
background pause. Study accumulates no survival time.

Correct manual decisions grow a visual-only combo. Passive normal passage still
scores10 but does not grow combo. Mistakes reset it; no multiplier/speed bonus.
Gesture direction feedback is neutral, not an answer label. Short/diagonal/cancelled
movements return without decision. Pointer capture and a per-pointer click token
prevent compatibility clicks; cancelled gestures cannot commit after a long pause.
Focused ArrowLeft/ArrowRight are equivalents. Enter/tap flags;1–6 selects a card,
P/Escape pauses. Reduced motion preserves text feedback without outgoing motion.

Initial arrivals1.2s, fall12s. Active elapsed time increases pressure independently
of score: at180s new falls5.49s/interval338ms; at300s4.59s/289ms. Asymptotes4.2s/280ms
preserve reading time. No five-level ceiling or mandatory three-minute cutoff;
levels advance every15 active seconds. Human average survival is not measured.
New-object input guard is100ms (previously300ms); resolution removes the object in
the same input handler. Finite arrivals prevent instant-refill score farming.

Every new round gets a crypto random seed; retry can reuse it. Shuffled scenario
bags avoid immediate repeats; each six-outcome bag balances normal/suspicious.
Reserved IP/domain indicators and bounded counts also vary by seed, with visible
baselines updated consistently; address prefixes never encode the answer.
First30s use seven clear parameter cases, from30s the pool broadens, from90s subtle
process/identity/correlation evidence joins. Untimed study has the full pool.
Best survival duration is local-only with storage-unavailable handling. Inspectable
scores/times are casual practice, not certification. X compose requires user action;
posting remains theirs, with copy/selectable-text fallback.

## Playfield and mobile

Active play hides the title, introduction, prose/footer and unused controls. HUD56px;
remaining safe viewport belongs to the field. Portrait uses one column of wide
strips, tall desktop two columns. Payload13px and context11px; no decorative nested
payload boxes. Tall phones show four readable cards, short320×568 shows three,
desktop up to six. Max measured case heights and geometry are checked across every
normal/flag variant. Resizing preserves live objects, time and lives; orientation
pauses/remaps if needed. A field too small for retained cards waits for readable
space instead of silently removing objects or forcing loss of progress.

At1180×757 the field is701px (92.6 percent height), usable card area661px (87.3 percent). Previous
preview was337px/44.5 percent, usable303px/40.0 percent. Native original-WAF audit measured652px/86.1 percent
field height with45pxHUD; that is external recorded evidence, not an executor-side
replay. Original10DOM cards did not mean10 visible: some queued above the viewport.
At390×844 our field788px (93.4 percent), usable752px, four cards in one reading column.
Actual original-mobile comparison and physical iPhone/Safari remain unverified.
Original artwork/text/assets are not copied.

## Public coverage versus exact vendor predicates

Playable: **253 authored scenario families /506 basic normal-versus-flag cases**:
211 standard active finding types,35 published CloudTrail custom signals (25 types),
plus7 runtime custom signals (4 additional types) named in the official Runtime
Monitoring chapter. The21 retired findings remain reference-only. Every retrieved
public active/signal entry is mapped in `guardduty-coverage.json`.

`security-scenarios.js` contains41 SDK/event cases; `evidence-scenarios.js` adds212
safe synthetic evidence cases: CloudTrail history, DNS/network summaries, Kubernetes,
process lineage, file inspection, RDS/S3 audit, AI and multi-event correlation.
Every family has a meaningful benign counterpart and explicit deciding context.
Actual API arguments and synthetic enrichment are separate; ConsoleLogin is a
synthetic CloudTrail event. Non-API observations never pretend to be wire requests.
Required fields/secret/code/certificate contents are omitted or non-executable
placeholders. No packet capture, credentials or actual AWS calls.

All predicates are educational, authored from public descriptions and displayed
exercise assumptions. Numerical thresholds are game baselines, not AWS machine learning thresholds.
Threat indicators are reserved fictional values. File-at-rest detection does not
imply current execution; known IP reputation is supplied evidence, not inferred
from address appearance; single events do not imply an attack sequence. Each
explanation and final review links to the relevant verified official AWS chapter
with an encoded finding/signal text fragment. Docs open only on user action.

**Not reproduced:** exact current region/account-specific SQL, IDs/versions and
private machine learning/correlation internals. Current List/GetCustomDetectionRule export requires
an authorized AWS context; no new authentication is attempted. Coverage is the
retrieved public snapshot plus named runtime rules, not every possible live rule.
GuardDuty produces findings; this does not implement vendor detection or blocking.
Supporting botocore1.43.118 data (435SDK models/19,437operations, pinned digest and
Apache notices) is source data, not learning coverage.

- [Active index](https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_finding-types-active.html)
- [CloudTrail custom signals](https://docs.aws.amazon.com/guardduty/latest/ug/findings-custom-detection-rules.html)
- [Runtime types and named custom signals](https://docs.aws.amazon.com/guardduty/latest/ug/findings-runtime-monitoring.html)
- [Exact-rule availability](https://docs.aws.amazon.com/guardduty/latest/ug/custom-detection-rules-available.html)

```sh
python3 -m http.server 4183 --directory landing
bun test scripts/landing/cloud-master.test.ts scripts/landing/cloud-master-evidence.test.ts
make before-commit
```

Existing Cloudflare Pages branch path and landing output remain. No main merge,
Passport, hosting/access/security settings, tracking or paid services change.
Direct Pages and terminal documentation fetches previously received CONNECT403;
those denied accesses are not retried/bypassed. Source review used available cached
primary excerpts; deployment confirmation and exact-source local browser QA remain
separate. Glass-inspired CSS is original, not native Apple Liquid Glass.
