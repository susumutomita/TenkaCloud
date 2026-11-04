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

## Deliberately unused material

The 30-second LP video shows an older browser-demo-to-AWS narrative. The older Mac startup videos also contain historical steps. The Appendix instead links current startup documentation. No new Cloud Master or email-game footage was captured; those slides link the playable pages.
