# Appendix evidence and validation

## Content sources

Checked on 2026-11-04 against repository main `f99b3d9a00076a2a5e97f1d4d9b0b20a7e02245c` and the GitHub API. No existing open PR matching issue 3527 or the BootCamp Appendix was found. No catalog counts are advertised.

| Appendix content | Evidence and scope |
| --- | --- |
| Product, Challenge, Battle, current cloud limitations | [LP](https://tenkacloud.com/), [organizer guide](https://tenkacloud.com/docs/manual/organizer/) and source `landing/index.html`. Uptime-based AWS Battle is explicitly excluded from current support. |
| Six uses | `landing/index.html#use-cases`; presented as uses, with no learning-effect claim. |
| Local hosting, Bun, SQLite, team-key entry, optional Docker, retained data after stop | [v2.0.0 published release](https://github.com/susumutomita/TenkaCloud/releases/tag/v2.0.0), published 2026-10-07; [current startup guide](https://tenkacloud.com/docs/getting-started/#local-start). |
| Fixed problem catalog | [v2.6.0 release](https://github.com/susumutomita/TenkaCloud/releases/tag/v2.6.0) identifies `b17b9dc79043dfec668e4152dee0fed9801f1213`. The deck links that snapshot and omits counts and draft examples. |
| Browser demo | LP labels this as a historical introduction, with authentication/scoring/operations distinct from current hosting. |
| Cloud Master | [v2.5.0](https://github.com/susumutomita/TenkaCloud/releases/tag/v2.5.0), [v2.6.0](https://github.com/susumutomita/TenkaCloud/releases/tag/v2.6.0) and [v2.6.12](https://github.com/susumutomita/TenkaCloud/releases/tag/v2.6.12). Release notes record production asset verification. No actual AWS operation is claimed. |
| Email game | [Merged PR #3495](https://github.com/susumutomita/TenkaCloud/pull/3495) and `landing/mail-detective/`. The issue requests its public link; current production availability still needs an unrestricted browser check (see limitations). |
| Hosting operations video | Existing Local UI capture and [recorded-demo.md](recorded-demo.md). Test-only adapter, synthetic teams, no real AWS/Docker deployment evidence. |
| AWS operations / Cryptography Battle video | [Existing capture record](../jaws-yokohama-2026/assets/recorded-demo.md), 2026-09-15. Historical recording; current instructions link to the organizer guide. |
| June kickoff | [PR #1739](https://github.com/susumutomita/TenkaCloud/pull/1739). |
| August/September events and feedback | [PR #3485](https://github.com/susumutomita/TenkaCloud/pull/3485), [UG #1](https://tenkacloud.com/tenkacloud-ug-1/), [JAWS Yokohama](https://tenkacloud.com/jaws-yokohama-2026/). |
| Simulator | [Development repository](https://github.com/susumutomita/TenkaCloudSimulator). Final slide (`#14`) keeps 開発中 · 未リリース. Local demo video (`simulator-demo.mp4`) shows `make local` → register/verify → event create/deploy/start → Hello World via CLI / console / API Doc → submit/score. Only Hello World works in Simulator mode so far. Independent simulator, not official AWS. No purchase/adoption claim. Provenance: [recorded-demo.md](recorded-demo.md). |

The latest published release returned by GitHub was v2.6.12 (2026-10-29). This change makes no v2.7.0 publication claim.

## Browser verification

Headless Chromium 154 on Linux, static server rooted at `landing/`:

- 1440 × 900 and 390 × 844: all 14 slides; no horizontal overflow or missing images.
- Desktop: all slide boundaries fit the viewport. Screenshots of the Appendix and mobile video slide inspected.
- Native MP4: actual playback advances at both sizes; no media error; moving to another slide pauses playback.
- Slide 14 Simulator demo: native MP4 loads (`simulator-demo.mp4`); playback advances; leaving the slide pauses media. Layout checked at 1280 × 800.
- YouTube: clicking creates the expected privacy-enhanced embed with start 0 / end 60; leaving the slide removes the iframe and restores the button. Actual remote playback is not verified here.
- Print: all 14 slides display; both posters load and display; video players hide. Chromium PDF has 14 pages.
- Main four slide sections compared with Git HEAD: identical after removing the permitted numbering and label metadata, plus the subsequently requested logo images/classes. Cover draft notice retained.
- Existing UG #1: original `1 / 14` counter and keyboard navigation preserved. Automated regressions cover counters, deep links and media stopping.
- Video copy: SHA-256 matches source; 45 one-second OCR frames have no detected URL, 12-digit account ID or AWS access-key pattern. Contact sheet and enlarged poster inspected; existing key/access-URL masks retained.

## Repository checks

- `make before-commit`: passed with Bun 1.4.4 and frozen-lockfile dependencies installed with lifecycle scripts disabled. Markdown/prose/format/ESLint and dead-code checks passed; the changed-file suite ran 968 tests with zero failures.
- Focused presentation regression suite: 3 passed, 15 assertions.
- `git diff --check`: passed.

## Logo follow-up

The user requested the logo after reviewing the Appendix. Reused the unmodified `landing/assets/svg/tenkacloud-mark.svg`: its mark matches the existing LP header and favicon. No alternative brand mark or third-party logo was introduced.

The cover title has a prominent mark next to its existing text. Every slide footer has the same small mark. Empty image alternatives avoid repeating the adjacent TenkaCloud text for screen readers. The SVG keeps its aspect ratio and original colors.

Verified all 14 slides at 1440 × 900 and 390 × 844: logo images loaded, no horizontal overflow. The first four sections match the previous commit after removing only the newly added logo images and classes. In print all 15 logo instances display, both video posters remain visible, and the PDF remains 14 pages.

## Remaining external verification

This execution environment refuses production and YouTube network connections (`ERR_TUNNEL_CONNECTION_FAILED` / HTTP 403). It cannot freshly confirm public email-game availability or real YouTube playback. Before marking the Draft ready, verify the public game links and play YouTube at both requested sizes in an unrestricted browser. The repository media playback and print checks above do not substitute for that check.

No merge, release, AWS operation or production deployment was performed.
