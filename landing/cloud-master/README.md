# APIの番人。 — 目指せクラウドマスター

Frontend-only survival game at `/cloud-master/`. Protect a synthetic AWS environment:
tap dangerous requests; let normal cards fall untouched. There is one survival mode.
Cards show decoded SDK inputs or explicitly different synthetic telemetry, with
resource/purpose/baseline context. No AWS requests, attack execution or backend.

## Decisions, survival and feedback

Three lives. Every false positive or dangerous miss costs exactly one and immediately
freezes every card and active time for the actual-item explanation; explicit
the Continue button resumes. The final mistake explains before results. Simultaneous deadlines stop at the first miss; already-due untouched dangerous cards get a1500ms decision window after acknowledgment, without resetting their original positions or identity. Normal passive passage earns10 once. Correct detection earns authored game danger
×10; these are not actual AWS severity values. Only correct10-point dangerous hits
receive120ms hitstop. Survival time freezes in hitstop, explanations, explicit and
background pause. The survival display, result, best and share use tenths of a second; HUD text changes only when its value changes.

Short score reactions use a clipped layer at the top of the playfield, below request text, so they cannot overlap HUD values or controls. Correct detection taps grow a visual-only combo. Passive normal passage still scores10 but does not grow combo. Mistakes reset it; no multiplier/speed bonus. Correct taps show a brief deflection, confirmation and actual-value reason without stopping play (except the specified120ms10-point hitstop). The latest short reason appears for2seconds at the bottom, behind the request layer, without taking field space. The actual value has its own wrapping element; only the field label can be elided. Account-root ARNs show their exact12-digit account, and AWS-managed policy ARNs show the policy name; full original values stay in explanation/review. Full explanation and official links remain in review. API-case summaries are authored separately for benign and dangerous values; predicate labels distinguish request inputs from attached change-ticket/hash evidence.
Movement over10px or pointer cancellation cancels the tap; it never flags/allows via a swipe. Enter/Space and1–6 are equivalent accessible detection controls; P/Escape pauses. Reduced motion keeps textual confirmation without deflection.

Initial fall12s. Visible capacity paces admissions evenly instead of filling the field and waiting for expiry. Actual interval is the larger of the stage minimum and fall time divided by capacity:390×844 uses5slots/2.4s initially,375×667 uses4/3s, and desktop6/2s. Existing cards keep their deadlines. Discrete active-time levels apply to NEW cards; existing cards retain their birth/deadline. The compact survival caption shows level and a nonblocking1.2-second LEVEL UP accent. No transition pauses, input lock or card reset.

| Active time | Level | New-card fall | Minimum interval | Pool |
| --- | --- | --- | --- | --- |
|0s|1|12s|1.2s|Seven clear parameter cases|
|20s|2|10.5s|1s|More direct SDK parameter cases|
|40s|3|9s|850ms|Identity/context and CloudTrail/S3 observations|
|60s|4|7.8s|700ms|DNS/network evidence joins|
|90s|5|6.8s|560ms|All253 authored families|
|120s|6|6s|440ms|All families, bounded subtle numeric contrasts|
|150s|7|5.4s|360ms|All families|
|180s|8|5s|320ms|All families|

After180s, levels continue every30active seconds, reducing fall by300ms and interval by10ms until readable floors4.2s/280ms. Three minutes is a hard-survival tuning target, not a cutoff or a measured human average. Scores do not drive levels. New-object input guard remains100ms; finite arrivals prevent instant refill.

The browser uses tickFrame: existing deadlines/pass scoring advance through a long frame, but only one NEW request can be admitted at the rendered update's current time. No retroactive unseen card batch is dumped after a delayed frame. Next admission is scheduled from that visible birth. tick remains the deterministic offline event simulation used by partition-invariance tests; production frame admission has separate regression tests.

Every new round gets a crypto random seed; retry can reuse it. Shuffled scenario
bags avoid adjacent scenario repeats; the same scenario/outcome is also excluded while active and for8seconds after completion. Each six-outcome bag balances normal/suspicious. If no fresh candidate exists, admission waits without consuming an answer or fabricating a replacement.
Reserved IP/domain indicators and bounded counts also vary by seed, with visible
baselines updated consistently; address prefixes never encode the answer.
Best survival duration is local-only with storage-unavailable handling. Inspectable
scores/times are casual practice, not certification. X compose requires user action;
posting remains theirs, with copy/selectable-text fallback.

## Playfield and mobile

Active play hides the title, introduction, prose/footer and unused controls. HUD56px;
remaining safe viewport belongs to the field. Portrait uses one column of wide
strips, tall desktop two columns. Payload13px and context11px; no decorative nested
payload boxes. Capacity uses a132px card budget (148px at widths≤350px, including keyboard cues) and16px gaps, capped at six:390×844 fits five,375×667 four,320×568 three, desktop up to six. Max measured case heights and geometry are checked across every
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
bun test scripts/landing/cloud-master*.test.ts
make before-commit
```

Existing Cloudflare Pages branch path and landing output remain. No main merge,
Passport, hosting/access/security settings, tracking or paid services change.
Direct Pages and terminal documentation fetches previously received CONNECT403;
those denied accesses are not retried/bypassed. Source review used available cached
primary excerpts; deployment confirmation and exact-source local browser QA remain
separate. Glass-inspired CSS is original, not native Apple Liquid Glass.

## Motion and profiling

Cards retain their DOM node and compositor transform. Dimensions are read as one batch only after membership/size changes. New arrivals queue above a lane instead of pushing existing cards or subtracting a global overflow. Recovery after a removal is continuous and reaches the physical boundary by the logical expiry. Hidden queued cards cannot be selected by pointer or numeric keyboard controls. HUD strings are written only when changed; the survival clock changes at completed0.1-second boundaries. Scenario/catalog tier indexes are prepared before animation begins.

A controlled390×844 Chromium CPU4× run with16 actual births (effects excluded) measured layout count2629→253 and layout duration2.916→0.289 seconds. Spawn-near frame interval p95 was33.3→16.7ms. In a separate16ms rectangle sample, adding a new card moved existing cards by up to29.47px before and0.93px after (ordinary trajectory progress). Total sample wall times differed (~23.9/~22.2s); this is a synthetic comparison, not an iPhone benchmark or a guarantee of no dropped frames. Worst-frame outliers and startup long tasks remain. No font/image downloads occurred during play; resources were local module/CSS/favicon startup loads. Traces and harness accompany the review artifact. The original public-source audit was supplied by the native researcher; the denied original URL was not bypassed from this executor.

The user's permanent bottom freeze was not reproduced in the tested cases. Global lane clamping was a confirmed old source behavior and a plausible conditional cause, not proven as the sole cause of the reported screenshot. Tests cover normal-only high-pressure passage, exactly-once boundary scoring, mixed streams beyond3minutes, explicit pauses, pointer cancellation and viewport changes.800ms resume grace is intentionally retained after a missed-card explanation to avoid an immediate follow-up miss; it excludes survival time.

## Miss and mistaken-tap learning

A content-sized pause card puts the operation’s meaning and decisive actual value first, with a short beginner explanation and plain service meaning beside the API name. Expected condition/normal example is explicit. Full observed payload, case-specific reasoning and caveats are visible immediately in a scrollable body; the exact official link stays visible. Benign mistaken taps use separate normal wording, never dangerous counterpart prose. S3 bucketREAD is listing permission, not all object contents; public access remains conditional on other controls. Completed effect ghosts are removed on pause/explanation; untouched active requests, RNG, history and score are retained on acknowledgment.

Independent baseline investigation found no UID resurrection in100seeds/300miss-resume cycles, but262 newly-issued identical cases within8seconds (minimum positive47ms). A5second rAF gap reproduced four due births in one render. Cooldown and visible-admission changes address those distinct measured causes; no active-card clearing or RNG reset is used.
