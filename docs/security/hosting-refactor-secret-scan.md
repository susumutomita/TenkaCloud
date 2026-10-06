# Hosting refactor secret scan

Scan date: 2026-10-05 UTC. Tracking issue: [#3315](https://github.com/susumutomita/TenkaCloud/issues/3315).

## Scope and result

PR #3313's GitGuardian check is neutral with the reason "Pull request too large to scan". It does not identify a secret alert and is not a completed scan. This record supplies an independent local scan of the merged sources and the changed problem submodule; it does not claim that GitGuardian ran or that its detection rules are equivalent.

| Source | Fixed identity | Gitleaks findings | Review |
| --- | --- | --- | --- |
| Merged platform diff | `825415fcda5075ad723daf9e4514eac47d7b8bb9..0a822eefc55e37329132b136fbc96ebf6b938e3c` | 0 | Scan completed |
| Original PR history, 64 commits | `825415fcda5075ad723daf9e4514eac47d7b8bb9..59460f60291cd5e88f9a14ca7b786d1d6a0c7d1f` | 0 | Scan completed |
| Merged platform tracked tree | `46c606096800a3e52a54745d5b5d9cbddef9756f` | 0 | Scan completed |
| Problem catalog diff | `363a7c9b83969e20d63b74fd0410a354da5e202b..4bb3a116c545fc46ed6a39ffcc5117fb914947f4` | 0 | Scan completed |
| Problem catalog tracked tree | commit `4bb3a116c545fc46ed6a39ffcc5117fb914947f4` | 9 | All nine are static non-admin demo tokens in API IDOR training examples |
| Additional current platform tree | commit `05ffed84971178c14f502a728802524af247c2d8` | 1 | Fetch-mocked admin-console test fixture; replaced with an explicit test token |
| Prepared platform tree after fixture replacement | `5f4421ec3a3d6c8bb0947ee2863aa968fd5bf6f6` | 0 | Scan completed; this tree precedes this documentation file |
| Generated positive control, kept outside Git | No real credential | 1 | `generic-api-key` detected; expected exit code 1 |

No finding was classified as an operational credential. No credential validity checks, external uploads, rotation or AWS calls were performed. Detection counts remain visible; no repository checks, scanner rules or service limits were weakened.

## Finding review

The nine `curl-auth-header` findings in the pinned catalog occur at:

- `challenges/api-idor-demo/README.ja.md`: lines 41, 48 and 58.
- `challenges/api-idor-demo/README.md`: lines 44, 48 and 54.
- `challenges/api-idor-demo/local/app/server.mjs`: lines 108, 109 and 110.

Each matched header token was checked against the static tokens seeded for users 2 and 3 in the same local server. None matches the seed-derived admin token. These are deliberately public local training inputs, not AWS or external-service credentials. Their values are omitted here, and the problem files are unchanged.

The current platform finding is `generic-api-key` at `apps/application-admin-console/test/pages/event-detail/TeamsTab.test.tsx:56`. That argument is supplied to `createApiClient` inside a fetch-mocked component test, not loaded from deployment credentials. Only this synthetic argument is changed; the three existing component tests still pass.

GitHub's secret-scanning alerts endpoint returned an empty list during this review. That result covers that endpoint only and is not evidence of completed GitGuardian coverage.

## Tool and reproducibility

[Gitleaks](https://github.com/gitleaks/gitleaks) 8.30.1, Darwin arm64, ran locally. The downloaded archive SHA-256 was compared with the official `v8.30.1` release checksums:

`b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5`

The scanner used its unmodified built-in default rules through a separate configuration:

```toml
[extend]
useDefault = true
```

Repository ignore files and inline allow comments were disabled for this run. Files had no size cutoff; archive traversal was limited to depth 2 and recursive decoding to depth 5. Full trees were exported using `git archive`, excluding local untracked files, credentials, caches and Git metadata. The catalog was exported and scanned separately because platform archives do not include submodule contents.

Use the fixed ranges above with `gitleaks git --log-opts <range>` and the exported trees with `gitleaks dir <tree>`. Apply these options to each scan:

```text
--config <default-only-config>
--gitleaks-ignore-path <empty-directory>
--ignore-gitleaks-allow
--redact=100
--no-banner --no-color
--max-archive-depth 2 --max-decode-depth 5 --max-target-megabytes 0
--report-format template --report-template <metadata-template>
--report-path <private-report>
```

The report template retained only rule, file, line range, commit and fingerprint; secret and match fields were excluded. Private scan logs also used full redaction. Zero-finding report files had SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

A generated high-entropy API-key control verified the generic detector. An earlier synthetic AWS-key-shaped control did not match its detector and is not counted as a successful control. A positive control validates execution of that rule; it does not prove that every possible secret format is detectable. Binary/media content, encrypted archives and external deployment secrets are outside the claims of this source scan.

## Separate participant sign-in issue

[#3314](https://github.com/susumutomita/TenkaCloud/issues/3314) remains open. Current Cloud participant authentication tests pass (177 tests), and Local participant-access/template-trust tests pass (22 tests). Those mocked checks do not identify the reported deployed `AccessDenied` or demonstrate successful user sign-in.

The missing evidence is the affected Local/Cloud environment, actual deployed commit, and redacted `operation`, `stage` and `reason` from the failing request. No relevant AWS deployment identity or failure log was found in the issue or GitHub deployment records. Do not share keys, credentials or Console login URLs. No IAM or trust-policy change is proposed without the specific cause.
