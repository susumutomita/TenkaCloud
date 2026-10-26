# Cloud Master: AWS Request Watch

One frontend-only game at `/cloud-master/`: tap a synthetic AWS request that
violates the policy printed on its card. Normal requests pass untouched.
No accounts, storage, analytics, packet capture, backend, or AWS requests.

## Rules

- Three lives. A false positive costs one life and continues.
- A missed suspicious request costs one life and freezes every card and game
  time for an explanation. Acknowledgment resumes. The final-life mistake is
  explained before results. Resume includes an 800 ms reorientation grace period.
- Normal pass-through earns exactly 10 points at the exit boundary.
- Correct detection earns game danger value times 10. Values are 1, 3, 4, 5.5,
  7.5 and 8: **game values, not actual GuardDuty severity values**.
- Only a correct 10-point dangerous detection gets a 120 ms hitstop. It resumes
  automatically, separately from the missed-item explanation.
- Correct detections at 5, 10, 15 and 20 advance levels, capped at 5. New-card
  lifetime decreases from 18 to 10.5 seconds, incoming interval from 4.5 to 2.6
  seconds. Existing deadlines remain intact. Normal passes do not advance levels.
- Cards arrive on a finite schedule. Any upper/future card can be tapped early.
  Desktop permits up to three; mobile caps at two for readable, stable targets.
- P/Escape pauses. Backgrounding pauses until manual resume. Tab or 1–3 supports
  keyboard play. Reduced motion keeps cards still. Untimed study is available.
- New rounds use random seeds; retries can reuse a seed. Scores are casual
  browser-inspectable practice records, not certification.

Early detection clears congestion; false positives cost lives. Reading longer
may improve confidence but risks accumulation and misses. No speed bonus, extra
currency, gambling or audio. A falsely flagged normal card cannot later earn a
pass bonus, and scoring freezes during explanations. Inaction ends after three
misses, preventing indefinite normal-pass farming.

## Catalog versus security-scenario coverage

The static catalog comes from AWS-maintained **botocore 1.43.118**, pinned by
wheel SHA-256. It includes **435 SDK service models and 19,437 operations**, using
one latest API version per model in that exact wheel. Zero operations and 33 older
API versions were excluded. This is not an AWS marketing-service count, every
future API, or GuardDuty detection coverage. Per-model counts and hashes are in
`api-catalog-manifest.json`; upstream Apache licensing is retained.

There are **six authored exercise-policy families**, each with normal and
violating variants: permitted service, permitted account, allowed IPv4 source,
CloudTrail logging-stop approval, private-only S3 ACL, and IAM key owner. Model
operations and context parameters vary deterministically. The visible context,
not the API name alone, decides the answer. Service bags cover all models from
level 3; curated scenarios do not consume and skip generic bag entries.

Cards show model HTTP method and URI templates and operation names; review retains
protocol hints. RPCv2 paths follow the pinned serializer rather than a legacy
model URI, and no HTTP version is assumed across protocols. Authentication and required arguments are omitted, so these are
not complete executable requests. No request is sent and execution success is
never inferred. These are not CloudTrail records or IAM action strings.

GuardDuty generates findings rather than inherently blocking requests. This game
does not reproduce trained-model internals, prebuilt-rule internals, finding severity, or
traffic interception. Generic exercise policies are not claimed to be GuardDuty
findings.

- [AWS-maintained botocore models](https://github.com/boto/botocore)
- [GuardDuty Custom Detection Rules](https://docs.aws.amazon.com/guardduty/latest/ug/custom-detection-rules.html)
- [GuardDuty severity](https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_findings-severity.html)
- [CloudTrail StopLogging](https://docs.aws.amazon.com/awscloudtrail/latest/APIReference/API_StopLogging.html)
- [S3 PutBucketAcl](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutBucketAcl.html)
- [IAM CreateAccessKey](https://docs.aws.amazon.com/IAM/latest/APIReference/API_CreateAccessKey.html)

## Reproduce and verify

```sh
python3 scripts/landing/generate-cloud-api-catalog.py
bunx biome check --write landing/cloud-master/api-catalog.js landing/cloud-master/api-catalog-manifest.json
python3 -m http.server 4173 --directory landing
bun test scripts/landing/cloud-master.test.ts
make before-commit
```

The generator only downloads public model data. `--wheel PATH` permits an offline
exact wheel, still verified by hash. It installs nothing and uses no credentials.

CSS is Liquid Glass-inspired with a restrained luminous background, limited blur
on a fixed HUD, and opaque readable cards. It is not native Apple Liquid Glass;
there is no Apple branding. Opaque fallback and reduced motion are supported.
Score effects stay in the HUD, name the resolved operation, and never cover the
replacement card. X sharing opens a native intent only after user action, with a
copy/selectable-text fallback and explicit preview labeling; no X SDK is loaded.

Use the existing `tenkacloud-www` Cloudflare Pages project and `landing/` output.
Draft previews are separate from production merge. No hosting/access/security
settings, credentials, permissions, paid commitments, or Passport files change.
Physical-device and Safari checks remain separate from Chromium mobile emulation.
