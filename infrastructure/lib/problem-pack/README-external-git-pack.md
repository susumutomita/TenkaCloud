# External Git pack: manual runbook (real repository)

The automated end-to-end acceptance test
(`infrastructure/test/problem-pack/external-git-pack-e2e.test.ts`, Issue #2098)
proves the full external-Git-pack lifecycle DETERMINISTICALLY and OFFLINE: it
injects a fake Git transport that serves a local fixture pack pinned to a full
40-hex SHA, so it runs in CI with no real cloud and no real Git network.

This runbook documents the one part the offline test cannot exercise: fetching a
pinned revision from a SEPARATE REAL repository over HTTPS. Run it manually when
you want to verify the real `git`-backed transport end to end.

## Prerequisites

- A separate public Git repository that contains a valid problem pack — a
  `tenkacloud-pack.json` manifest at the pack root, or under a subdir. It MUST
  NOT live under this repo's core `problems/` tree.
- `git` available on PATH (the real fetcher shells out to `git` plumbing with
  hooks disabled and lifecycle scripts never run).

## Steps

1. Author + validate the pack in the external repo (outside this core repo).
   The pack CLI runs from this repo's root via the `make pack-*` wrappers
   (without make: `cd <repo-root> && ./node_modules/.bin/tsx
   infrastructure/bin/tenkacloud-pack.ts <subcommand> …`):

   ```bash
   make pack-init ARGS="/path/to/external-pack"
   # Edit the scaffolded tenkacloud-pack.json (id, title, ...) and the problem.
   make pack-validate ARGS="/path/to/external-pack"
   ```

   (The scaffolder rejects `..` path segments by design, so point `pack-init`
   at an absolute path when the pack lives outside this repo.)

   Commit and push it to the separate repository, then note the FULL 40-hex
   commit SHA of the revision you want to pin (`git rev-parse HEAD`). A branch
   name, tag, `HEAD`, or abbreviated hash is rejected by design.

2. Install the exact pinned revision over HTTPS (real transport):

   ```bash
   make pack-install ARGS="git https://github.com/<you>/external-pack.git --commit <full-40-hex-sha> [--subdir <path>]"
   ```

   Confirm the lock (`packs-lock.json`) records `sourceKind: "git"`, the resolved
   commit, the optional subdir, and a content digest.

3. Activate the revision for ONE tenant, confirm a SECOND tenant does not see it,
   create an event that pins its problem, and confirm a deployment resolves the
   pack provenance from the event's pinned snapshot.

4. Deactivate the pack (or install a newer revision); confirm the existing
   event's pinned catalog is UNCHANGED.

5. Confirm `pack remove` is refused while the revision is pinned by an event or
   activation, and succeeds once every reference is removed.

The contracts checked manually here are the same ones the offline e2e asserts
against injected fakes; only the transport (real `git` over HTTPS) differs.
