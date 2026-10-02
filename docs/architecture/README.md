# Community host architecture

This describes the unreleased integration candidate. It does not describe a
released cloud service or claim that every restored catalog entry is playable.

## Current responsibilities

- One Bun process serves the organizer and participant applications
- The local organizer key is separate from event-owned participant team keys
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
  coordination exercises; HTTP boundaries do not trust a submitted team identity
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

Local hosting uses SQLite. Cloud hosting uses API Gateway, Lambda, Cognito and
either Turso or three DynamoDB tables (Events, Teams and Deployments), reusing
reviewed serverless components without SaaS / SBT. Turso mode uses an exact SSM
token parameter and creates no DynamoDB tables. Both SPAs and their runtime configuration are served
from private S3 origins through CloudFront origin access control.
AWS service problems require cloud hosting. Docker/Compose exercises are local-only
and are not listed in the cloud catalog. Native Cryptography Battle runs on both
hosting options; the DynamoDB Local 100-participant burst took 5.910 seconds, exceeding the five-second refresh interval; AWS performance remains unmeasured.
`make deploy` and `make destroy` call the current cloud CLI after
reviewed IAM setup. The supported cloud catalog includes hello-world with scoped CLI
access and native Cryptography Battle. Destroy confirms the exact platform and deletes default-owned data. `destroy-all`
purges stack-owned retained data; recorded competition cleanup requires the explicit
`--drain-events` option or an event Teardown action.
A container build, remote-driver experiment or schema declaration is not an
end-to-end cloud rehearsal or zero-fixed-cost guarantee.

AWS exercise execution is enabled only in cloud hosting. Accepted jobs and the
dispatch queue are saved before a one-minute dispatcher starts the Step Functions
workflow. Lambda workers claim, create, describe and finish the exact owned
CloudFormation attempt; terminal failures have a recovery path. Workers assume a
verified competitor deployment role with the required installation ExternalId.

Participant access uses the verified deployment-bound viewer role with the job ID
as ExternalId. The currently supported hello-world access is a 15-minute CLI credential set
restricted to its Parameter. Native Cryptography Battle executes in the platform
and persists its state and scoring in the same selected-database transaction boundary.
The competitor-template AdministratorAccess grant stays confined to competitor
initialization. Standard CDK platform execution authority is reviewed separately;
application and participant runtime roles do not receive it. Existing STS sessions can outlive
event end; new access issuance is checked against current event/team state.

Competitor accounts are separate from the platform account. Teams may use separate
competitor accounts or different regions within the same competitor account. IAM
roles are global, so the latter share the installation role and ExternalId.
Organizations / StackSets is an additional manual bootstrap procedure; ordinary
platform deployment does not activate trusted access. Cloud Docker/Compose and the
AWS endpoint-based hello-world-battle are outside the current supported catalog.

## Runtime coverage

The target is all 106 former local Compose problems as Challenge competitions.
Generic catalog/workbench integration is implemented. Real Docker/browser checks
covered SQL access and a PostgreSQL terminal, three checkpoints, team isolation,
and stop/restart with the same container and seven inserted rows intact.
Other problem and terminal variants remain unverified. A synthetic 100-job / 105-port event proves allocation and lifecycle,
not Docker performance or machine capacity. Preserve capability
failures, per-team verifier separation, safe endpoint routing and native hardware
requirements. Catalog visibility alone is not execution evidence.

## Diagram sources

The Mermaid sources below describe the current boundaries:

- [Logical responsibilities](diagrams/logical.mmd)
- [Local components](diagrams/local-components.mmd)
- [AWS exercise and cloud platform boundary](diagrams/cloud-components.mmd)
- [Problem deployment](diagrams/problem-deployment.mmd)
- [Participant scoring](diagrams/participant-scoring.mmd)
- [State-preserving local lifecycle](diagrams/local-play-sequence.mmd)
- [Editable Draw.io document](diagrams/system-architecture.drawio): five current
  pages for cloud infrastructure, AWS exercise execution, the unified local runtime,
  use cases and system boundaries. Existing page IDs, AWS4 official icons and the
  original frame/connector style are retained; obsolete SaaS/Lite cells are replaced
  and remaining nodes are moved only to fit the current boundaries.

Regenerate Draw.io with `python3 docs/architecture/diagrams/system-architecture.gen.py`.
Its first two page IDs (`saas-physical`, `lite-physical`) remain stable identifiers,
not supported product modes. Regions are chosen by the operator; the diagrams do
not imply a fixed production region. The three DynamoDB tables share one service
icon, and worker operations share one Lambda icon. Page 02 expands the exercise
execution path; logs in page 01 summarize Lambda handler/worker diagnostics.
Step Functions logs use ERROR level without execution data. The AWS4
icon and connector conventions follow the requested
[aws-drawio-diagram skill](https://github.com/sagochiko/aws-drawio-diagram-skill),
while retaining the original frame styles.

Mermaid sources can be rendered with `diagrams/render.sh` when its documented
Mermaid CLI is available. Previously generated Mermaid/JAWS slide exports are
historical; current guides do not embed those stale images as current evidence.
The JAWS exporter reads its preserved landing-page Draw.io copy, so regenerating
that historical talk cannot overwrite the current diagram or mix architectures.
