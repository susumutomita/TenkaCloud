# TenkaCloud

[日本語](README.ja.md)

TenkaCloud supports local and cloud competition hosting with the organizer console
and participant portal. Local hosting uses one Bun process and persistent SQLite.
Cloud hosting is being restored with AWS Lambda and DynamoDB. SaaS/SBT tenant
provisioning is not part of this direction.

This branch is a **draft integration candidate**. `make local` opens the unified
local competition console for non-AWS exercises. AWS-service problems belong to
cloud hosting, whose complete lifecycle remains under verification. Participants
use the portal URL and team key supplied by their organizer.

Existing installations must use [their pinned legacy release](docs/legacy-operations.md).
There is no automatic migration or cleanup. [The compatibility matrix](docs/host-retirement.md)
distinguishes working local features, incomplete cloud wiring and retired entrypoints.

[![Historical overview](docs/assets/lp-30s/tenkacloud-30s-preview.gif)](landing/videos/lp/tenkacloud-30s.mp4)

Historical product overview, recorded for the retired local/Lite workflow. This is not integration-candidate verification. [Vertical video](landing/videos/lp/tenkacloud-30s-vertical.mp4).

## Quickstart

Use Bun 1.3.11 and the pinned `problems/` catalog. Install the tools in `mise.toml`
or provide compatible tools yourself.

```sh
git clone --recurse-submodules --branch integration/host-only-20261001 https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
bun install --frozen-lockfile --ignore-scripts
bun run build:host
make local LOCAL_ARGS="--no-build"
```

Use the organizer URL printed by the process and sign in with the organizer key.
A fresh key is shown once in the interactive terminal; no username or password is needed.
Use `make local-reset` if you lose the key. It rotates only organizer access and signs
out existing organizer sessions while retaining events, scores and participant keys. Create an
event, prepare its team environments, distribute the team keys, then start it.
Participants start or resume local exercises when needed; preparation does not start every container.
Run `make down` from another terminal to stop this local controller and its owned
Docker environments. Event data, keys, container writable layers and volumes remain.
After `make local`, participants resume on-demand exercises from their portal.
Older eager events retain their existing restart behavior. In-memory state
inside stopped exercise processes is not a persistence guarantee.
Remove exercise resources through the event's Teardown action when appropriate.
Normal shutdown retains SQLite, problem seeds and Compose plans. Successful explicit
teardown removes known generated runtime files; old or unknown temporary files are
not swept automatically. See [generated-file ownership](docs/local-hosting.md#generated-files-and-retained-data).

Cloud commands are `make deploy` and `make destroy`. They use the current
Lambda/DynamoDB CLI. If the project toolkit is missing, `make deploy` displays
the account, region, IAM resources and permission scope, asks for initial-setup
approval, then installs the toolkit and continues deployment with the same AWS
credentials. Existing toolkits are validated and reused. See
[setup and permission requirements](infrastructure/README.md#current-checkouts-setup-and-teardown-boundary).
The current cloud catalog includes hello-world with scoped CLI access and native
Cryptography Battle backed by DynamoDB. Docker/Compose exercises are local-only and
are not listed in the cloud catalog. Synchronized Battle bursts still exceed the
five-second refresh interval. Destroy confirms the account,
region and owned resources, drains recorded exercises, and retains event data.
Retained storage and AWS usage can incur charges. `CLOUD_ARGS="--help"` shows help
without contacting AWS. For cloud configuration, copy the matching
`infrastructure/environments/{development,staging,production}/.env.example` to
`.env` in the same directory if absent, then fill in the organizer email, account
and region. `make deploy ENV=development` loads that environment's file; see
[configuration and setup](infrastructure/README.md#current-checkouts-setup-and-teardown-boundary).
The preserved [cloud pipeline](infrastructure/README.md#cloud-deployment-pipeline)
uses the current source contract after explicit [first-account IAM setup](infrastructure/BOOTSTRAP-IAM.md#first-account-setup). Its advanced historical-source option retains the old complete flow.
Optional `make -s deploy CLOUD_ARGS="--show-setup"` prints permissions offline;
`--setup` installs the toolkit only. Unattended first deployment requires
`CLOUD_ARGS="--setup-if-needed --yes"` after review; `--yes` alone does not approve
initial IAM setup. The CLI never grants permissions to the caller.

The host exposes all 106 Compose exercise definitions as Challenges, including
workbenches and the 15 explicitly declared participant terminals. Catalog coverage
and synthetic lifecycle tests are not a claim that all 106 have passed real Docker
rehearsals. Local Docker exercises need Docker; the built-in Cryptography Battle
requires neither AWS nor the Docker daemon. AWS-service problems are not offered
by `make local`. Docker/Compose exercises remain local-only, as described in the
compatibility matrix. Native Cryptography Battle
runs inside the platform without a problem VM.

Default local admission limits are three active environments per team, twelve
across the host, and 4096 MiB of configured container memory caps. Stop preserves
container data; no other team is automatically stopped. See the resource options
in `make local LOCAL_ARGS="--help"` and measure your own Docker machine before an event.

Read [host operations](docs/local-hosting.md) for data directories, public
origins, TLS proxy configuration and retained data. The admin and
participant URLs are separate origins. Do not expose the organizer port without
the documented access controls.

## Container image

The image runs as uid 1000 and requires a dedicated persistent `/data` volume.
Read [build and restart verification](docs/host-build-verification.md) before
using a reviewed image. No host image has been published by this change.
[Candidate records](release/host-candidate.json) keep local image identity and
source/catalog pins separate from the historical v1.11.0 launcher release.

## Add your own problems

Problem content lives in [TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge).
The public SDK and offline pack tools remain available.

```sh
bun run pack init ./my-pack
bun run pack validate ./my-pack
bun run pack install ./my-pack
bun run pack list
```

Pack creation, validation, immutable snapshots and local activation records are
preserved. Installing or activating a pack does not add it to the host's runtime
catalog. See [pack tooling](scripts/problem-pack/README-external-git-pack.md) and
[the host retirement matrix](docs/host-retirement.md) before selecting a runtime.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md) and the
[developer manual](apps/developer-portal/src/app/developers/docs/manual/developer/page.mdx).
Run `make before-commit` before committing. The
[optional live rehearsal](docs/host-rehearsal.md) records the external AWS/IdP
boundary separately from local tests.

TenkaCloud is licensed under [Apache-2.0](LICENSE) and is not affiliated with AWS.

## Design books

[Build Your Own Cloud Competition](https://leanpub.com/build-your-own-cloud-competition) ·
[自分で作るクラウド競技](https://zenn.dev/bull/books/cloud-competition).
The books explain design decisions; the repository is the source of truth for how it currently works.
