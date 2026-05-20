# Contributing

Contributions to TenkaCloud are welcome.

## Setup

```bash
git clone --recurse-submodules https://github.com/<your-username>/TenkaCloud.git
cd TenkaCloud
make install
make start
```

## Development flow

1. Pick an issue (`good first issue` / `help wanted`)
2. Create a branch: `git checkout -b feat/your-feature`
3. Write tests first (TDD). Test titles use the Japanese pattern `〜すべき` — match this style for consistency with the existing suite.
4. Run `make before-commit` (lint / format / typecheck / tests / build)
5. Open a PR (title under 70 characters, Conventional Commits)

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.

## Rules and constraints

See [CLAUDE.md](./CLAUDE.md) for project rules, architecture invariants, and prohibited patterns. The same rules apply whether the change is made by a human or by an AI agent.

## Questions

- [GitHub Discussions](https://github.com/susumutomita/TenkaCloud/discussions)
- [GitHub Issues](https://github.com/susumutomita/TenkaCloud/issues)

Contributions are released under the [Apache License 2.0](./LICENSE).
