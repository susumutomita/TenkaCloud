# Mail Detective

Static, play-first comparison of two fictional emails at `/mail-detective/`. No lecture, signup or pre-quiz. Each play contains at most two scenes, targeting 1–3 minutes before optional reading. Physical-device usability, human duration and learning effectiveness remain unmeasured.

## Lessons and variations

| Level | Existing case | Risk targets |
| --- | --- | --- |
| 1 | Booking | One unexpected attachment |
| 2 | Invoice | Different sender and code-reply request |
| 3 | Shared file | Actual destination and app-running attachment |
| 4 | Account | Protection-disable request, tool and reply contact |
| 5 | Look-alike domain | Sender, destination and code request |

The five authored cases remain intact. A lesson projection changes unintroduced risky values back to their verified reference, not merely out of grading. Normal subject/time changes, registered senders and known paths remain valid differences. Level2 also includes the same expected statement PDF on both sides. A difference or an attachment is not inherently malicious.

Three coherent text variants per lesson change fictional brands, matching domains, requests, filenames and neutral opening text. Injected RNG makes them testable, excluding the immediately previous variant on replay. No AI generation or external API is used. Lesson order follows taught concepts.

The first play is Levels1–2, with an optional next play of Levels3–4 and finally Level5. Replay starts at the same level with another variant. Results distinguish independently found and revealed targets, counting only visited scenes. Timeout and early stop cannot advance to later lessons.

## Interaction and feedback

Desktop places emails side by side; mobile switches between full-width messages. Subject, sender, recipient, time, body, links and attachment retain a familiar Gmail-like reading structure. Safe and unchanged content use the same inspection controls as scored differences. There are no candidate-only dotted hover cues. Ordinary link underlines and visible keyboard focus remain; success marks appear only after answering or explicitly revealing.

A short reason follows judgment; details are optional. Attachment/tool details explain the method, the behavior requested, and the safe response: do not download or run unrequested software, verify through a known independent route rather than contacts in the message, and report it at work when relevant. An exe extension alone is not classified as malicious. Brief feedback respects reduced motion.

End review starts with learned topics. Sender, destination and requests appear before authentication at Level4 and character-confusables at Level5. Beginners do not need DKIM knowledge.

## Headers and character comparison

From Level4, Show original opens a collapsed simulated header excerpt. It attributes Authentication-Results to the trusted fictional receiver mx.practice.example, never to browser DNS or cryptographic verification. From, Reply-To, `Return-Path`, SPF envelope domain, DKIM signing domain and DMARC From alignment are shown. Reply-To is not used for that alignment. Signature bytes are omitted; X-Practice-DKIM-Domain is an educational annotation, not a valid DKIM-Signature.

Authored counterexamples cover forwarding with SPF fail but aligned DKIM pass, unaligned SPF/DKIM passes, and a look-alike domain passing for itself. Passing authentication proves neither good intent nor safe content; failure alone is not proof of fraud. An identically named header is not inherently trusted.

Only after a Level5 finding or answer reveal, the game derives changed characters, positions and Punycode from the actual URL data. Current variants replace Latin a (U+0061) with Cyrillic а (U+0430): character4 in minаmo.example or character2 in nаgisa.example / hаrumi.example. Enlarged characters, Japanese/English names, highlighted positions and ASCII forms are shown.

The glyph comparison copies the source email control's computed font-family, weight and style. The UI reports the requested stack and does not pretend to identify the actual device fallback. It distinguishes a different character from a different font rendering the same character. IDNs are not inherently unsafe.

## Deadline and optional next steps

Text stays still while the message-frame seams approach an automatic-processing outlet. No separate meter, numeric countdown or flashing. Each scene has 60 seconds of active presented time. Address/link/header/reason inspection and mobile reference reading pause it, with an explicit resume action. Blur, background time and suspended frames over one second are excluded. Input settles the old clock before scoring, so late input cannot score. Timeout explains misses and offers immediate replay. This is a fictional game event, not real email-processing behavior.

An X compose link beside replay includes actual found/reviewed counts, visited levels, early-stop/timeout status and the production game URL. It does not post automatically, connect an account, reveal answers or claim certification. The user confirms any final post.

Both games return to the same subject-based learning list. Ready practice links to real descriptions and the appropriate local/cloud organizer guide. Participant invitation guidance stays separate. Same-theme social-engineering practice is still draft, so it is not offered as ready. Standalone replay needs no account or hosting setup. Competition/authentication code and the separate LP PR remain unchanged.

## Safety, validation and sources

All message content, brands, addresses and attachments are fictional. Message targets are inert controls, not navigable links or downloadable files. Play sends no email, executes nothing, performs no AWS operations and needs no external API, key, signup, Docker or analytics. Answer data is intentionally client-readable learning material, not hidden grading or an ability certification. References, shared navigation and X compose are explicit user navigation.

```sh
bun test scripts/landing/mail-detective.test.ts scripts/landing/mail-levels.test.ts scripts/landing/mail-next-step.test.ts
bun run stamp:landing-assets
python3 -m http.server 19980 --bind 127.0.0.1 --directory landing
```

Open `http://127.0.0.1:19980/mail-detective/?lang=en` on that Mac; Japanese uses lang=ja. Reuse an existing server rather than binding its port twice. This is a local preview, not production publication.

Official sources: [FTC](https://consumer.ftc.gov/articles/how-recognize-avoid-phishing-scams), [Gmail](https://support.google.com/mail/answer/180707), [RFC8601](https://www.rfc-editor.org/rfc/rfc8601), [RFC9989](https://datatracker.ietf.org/doc/html/rfc9989), [RFC5890](https://www.rfc-editor.org/rfc/rfc5890), [UnicodeUTS39](https://www.unicode.org/reports/tr39/) and [Unicode character data](https://www.unicode.org/Public/UCD/latest/ucd/UnicodeData.txt). Cases and UI are original synthetic material; no real mail, contacts, brand assets or third-party course questions are copied. Future curriculum is separate in [the learning path](../../docs/learning-path/README.ja.md).

Scoring: flag a risky field to earn +1; flag a normal or unchanged field and lose 1 point. Each field is scored once. Opening sender/header/link details, switching comparison tabs and keyboard navigation are investigation, not answers, and never cost points. Results and optional X text include actual points and false alarms; reviewing answers earns no points.
