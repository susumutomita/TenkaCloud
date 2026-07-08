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
2. Skim [CLAUDE.md](./CLAUDE.md) and [AGENTS.md](./AGENTS.md) for the architecture (the four planes), the directory map, and the project rules.

## Development flow

1. Pick an issue (`good first issue` / `help wanted`) or a starter task from
   [ROADMAP.md](./ROADMAP.md#good-first-issue-candidates)
2. Create a branch: `git checkout -b feat/your-feature`
3. Write tests first (TDD). Test titles use the English `should ...` pattern — match this style for consistency with the existing suite.
4. Run `make before-commit` (lint / format / typecheck / tests / build)
5. Open a PR (title under 70 characters, Conventional Commits)

## Comment attachments

Do not submit zip archives, binaries, installer files, shell scripts, or patch
files through Issue / PR comments. TenkaCloud reviews code changes through normal
pull requests so maintainers can inspect the diff and CI result before running or
downloading anything.

## Roadmap and starter tasks

- [ROADMAP.md](./ROADMAP.md) shows the current product direction.
- [`problems/CATALOG.md`](./problems/CATALOG.md) lists the available problems and bundles.
- Starter tasks should stay small enough for one focused PR.

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.

## Rules and constraints

See [CLAUDE.md](./CLAUDE.md) for project rules, architecture invariants, and prohibited patterns. The same rules apply whether the change is made by a human or by an AI agent.

## Project provenance

TenkaCloud is an independent open-source project. Do not contribute an employer's
source code, confidential documents, customer data, private competition content, or
other proprietary assets — contribute only original or compatibly licensed work.

## Join the community

TenkaCloud's moat is its problem catalog, and that catalog grows through community contribution. The simplest first contribution is to play-test a problem (run `make deploy` in Lite mode, register a team, solve and score it) and file a `problem-feedback` issue, or to author a new problem in the [TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge) catalog repo.

Coordination model: **GitHub is the durable source of truth**; Discord (when available) is for live coordination only — every decision and bug must end up as a GitHub issue or PR comment. GitHub-only contributors are first-class.

## Questions

- [GitHub Discussions](https://github.com/susumutomita/TenkaCloud/discussions)
- [GitHub Issues](https://github.com/susumutomita/TenkaCloud/issues)

Contributions are released under the [Apache License 2.0](./LICENSE).
