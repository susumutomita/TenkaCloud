# Contributing

Contributions to TenkaCloud are welcome.

## Setup

```bash
git clone --recurse-submodules https://github.com/<your-username>/TenkaCloud.git
cd TenkaCloud
make install
make build   # verify the toolchain compiles
```

To run a single SPA locally, start its dev server from the app directory, e.g.
`cd apps/application-admin-console && make dev`. To deploy into AWS, follow the
[Quickstart](./README.md#quickstart).

## Where to start (under 15 minutes)

For first-time contributors:

1. Read the [Quickstart](./README.md#quickstart) and run Lite mode once.
2. Read [AGENTS.md](./AGENTS.md) for the working contract and platform boundaries.

## Development flow

1. Pick an issue labeled [`good first issue`](https://github.com/susumutomita/TenkaCloud/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22good%20first%20issue%22) or [`help wanted`](https://github.com/susumutomita/TenkaCloud/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22help%20wanted%22).
2. Create a branch: `git checkout -b feat/your-feature`
3. Implement one working change and verify the affected behavior with relevant tests.
   Choose the implementation and test order to fit the task; use focused checks while iterating.
4. Inspect the diff and stage only intended files. Commit with `make before-commit`
   passing (lint, dead-code checks, and tests); the pre-commit hook runs it automatically.
   Run relevant type/build checks too. `make ci-local` is available when you need the
   complete local CI sequence, including dependency audit and coverage.
5. Open a PR with the problem, resulting behavior, verification, and any material risk
   (title under 70 characters, Conventional Commits).

The hook checks that `problems/` matches its staged commit; it never updates or
switches the catalog checkout. On a fresh clone, initialize it with
`git submodule update --init --recursive problems`. If you have catalog work in
progress, preserve it before aligning the checkout or staging an intentional pin update.

## Comment attachments

Do not submit zip archives, binaries, installer files, shell scripts, or patch
files through Issue / PR comments. TenkaCloud reviews code changes through normal
pull requests so maintainers can inspect the diff and CI result before running or
downloading anything.

## Starter tasks

- [`problems/CATALOG.md`](./problems/CATALOG.md) lists the available problems and bundles.
- Starter tasks should stay small enough for one focused PR.

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.

## Rules and constraints

See [AGENTS.md](./AGENTS.md) for project rules and platform boundaries. The same rules apply whether the change is made by a human or by an AI agent.

## Project provenance

TenkaCloud is an independent open-source project. Do not contribute an employer's
source code, confidential documents, customer data, private competition content, or
other proprietary assets — contribute only original or compatibly licensed work.

## Join the community

TenkaCloud's moat is its problem catalog, and that catalog grows through community contribution. The simplest first contribution is to play-test a problem (run `make deploy` in Lite mode, register a team, solve and score it) and file a `problem-feedback` issue, or to author a new problem in the [TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge) catalog repo.

Problems that should stay private — internal-only drills, a one-off event problem — do not need a catalog contribution at all: see [Add your own problems / Option B](./README.md#add-your-own-problems) for the offline Problem Pack CLI (`make pack-init` / `pack-validate` / `pack-install` / `pack-activate`).

Coordination model: **GitHub is the durable source of truth**; Discord (when available) is for live coordination only — every decision and bug must end up as a GitHub issue or PR comment. GitHub-only contributors are first-class.

## Questions

- [GitHub Discussions](https://github.com/susumutomita/TenkaCloud/discussions)
- [GitHub Issues](https://github.com/susumutomita/TenkaCloud/issues)

Contributions are released under the [Apache License 2.0](./LICENSE).
