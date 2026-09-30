# TenkaCloud

[日本語](README.ja.md)

TenkaCloud hosts cloud competitions from one Bun process and a persistent SQLite
store. The host serves the organizer console and participant portal. AWS problem
resources run in competitor accounts; Docker exercises require a local Docker
engine. Participants use the portal URL and team key supplied by their organizer.

This branch is an **unpublished host-only candidate**. SaaS, Lite, CDK/Lambda
platform deployment and `make local` are retired. Existing installations must use
[their pinned legacy release](docs/legacy-operations.md). There is no automatic
migration or cleanup. [The retirement matrix](docs/host-retirement.md) lists the
missing host features and the unresolved standalone deploy API decision.

[![Historical overview](docs/assets/lp-30s/tenkacloud-30s-preview.gif)](landing/videos/lp/tenkacloud-30s.mp4)

Historical product overview, recorded for the retired local/Lite workflow. This is not host candidate verification. [Vertical video](landing/videos/lp/tenkacloud-30s-vertical.mp4).

## Quickstart

Use Bun 1.3.11 and the pinned `problems/` catalog. Install the tools in `mise.toml`
or provide compatible tools yourself.

```sh
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
bun install --frozen-lockfile --ignore-scripts
bun run build:host
make host HOST_ARGS="--no-build"
```

Use the organizer URL printed by the process. Use the private host key once to
create the first local Admin, then sign in with that account's password. Create an
event, deploy its team environments, distribute the team keys, then start it. Stopping the server preserves its database and exercise environments.
Remove exercise resources through the event's Teardown action when appropriate.

Only the host catalog's listed problems are executable. The retained authoring
catalog includes scenarios the host does not support. Docker and AWS exercises
need their respective runtime prerequisites; the built-in Cryptography Battle
requires neither AWS nor the Docker daemon.

Read [host operations](docs/local-hosting.md) for data directories, public
origins, TLS proxy configuration and the optional AWS runtime. The admin and
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
