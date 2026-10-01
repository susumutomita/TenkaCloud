# Community host architecture

This describes the unpublished integration candidate. It does not describe a
released cloud service or claim that every restored catalog entry is playable.

## Current responsibilities

- One Bun process serves the organizer and participant applications
- Organizer accounts and roles are separate from event-owned participant team keys
- Event/team state, operation ownership, scores, receipts and authentication live
  in local SQLite with private original key files
- New Docker events prepare up to 512 dormant jobs; participants Start / resume
  and Stop (keep data), with no automatic eviction or reset
- Defaults admit 3 active environments per team, 12 per host and 4096 MiB of
  summed configured memory caps. The 40 gateway slots are active-only; dense
  runtime-port assignments are retained when stopped
- New Compose plans preserve authored caps and fill missing memory/CPU/PID limits
  with 512 MiB, 1 CPU and 256 PIDs per service; old events keep their legacy lifecycle
- Runtime adapters manage owned Docker environments, the in-process Battle and
  reviewed AWS exercises; HTTP boundaries do not trust a submitted team identity
- Accepted operation/ownership state is retained before external work; uncertain
  outcomes remain visible and recoverable
- Verifiers judge submissions; the platform serializes and persists scoring,
  progress and retry receipts before replying

`make local` starts the managed runtime. `make down` stops owned local runtimes
and preserves data. New on-demand Docker jobs remain stopped after startup until
participants resume them. Stop retains writable layers and volumes, not RAM.
It does not reset the event clock or delete AWS exercise
stacks. Explicit event teardown and ordinary shutdown are separate operations.

## Storage and cloud boundary

Local SQLite is implemented. Cloud Turso and platform deployment are in progress.
`make deploy` and `make destroy` currently exit unimplemented without modifying
resources. A container build, remote-driver experiment or schema declaration is
not an end-to-end cloud deployment or zero-fixed-cost guarantee.

The AWS exercise adapter is separate from platform deployment. It uses operator
credentials to assume a verified competitor deployment role with the required
host ExternalId. Participant access uses the saved viewer role and its deployment
ExternalId, never deployment-role credentials. Keep the bootstrap AdministratorAccess
exception confined to competitor initialization. Existing STS sessions can outlive
event end; new access issuance is checked against current event/team state.

## Runtime coverage

The target is all 106 former local Compose problems as Challenge competitions.
Generic catalog/workbench integration is being restored. The 15 terminal problems,
real Docker routes and full browser playability are incomplete. Terminal HTTP/WS
passed 11 tests and 96 assertions with a synthetic shell; actual Docker exec is
unverified. A synthetic 100-job / 105-port event proves allocation and lifecycle,
not Docker performance or machine capacity. Preserve capability
failures, per-team verifier separation, safe endpoint routing and native hardware
requirements. Catalog visibility alone is not execution evidence.

## Diagram sources

The editable sources below describe the current boundaries:

- [Logical responsibilities](diagrams/logical.mmd)
- [Local components](diagrams/local-components.mmd)
- [AWS exercise and cloud platform boundary](diagrams/cloud-components.mmd)
- [Problem deployment](diagrams/problem-deployment.mmd)
- [Participant scoring](diagrams/participant-scoring.mmd)
- [State-preserving local lifecycle](diagrams/local-play-sequence.mmd)
- [Editable Draw.io document](diagrams/system-architecture.drawio)

Regenerate Draw.io with `python3 docs/architecture/diagrams/system-architecture.gen.py`.
Mermaid sources can be rendered with `diagrams/render.sh` when its documented
Mermaid CLI is available. Previously generated SVG/slide exports are historical;
current guides do not embed those stale architecture images as current evidence.

## Historical architecture

SaaS tenant onboarding, Lite, the old Lambda/Step Functions backend and DynamoDB
operation belong to the [pinned legacy architecture](https://github.com/susumutomita/TenkaCloud/blob/825415fcda5075ad723daf9e4514eac47d7b8bb9/docs/architecture/README.md).
Do not restore those systems solely to retain a diagram, or assume an automatic
data migration. The old tenant-onboarding filename is a legacy pointer only.
