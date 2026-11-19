# LP motion assets

All footage depicts TenkaCloud itself. No ICS code, imagery, video, origin-trial token or other reference assets are included.

- `participant.mp4` and `organizer.mp4`: silent, cropped excerpts of the repository's owner-approved public `landing/videos/lp/tenkacloud-60s.mp4`, at 13.6–25.4 seconds and 32–34.4 seconds (ending before the event-running caution text). See `docs/assets/lp-60s/README.md` for the original local recording, masked sample flags, and publication approval. These show participant operations and the local event setup form, not a deployed incident exercise. Their JPEG posters are frames of the same footage.
- `game.mp4`: timestamped browser screenshot capture of the repository's public `/cloud-master/` game, with sound off. Captured at 640×400, reconstructed using the captured frame timestamps, then encoded as silent H.264. It shows the real falling API-question cards; no invented game interface or customer data. `game.jpg` is a screenshot from that same public game.
- `film.jpg`: frame from the original public 61-second video. The full video is linked and embedded unchanged with native controls.

The short clips use H.264, `faststart`, no audio, and HTML `muted playsinline`. Posters and all normal HTML links remain when autoplay is unavailable. Reduced-motion starts with posters. Automatic footage and scene changes have a visible pause control and stop outside the viewport or in a hidden tab.

The user-supplied public YouTube URL is [the official YouTube upload](https://youtu.be/k3087kMJmgI) (TenkaCloud Official, title `1分でわかる TenkaCloud｜クラウド演習をもっと身近に`, player duration 61.121 seconds). Browser review confirmed the participant-score scene and published description match the existing film’s documented scope. YouTube transcoding means byte identity with the self-hosted MP4 is not asserted.

## Simulator montage

`simulator.mp4` is a silent montage of four actual browser screenshots (1.8 seconds per state), not a continuous screen recording. `simulator.jpg` shows the saved result. The screenshots show the standalone operator console: a Standard SSM String parameter `/practice/welcome`, its edit form, a changed dummy value, and the saved version 2. No operator token, real cloud credentials, customer data, or external cloud resource is shown.

Captured from the official [TenkaCloud Simulator v0.1.2 release](https://github.com/susumutomita/TenkaCloudSimulator/releases/tag/v0.1.2), `tenkacloud-simulator_darwin_arm64`, after verifying its SHA256SUMS. BUILDINFO identifies source commit `3d575ac645de4f1b36d644879a714374f5f6d9d4`. The binary ran on numeric loopback with an isolated temporary SQLite database and normal token-file authentication. Parameter creation, editing, and the saved value/version were verified in the actual UI. The four source captures are in the task QA artifacts under `qa-platform/entry-transitions/simulator/`.

This is a standalone Simulator operation example, not proof of a Host-issued participant's write permissions. The LP labels it as standalone and notes that participant permissions depend on the problem. Current-main Python code editing, complete AWS coverage, arbitrary Challenge compatibility, and two-team Battle VM operation are not claimed. The Simulator is an independent learning tool; its official README and release remain the setup/scope sources. Its source is MIT licensed; no Simulator runtime code is copied into the LP. Existing project licenses and footer notices remain intact.
