# Book compatibility for the integration candidate

This is a repository-side compatibility note for
[自分で作るクラウド競技](https://zenn.dev/bull/books/cloud-competition).
The external book has not been changed by this work. Its published operating
instructions include legacy local-practice and Lite paths.

## Current replacement commands

| Published or former instruction | Integration candidate |
| --- | --- |
| make local for individual practice | make local starts one event/team competition system; prepare dormant Docker jobs, start the event, then use participant Start / resume |
| make local-down clears progress | make down preserves DB, scores, keys, writable layers and volumes; new Docker jobs remain stopped until participant resume, with no RAM retention |
| make host | Removed public target; use make local |
| Lite launcher / CodeBuild platform setup | cloud-pipeline.yaml defaults to the reviewed current source after explicit IAM setup; its advanced historical-source contract retains the original fixed-ref flow; exercise coverage remains partial |
| ACTION=destroy-all | Retained only by the fixed-old-ref pipeline; current make destroy confirms owned targets, drains recorded exercises, removes the platform stacks and retains data |
| pack activate for a tenant | Retained local record only; does not add problems to current events |

Local SQLite is implemented. Cloud Lambda / DynamoDB hosting is being restored.
AWS service problems are cloud-only. Docker/Compose exercises are local-only and
are not listed in the cloud catalog. Native Cryptography Battle runs on both hosting
options using the platform itself; synchronized cloud Battle bursts still exceed
the five-second refresh interval. Ordinary local shutdown
does not remove AWS resources created by an earlier revision.

## Teaching examples and verification

Use the following scope when revising the teaching examples. A historical example
is not silently reclassified as a current cloud exercise.

| Example | Current scope and evidence |
| --- | --- |
| sqli-demo | Local Docker Challenge; the real SQL/browser rehearsal covers the supported competition path |
| hello-world | Cloud AWS flag Challenge with scoped 15-minute CLI access; API/storage/worker contracts verified offline, live AWS rehearsal remains separate |
| ac26-crypto-battle | Native local/cloud Battle; shared reducer, private team state, scoring and replay verified; synchronized local-DB load remains above the five-second refresh interval |
| hello-world-battle | Historical AWS endpoint Battle; absent from the current cloud catalog and refused for local hosting. The retained uptime browser test injects Fake AWS/probes into the local engine; it is not proof of a current cloud runtime |
| wp-exposed-backup and renamed starter | Local catalog/authoring coverage is not a complete reader walkthrough. Verify the actual instructions, answers, hints, team isolation, restart and cleanup before presenting the new recipe as tested |

Keep the endpoint-Battle book chapter linked to its pinned historical release until
its cloud lifecycle is implemented or the chapter is deliberately rewritten around
a supported scenario. Do not present the Cryptography Battle as the same AWS uptime
lesson. Likewise, validating or installing an external Pack does not make its
problems executable in a current event.

Built-in local Course tracks now shows only the team's assigned problems, uses
their saved checkpoints/completion state and the existing event gate, and links to
the correct job. A one-team event provides solo practice using that same runtime.
The real Chromium rehearsal covers links, progress, gate, team separation and
restart with seeded saved checkpoint data; it does not execute every verifier.

All 106 former local Compose problems are intended to work as Challenge competitions
through shared runner capabilities. Catalog/workbench integration is implemented.
Real Docker/browser checks covered SQL exercise access and a PostgreSQL terminal,
three checkpoints, team isolation and data-preserving stop/restart. This does not
prove all 106 problems or all 15 terminal variants. New Docker events allocate up to 512 dormant
jobs, with active defaults of 3 per team, 12 per host and 4096 MiB of summed memory
caps. A synthetic 100-job / 105-port plan proves allocation and lifecycle behavior,
not concurrent Docker capacity. Stop preserves writable layers and volumes without
automatic eviction or reset; existing events retain their legacy lifecycle.
Do not treat schema acceptance or catalog visibility as a passed participant route.

The book's [Battle rules chapter](https://zenn.dev/bull/books/cloud-competition/viewer/battle-experience)
describes points per endpoint. The pinned problem and retained engine instead
award +100 for a cycle with both required endpoints healthy, or -100 when either
fails. This discrepancy predates the platform retirement. Correct the prose in
an authorized book revision rather than silently changing the score engine.

## Chapters needing an authorized book revision

- Execution modes and local chapters: event/team flow, Bun setup, actual exercise links and state-preserving shutdown
- AWS access: cloud-only execution, configured deployment-role ExternalId in SSM, separate participant role and exact bootstrap region; no local AWS startup option
- Cloud setup and cleanup: review explicit first-account IAM setup, current source pins and the separate historical-source compatibility path; distinguish retained-data teardown from old destroy-all
- Authoring/private packs: distinguish validation/install from executable catalog integration
- Codespaces and appendix: require new forwarded-origin, gateway and terminal evidence; update the shutdown checklist

For current local steps use [local hosting](local-hosting.md) and the
[event runbook](operations/event-runbook.md). Historical operation references are
[pinned to the pre-retirement source](https://github.com/susumutomita/TenkaCloud/blob/825415fcda5075ad723daf9e4514eac47d7b8bb9/README.md); no data migration
or external resource cleanup is implied.
