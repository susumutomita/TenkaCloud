# External Git problem packs

Pack tools create, validate and store reusable problem content independently of
the competition runtime. Installing a pack does not add it to the event catalog.
The [pack tutorial](../../apps/developer-portal/src/app/developers/docs/tutorials/first-pack/page.mdx)
explains the authoring contract; [TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge)
is the competition catalog.

## Create and validate

Run from the TenkaCloud checkout with its dependencies installed:

```bash
bun run pack init /path/to/my-pack
bun run pack validate /path/to/my-pack
```

Complete the scaffold's problem and provider artifact, add tests, then validate
again. A manifest and placeholder are not a playable exercise. Use an absolute
path outside this checkout; the scaffolder rejects `..` path segments.

## Install a reviewed revision

Publish the authored pack to your own repository after reviewing it. Record its
full 40-character commit SHA; branches, tags and abbreviated hashes are not
accepted as immutable revisions.

```bash
bun run pack install git https://github.com/<you>/my-pack.git --commit <full-40-character-sha>
bun run pack list
bun run pack inspect <pack-id>@<version>
```

Use `--subdir <path>` when the manifest is below the repository root. Check that
`packs-lock.json` records the source URL, resolved commit, subdirectory and content
digest. Fetching uses Git over HTTPS with hooks disabled. Installation does not
run lifecycle scripts or deploy provider resources.

## Remove a stored revision

```bash
bun run pack remove <pack-id>@<version>
```

Removal refuses revisions still referenced by local activation or event-pin
records. Inspect and resolve those references first. Removing a snapshot does not
tear down an AWS stack or a running exercise.

## What the repository verifies

The [external Git acceptance test](test/external-git-pack-e2e.test.ts) exercises
immutable fetch, validation, provenance, scoped activation records, event pins and
removal with an injected transport. Golden and reference packs test the same
contracts offline. The manual Git install above checks the real network transport;
it is not a live AWS rehearsal. Cloud deployment consumes activated AWS/CloudFormation packs from the default store; see the hosting steps below.

## Private content and Cloud hosting

Keep company problems and pre-publication event content in a private local directory. Install it with `bun run pack install /path/to/my-pack`; publication is not required. For a private Git repository, obtain an authorized checkout separately: the CLI Git fetcher disables credential helpers.

Activate with `bun run pack activate <id>@<version> --tenant local` from the platform root. The Cloud loader consumes this fixed selector and `.tenkacloud/pack-store`; `local` here does not mean Local hosting. Normal source packaging includes this store in the private archive. Update Cloud between events with `make deploy`, then select the supported problem in a new event. Existing events retain their saved catalog. Rehearse solving, scoring and teardown; installation alone is not a playability check.

Local does not consume Pack activation records. Its supported private problems can live in the local `problems/` tree without publishing. There is no automatic publication after an event.
