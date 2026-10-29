# Spot the risky difference / メールの間違いさがし

Static browser game at `/mail-detective/`, linked from the Japanese/English LP. Opens directly into play: no start screen, course, registration, event, Docker, AWS, external API, API key or analytics. Two rounds, designed for about1–2minutes; a prototype automatic-processing deadline with no numeric countdown or speed scoring. Human completion time and retention are not established.

## Play

Compare the notice verified in a fictional official app with a similar incoming email. Tap the incoming-email field that changes something consequential. Desktop shows two complete messages side by side. Narrow screens switch between full-width reference/incoming messages. Each has a subject, sender, recipient/time, normal body paragraphs, a link label and attachments. Sender/reply details open on demand; tapping a link label reveals its destination without navigating. The practice frame remains distinct from real email.

Five authored pairs: a random choice of four familiar pairs, followed by the look-alike-domain pair. Each has three risk-related changes and two normal variations. Sender, URL path and request differences can be normal depending on the scene; spelling or a changed date alone is never a scored risk. Reference facts are shown as observations needed for the scene, not a lecture before play. No real person, brand, mail or character artwork.

A tap shows a short local reason, with optional detail. Correct spots receive a brief tick reaction; reduced motion disables it. Mistakes do not block the next attempt or open a modal. Repeated taps do not add findings. Next-round action is explicit and never waits for an animation. Answer reveal completes review but is reported separately from independent finds. Finish early and replay are available; no best score, leaderboard or certification.

All email/link/attachment strings are plain text in buttons, never navigable links or files. The shared game list and LP links are active navigation. Optional end-of-play references open official sites in separate tabs; fictional message links remain inert. After the initial static assets load, play makes no requests and works without network access. There is no persistence or server-side hidden grading; reading source reveals answers by design.

## Files and verification

- `cases.js`: bilingual fictional observations, three consequential changes plus two justified normal variations per pair.
- `model.js`: pure bounded two-round state and transparent found/revealed accounting.
- `mail-view.js`, `mail.css`: familiar message structure with address and safe link inspection; no copied inbox content or brand assets.
- `copy.js`, `game.js`, `game.css`, `index.html`: immediate-play UI, native buttons/details, keyboard/touch, reduced motion and language changes preserving the run.
- `scripts/landing/mail-detective.test.ts`: decisions, repeated input, variation, answer reveal, finish/replay, safety and complete module-graph versioning.
- `docs/learning-path/`: future1–3minute/one-decision path; no later games are implemented.

Run from repository root:

```sh
bun test scripts/landing/mail-detective.test.ts scripts/landing/landing-seo.test.ts scripts/landing/cloud-master-assets.test.ts
bun run generate:landing-locales
bun run stamp:landing-assets
python3 -m http.server 19980 --bind 127.0.0.1 --directory landing
```

Open `http://127.0.0.1:19980/mail-detective/?lang=ja` or `?lang=en`. This loopback preview is for the host Mac only. No public deployment is performed by those commands. Stop the owned HTTP server to remove the preview; there is no backend state or cloud teardown.

Local tests, type/format checks, browser QA and independent review are recorded separately. Headless desktop/mobile simulation is not physical-device or human-playtest evidence. Production publication requires a separate decision; existing competition exercises and LP PR3493 are preserved.

## Source basis and limits

[FTC phishing advice](https://consumer.ftc.gov/articles/how-recognize-avoid-phishing-scams) supports independently checking an incoming request through a contact you already know. Cases, wording, art-free layout and rules are original synthetic material. No third-party email screenshots or course questions are copied.

A mismatch prompts checking; it is not universal proof of fraud. A matching sender/domain or all matching fields does not guarantee safety. Executable attachments are judged against this scene's verified notice, not categorically labelled malicious. Client results are practice feedback, not evidence of individual ability or learning effectiveness.

Gmail UI behavior references: [message details](https://support.google.com/mail/answer/180707?hl=en) and [full-header documentation](https://support.google.com/mail/answer/29436?hl=en). This is an independent practice game, not Gmail or a real login/mail client.

## Optional header inspection and look-alike domains

Each play now starts with one randomly selected familiar pair and then the look-alike-domain pair. The two-round, six-spot result remains unchanged. The new pair uses a Cyrillic a (U+0430) in minаmo.example, distinct from the known minamo.example. Inspecting the destination displays both Unicode and ASCII/Punycode; no external URL opens. The game deliberately presents both, without promising how any real browser will render them. IDNs are not inherently unsafe.

Show original opens an optional, initially collapsed simulated header excerpt. Authentication-Results is an authored observation attributed to the trusted fictional receiver mx.practice.example, not a browser cryptographic/DNS check and not a header to trust merely because its name matches. Signature bytes are omitted; X-Practice-DKIM-Domain is an explicitly educational annotation, not a DKIM-Signature. From, Reply-To, `Return-Path`, SPF envelope domain, DKIM signing domain/selector and DMARC From alignment are shown. Reply-To is not part of DMARC alignment. These results are not extra scored spots or a pass/fail safety classifier.

Counterexamples: the verified shared-file reference simulates forwarding with SPF fail but aligned DKIM pass and therefore DMARC pass; the account message passes SPF and DKIM for another domain but has DMARC fail; the look-alike domain passes all three for itself yet is not the verified sender. All alignment examples use exact domain equality or wholly separate .example domains, avoiding assumptions about public-suffix/organizational-domain discovery.

Sources: [RFC8601](https://www.rfc-editor.org/rfc/rfc8601) (trust boundary), [RFC9989](https://datatracker.ietf.org/doc/html/rfc9989) (current DMARC, replacing RFC 7489), [RFC5890](https://www.rfc-editor.org/rfc/rfc5890) (A-label/U-label), [UnicodeUTS39](https://www.unicode.org/reports/tr39/) (confusable characters). No text, signatures, accounts or personal data from real mail are used.

## Automatic-processing prototype

The incoming message has dashed side seams that become solid toward a labelled automatic-processing outlet. Its text never moves; there is no separate meter, numeric clock or flashing. An approaching status appears near the end. Each round currently has 60 seconds of active, presented foreground time, for an intended 1–3 minute play before optional inspection. This is a prototype value for user review, not a measured human completion time or final UX decision.

Opening address details, the original header or the link target pauses the window; the latest local answer reason pauses it too. The message states that it is paused, and Close and continue closes inspection and resumes. Switching messages or languages preserves progress. On narrow screens, reading the full-width reference pauses the hidden incoming message deadline; a note explains that returning to the incoming message resumes it. Background/blurred time and suspended frames over 1 second are excluded. The clock uses a monotonic watermark and settles old state before input, so an input after the boundary cannot earn a finding. A timeout has its own result, preserves independent finds, explains the missed spots and offers immediate replay. The next round and replay reset the clock. This is a fictional game event, not how actual email systems automatically validate or act on messages.

## Brand, review and shared entry

The outer shell uses the LP color tokens, type stack, spacing and rounded actions. Fonts use local fallbacks rather than adding a font-service request. The email body retains its separate familiar reading layout. Finish, timeout or completion shows a short overview with six closed topics: sender/reply address, real destination, confusable domains, requests/attachments, authentication and independent verification. Each opens where-to-look, what-to-check and a safe-next-action explanation with official references. It is not a lecture before play.

The LP has one shared game section. Its main action and both games’ return links open the existing public demo problem list through its explicit mock-only entry (`portal-demo/?demo=1&goto=...`). The browser-only games appear separately from the competition-interface demo and do not enter the competition catalog or event scores. Joining uses an organizer invitation; local/cloud are organizer hosting choices. Hosted/local real events and self-paced local views retain their existing behavior. There is no authentication or hosting-logic change, and direct game URLs remain valid.
