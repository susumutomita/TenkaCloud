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
| Lite launcher / CodeBuild platform setup | No current replacement deployment yet; make deploy exits unimplemented |
| ACTION=destroy-all | Legacy-only; make destroy currently exits unimplemented and deletes nothing |
| pack activate for a tenant | Retained local record only; does not add problems to current events |

Local SQLite is implemented. Cloud Turso and platform deployment are in progress.
AWS exercise deployment from an approved local host is a separate capability and
may incur AWS charges. Ordinary local shutdown does not remove those stacks.

## Teaching examples and verification

Keep sqli-demo, hello-world, hello-world-battle and wp-exposed-backup as explicit
book regression scenarios, including correct/wrong answers, hints, team isolation,
restart and cleanup. Renamed starter authoring must have its own runtime evidence.
All 106 former local Compose problems are intended to work as Challenge competitions
through shared runner capabilities. Catalog/workbench restoration is in progress;
15 terminal problems and complete real Docker/browser playability are incomplete.
Terminal HTTP/WebSocket tests pass with a synthetic shell (11 tests, 96 assertions);
actual Docker exec remains unverified. New Docker events allocate up to 512 dormant
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
- AWS access: required host deployment ExternalId versus per-deployment participant-role ExternalId, exact bootstrap role and region
- Lite setup and cleanup: replace with a working cloud path only after implementation; retain legacy cleanup solely for legacy installations
- Authoring/private packs: distinguish validation/install from executable catalog integration
- Codespaces and appendix: require new forwarded-origin, gateway and terminal evidence; update the shutdown checklist

For current local steps use [local hosting](local-hosting.md) and the
[event runbook](operations/event-runbook.md). Historical operation references are
[pinned to the pre-retirement source](https://github.com/susumutomita/TenkaCloud/blob/825415fcda5075ad723daf9e4514eac47d7b8bb9/README.md); no data migration
or external resource cleanup is implied.
