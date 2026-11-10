# BootCamp Appendix video provenance

## Local UI

- Source: [continuous Local UI recording](../../docs/assets/local-ui/README.md).
- Published copy: [local-ui.mp4](local-ui.mp4), 45.16 seconds, H.264, 1280 × 840, silent with Japanese step headings.
- SHA-256 of both source and copy: `b9c4d147fa35a55fa466db4643df9c02a5119cec27761cf91bf72e5d3b3a46e1`.
- Capture conditions: a dedicated headless browser, temporary SQLite, synthetic teams and a test-only exercise adapter. No existing event or real user data. This is not proof of AWS or Docker deployment.
- Operations: select a problem, create/start an event, enter with a participant URL and team key, submit an answer, inspect scores, end and tear down the event, confirm Removed.
- Existing edits: waiting time removed, Japanese step headings added, keys and answers masked during capture. This change copies the recording byte for byte; it does not record or edit a new video.
- Print poster: extracted at second 6 with ffmpeg. It shows the problem-selection detail view, not a deployment success.
- Original inspection: the source README records inspection of all 1,129 frames and enlarged views of key masking, answer submission, score and Removed.
- Publication inspection for this copy: decode with ffmpeg, OCR at one-second intervals (45 frames), and inspect the contact sheet and enlarged poster. Check masked authentication fields and participant access URLs; check for AWS account IDs. No new capture data is introduced.

## AWS recording

Reuse [the existing public YouTube video](https://www.youtube.com/watch?v=o39ZWxEbrzA), seconds 0–60: hosting operations (20 seconds) and Cryptography Battle (40 seconds). The same public poster is used for print.

[Original capture, editing, OCR and visual inspection record](../jaws-yokohama-2026/assets/recorded-demo.md) documents the September 15 AWS capture, removed sensitive sections, edits and publication. The deployed application commit was not identified. This is historical footage, not verification of the current cloud deployment procedure. Follow the linked current organizer guide.

音声：VOICEVOX:ずんだもん。

The player loads YouTube only after a click, and removes its iframe on slide navigation. A direct YouTube link remains available. Network access to YouTube is required.

## Simulator (local demo)

- Published copy: [simulator-demo.mp4](simulator-demo.mp4), 67.1 seconds, H.264, 1280 × 800, silent with Japanese step headings. No open/end cards.
- SHA-256: `e3c8906233d3a5f270e091177c04cea46539482b11ecfde8776a8056e77101dc`.
- Poster: [simulator-demo-poster.jpg](simulator-demo-poster.jpg), 1280 × 800, still from the Correct submission frame.
- Source recording on the agent box, 2026-11-10 (Asia/Tokyo): `make local` with a Simulator binary built from TenkaCloudSimulator main `cc30d5e`, against TenkaCloud `f5783ac`. Host and Simulator ran on the same machine. No real AWS account, no production deploy, no Docker host.
- Operations shown: start Simulator via `make local`, register and verify the Simulator as an account, create an event, deploy Hello World, start the event, solve via AWS CLI, Simulator console GUI and Simulator API Doc GetParameter, submit, Correct +100 pt, scoreboard.
- Edits: waiting time, failed attempts and private chat removed; problem-statement crop excludes “runs on real AWS” wording. Organizer/team keys, Simulator credentials and the answer flag are local-only throwaway values from this take and are shown unmasked by owner decision. No private conversation remains on screen.
- Inspection: ffmpeg decode of the published MP4; midpoints for CLI, GUI Parameter Store value, API Doc 200 OK, Correct and scoreboard reviewed before publication.

## 60-second introduction

- Published copy: [tenkacloud-60s.mp4](../videos/lp/tenkacloud-60s.mp4), shared with the LP. 64.0 seconds, H.264, 1920 × 1080, 30 fps, with music and no narration.
- SHA-256: `7034983ea908d6965a29d948222ad8f692ff9842acf82afa2c91dcdeb14eacbd`.
- Poster: [intro-60s-poster.jpg](intro-60s-poster.jpg), 1280 × 720, still from second 8.6 (the title card, not a product screen).
- Source and capture conditions: [introduction video record](../../docs/assets/lp-60s/README.md). Recorded 2026-11-10 (UTC) from one local run of TenkaCloud `f5783ac` with a Simulator binary built from TenkaCloudSimulator `36e72c4`. No real AWS account and no Docker host.
- Operations shown: participant solves Hello World and takes first place, organizer runs `make local` and starts an event, the participant reads the parameter in the Simulator console, the Simulator's AWS, Google Cloud, Azure and Sakura consoles, a live Cryptography Battle.
- Edits: crops, zooms and gold outlines over the captured screens. The terminal panel is typeset from real `make local` output lines. Organizer key, team keys, Simulator token and the answer flag are masked on screen.
- Scope: the Simulator is under development and unreleased; Hello World is the one problem played on it. The Google Cloud, Azure and Sakura scenes are Simulator console operations, not competition problems.
- Inspection: ffmpeg decode of the published MP4; contact sheets of every scene and enlarged views of the masked fields reviewed. The audio was measured (−15.0 LUFS) but not auditioned by the recorder.

## Deliberately unused material

The 30-second LP video shows an older browser-demo-to-AWS narrative. The older Mac startup videos also contain historical steps. The Appendix instead links current startup documentation. No new Cloud Master or email-game footage was captured; those slides link the playable pages.
