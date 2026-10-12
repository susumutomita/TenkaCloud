# Book compatibility with current hosting

This is a repository-side compatibility note for
[自分で作るクラウド競技](https://zenn.dev/bull/books/cloud-competition).
The source revision in [zenn-article PR #304](https://github.com/susumutomita/zenn-article/pull/304)
was merged on 2026-10-05 at `b526e12b655c484605d5a63447a6b0d1234ee509`.
That merge establishes the book source revision, not a verified publication date
or complete runtime rehearsal. Use this note with the matching TenkaCloud checkout;
current operating procedures live in [local hosting](local-hosting.md) and
[cloud hosting](../infrastructure/README.md).

## Current replacement commands

| Former instruction | Current hosting |
| --- | --- |
| make local for individual practice | make local starts one event/team competition system; prepare dormant Docker jobs, start the event, then use participant Start / resume |
| make local-down clears progress | make down preserves DB, scores, keys, writable layers and volumes; new Docker jobs remain stopped until participant resume, with no RAM retention |
| make host | Removed public target; use make local |
| Local organizer username/password or SAML | Current local hosting uses one organizer key; make local-reset rotates organizer access and revokes organizer sessions while preserving event/participant/runtime state |
| Lite launcher / CodeBuild platform setup | cloud-pipeline.yaml defaults to reviewed current sources using standard CDKToolkit (official bootstrap only if missing); review its broad CodeBuild role and CDK execution authority before launch. Restored generic CloudFormation/flag/multi-flag/endpoint and native paths; nine oversized TemplateBody templates remain unsupported |
| ACTION=destroy-all | Current make destroy-all confirms and purges stack-owned retained data and selected Turso rows; ordinary make destroy removes platform/default-owned data and leaves external Turso rows |
| pack activate for a tenant | The make pack-activate target is removed. CLI activate writes the selection consumed by the next Cloud deployment (`--tenant local`, default store); Local hosting does not consume Pack activation records |

Local SQLite is implemented. Cloud hosting uses Lambda with a choice of Turso or DynamoDB, preserving its original resource
identities and deployment paths. Published cloud-v1 resources/schema are incompatible
with in-place restoration; no data migration is automatic.
AWS service problems are cloud-only. Docker/Compose exercises are local-only and
are not listed in the cloud catalog. Native Cryptography Battle runs on both hosting
options using the platform itself. Both cloud databases retain 99-team admission
and SQL retains its 4 MiB coordination state policy; hosted event capacity remains
unmeasured. Ordinary local shutdown
does not remove AWS resources created by an earlier revision.

## Teaching examples and verification

Use the following scope when revising the teaching examples. A historical example
is not silently reclassified as a current cloud exercise.

| Example | Current scope and evidence |
| --- | --- |
| sqli-demo | Local Docker Challenge; the real SQL/browser rehearsal covers the supported competition path |
| hello-world | Cloud AWS flag Challenge using the restored generic deployment and participant Console/CLI paths; offline contracts are covered, live AWS rehearsal remains separate |
| ac26-crypto-battle | Native local/cloud Battle; shared reducer and original selected-database coordination backend. Hosted synchronized-load capacity remains unverified |
| hello-world-battle | Cloud AWS endpoint Battle using the restored generic deployment/scheduled-scoring paths; refused for local hosting. Local fake-AWS tests are not evidence of live AWS playability |
| wp-exposed-backup and renamed starter | Local catalog/authoring coverage is not a complete reader walkthrough. Verify the actual instructions, answers, hints, team isolation, restart and cleanup before presenting the new recipe as tested |

The endpoint-Battle lifecycle is restored, but its exact template and participant
route still need a recorded rehearsal before the chapter claims verified playability.
Do not present Cryptography Battle as the same AWS uptime lesson. Installing a Pack alone does not enable it. Cloud consumes activated AWS/CloudFormation Pack catalog and assets on deployment; existing events keep saved catalogs. Local reads its `problems/` tree instead of the Pack store. Private problems and problems awaiting publication do not require a public catalog contribution.

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

The [Battle rules chapter](https://zenn.dev/bull/books/cloud-competition/viewer/battle-experience)
and glossary were corrected in PR #304 to match the retained engine: +100 for a
cycle with both required endpoints healthy, or -100 when either fails. Earlier
book revisions described points per endpoint. Use the merged source revision
when comparing scoring; no score-engine change or automatic data migration is implied.

## Merged book source revision scope

| Chapters | Source revision changes |
| --- | --- |
| execution-modes, chapter13, glossary | Local/Cloud, DB selection, resource identity and current limits |
| chapter2/3, local-problem-runtime, chapter17, checklist | Event/team startup; down preserves data; clear deletes competition data; reset rotates organizer access |
| chapter14/15, aws-account-access | Participant URL + team key; Cloud-only AWS access; preserve ExternalId and deployment/participant role boundaries |
| chapter16 | Teardown exercises first; distinguish destroy and destroy-all; review selected DB and remaining resources |
| battle-experience, chapter17, glossary | Both-endpoints scoring rule: +100 for a healthy cycle, -100 if either fails |

Organizer-key startup/reset wording matches merged PR #3321 in main 3886bf16.
Interactive local starts rotate the key; noninteractive and public/container starts
retain it. The book source revision was merged in zenn-article PR #304; later hosting changes
still require comparison with the matching checkout.
