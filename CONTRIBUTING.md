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

For first-time contributors, read in this order:

1. [`docs/architecture/OVERVIEW.md`](./docs/architecture/OVERVIEW.md) — what TenkaCloud is, the 4 planes, why Lite vs SaaS exists
2. [`CONTRIBUTOR_MAP.md`](./CONTRIBUTOR_MAP.md) — pick the recipe matching your goal (new problem / Lambda bug / admin UI / etc)
3. [`docs/architecture/GLOSSARY.md`](./docs/architecture/GLOSSARY.md) — definitions for AppPlane / ControlPlane / TrustBridge / ParticipantViewerRole / etc

For directory-level "where is X" lookups, [`docs/architecture/MODULE_MAP.md`](./docs/architecture/MODULE_MAP.md) is the index.

## Development flow

1. Pick an issue (`good first issue` / `help wanted`) or a starter task from
   [ROADMAP.md](./ROADMAP.md#good-first-issue-candidates)
2. Create a branch: `git checkout -b feat/your-feature`
3. Write tests first (TDD). Test titles use the English `should ...` pattern — match this style for consistency with the existing suite.
4. Run `make before-commit` (lint / format / typecheck / tests / build)
5. Open a PR (title under 70 characters, Conventional Commits)

## Roadmap and starter tasks

- [ROADMAP.md](./ROADMAP.md) shows the current product direction.
- [Competition Gallery](./docs/gallery.md) lists available examples and new
  problem ideas.
- Starter tasks should stay small enough for one focused PR.

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.

## Rules and constraints

See [CLAUDE.md](./CLAUDE.md) for project rules, architecture invariants, and prohibited patterns. The same rules apply whether the change is made by a human or by an AI agent.

## Project provenance

TenkaCloud is an independent open-source project. Before contributing, read
[`docs/PROJECT_PROVENANCE.md`](./docs/PROJECT_PROVENANCE.md): it records the
project's development boundaries and the influence-versus-copying distinction.
Do not contribute an employer's source code, confidential documents, customer
data, private competition content, or other proprietary assets — contribute
only original or compatibly licensed work.

## Join the community

TenkaCloud's moat is its problem catalog, and that catalog grows through community contribution. Pick one of six roles and ship one starter task — you do not need to be personally onboarded.

- **[docs/community/ONBOARDING.html](./docs/community/ONBOARDING.html)** — role chooser (Tester / Problem Author / Scenario Reviewer / Event Facilitator / Platform Contributor / Sponsor-Requester), with the expected contribution, required skill level, first task, communication channel, time commitment, and recognition path for each role.
- **[docs/community/PLAYTEST-CHECKLIST.html](./docs/community/PLAYTEST-CHECKLIST.html)** — 30-minute playtest protocol for the Tester role: pick a problem, run `make deploy` in Lite mode, register a team, solve, score, and file a `problem-feedback` issue with a structured template.
- **[docs/community/PROBLEM-REVIEW-CHECKLIST.html](./docs/community/PROBLEM-REVIEW-CHECKLIST.html)** — rubric for the Scenario Reviewer role: scoring fairness, hint progression, no-skip-by-luck, time-to-solve estimate, scenario realism, template security (cross-references [#1353](https://github.com/susumutomita/TenkaCloud/issues/1353) for security hardening).

Coordination model: **GitHub is the durable source of truth**; Discord (when available) is for live coordination only — every decision and bug must end up as a GitHub issue or PR comment. GitHub-only contributors are first-class.

## Questions

- [GitHub Discussions](https://github.com/susumutomita/TenkaCloud/discussions)
- [GitHub Issues](https://github.com/susumutomita/TenkaCloud/issues)

Contributions are released under the [Apache License 2.0](./LICENSE).
