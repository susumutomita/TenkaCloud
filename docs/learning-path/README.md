# From short public games to hands-on practice

Try one decision in1–3minutes. Play immediately, get a short reason where a mistake happens, then try again. No lecture or quiz gate before play. Detail is optional; duration and retention are design aims, not proven outcomes.

| Stage | Decision to practise | Possible experience | Status |
| --- | --- | --- | --- |
| Everyday safety | Separate a meaningful risk from a mere difference | Compare two fictional emails | Only this first game implemented locally; unpublished |
| More everyday safety | Distinguish reuse, passkeys, two-step versus multi-factor and recovery | One decision per short game | Planned only |
| Developer foundations | Distinguish necessary access from unwanted exposure | Web/DB two-tier connection puzzle; context-dependent WordPress response | Planned only |
| Cryptography foundations | Distinguish shared-key, public-key and signature roles | Short crypto battles, then TLS, chains and intermediate certificates | Planned only |
| TenkaCloud practice | Read constraints, act and check the outcome | Existing Challenge/Battle platform | Subject to its supported features and runtime requirements |

Two-step describes stages; multi-factor combines different factor types. They are not interchangeable. Describe method and device conditions for passkeys and recovery. Operations puzzles must state threat, goals and constraints, and accept multiple valid approaches when appropriate; do not teach one WordPress setting as universally correct.

No cryptography game is implemented here. Future material must distinguish TLS1.3 handshake key exchange/authentication from record protection, not say that public-key encryption protects every data byte. Certificate chains require path/signature/trust-anchor validation and other checks including names and validity; a certificate does not certify site content. Use TLS for current protocols and distinguish obsolete SSL.

## This change

Only `landing/mail-detective/`: choose two of four fictional pairs per play, each with three risk-related changes and two normal variations. Answers and rules are visible in client source. This is practice, not secret grading or certification. No registration, event, AWS, Docker, external API or API key.
Preserve the separate competition exercise work and LP PR. No later games, effectiveness telemetry, social sharing or publication is included.

## Official references

- [FTC phishing advice](https://consumer.ftc.gov/articles/how-recognize-avoid-phishing-scams)
- [NIST SP800-63B authentication and recovery](https://pages.nist.gov/800-63-4/sp800-63b.html)
- [NIST SP800-12r1 fundamentals](https://csrc.nist.gov/pubs/sp/800/12/r1/final)
- [RFC8446 TLS1.3](https://www.rfc-editor.org/rfc/rfc8446.html)
- [RFC5280 X.509 certificate paths](https://www.rfc-editor.org/rfc/rfc5280.html)
- [RFC7568 SSL3.0 deprecation](https://www.rfc-editor.org/rfc/rfc7568.html)

Sequence, scenarios, rules and time targets are our design, not an official course, complete exam coverage or evidence of individual ability or retention.
