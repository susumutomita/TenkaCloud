# Verify a host candidate from a clean checkout

Use the exact reviewed commit, Bun 1.3.11 and a Docker engine. These commands
create disposable local exercise resources. They do not access AWS or publish an
image. Use an empty checkout and keep existing competition data separate.

```sh
git submodule update --init --recursive
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run test:host
bun run test:authoring
bun run check:host-imports
bun run build:host
make before-commit
```

Build a locally tagged candidate with source and catalog labels:

```sh
docker build -f docker/host/Dockerfile \
  --build-arg TENKACLOUD_SOURCE_COMMIT="$(git rev-parse HEAD)" \
  --build-arg TENKACLOUD_CATALOG_COMMIT="$(git rev-parse HEAD:problems)" \
  -t tenkacloud-host:review .
TENKACLOUD_HOST_IMAGE=tenkacloud-host:review bun run test:host:container
bun run release:candidate --image tenkacloud-host:review --out .tenkacloud/host-candidate-built.json
```

The container rehearsal creates its own volume, serves both real applications,
starts a two-team Cryptography Battle, restarts the container with the same
volume, and checks organizer-key login, participant access, ready players and team vault. It removes only
its disposable container and volume in `finally`. The direct Docker exercise
rehearsal uses `bun run test:host:docker`; the browser rehearsal uses
`bun run test:host:e2e`. Run them sequentially on constrained machines.

Candidate capture rejects a dirty source tree, missing image tag, and labels that
do not match the checkout's source/catalog pins. `imageId` records Docker inspect's
`Id`; `registryDigests` copies its `RepoDigests`. Local builds can populate both,
and the kind of digest returned as `Id` depends on the Docker image store. Neither
field proves publication. No workflow in this change pushes a host image or
creates a release tag. Publication requires a later reviewed command, attached
verification evidence and a digest verified against the target registry.

Historical `release/tenkacloud-release.*` remains unchanged and describes the old
release. `release/launcher-defaults.json` records the current cloud launcher's
pinned source contract and `candidate/unreleased` classification, matching
`infrastructure/templates/cloud-pipeline.yaml`. Neither record advertises this
candidate as the public v1.11.0 release.

Use [host operations](local-hosting.md) for public origins, proxy settings and
persistent volume ownership. For an AWS/IdP rehearsal use the separate
[optional live procedure](host-rehearsal.md).
