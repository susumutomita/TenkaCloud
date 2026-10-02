# Contributing

Use the [README](./README.md) to host an event from a local process or container.
This guide is for changes to the platform. Problem content belongs in
[TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge) or a
[private Problem Pack](./README.md#add-your-own-problems).

## Prepare for code changes

Install Git and [mise](https://mise.jdx.dev/), then use the repository's pinned tools:

```bash
git clone --recurse-submodules https://github.com/<your-username>/TenkaCloud.git
cd TenkaCloud
mise trust
mise install
mise exec -- make install
```

Review `mise.toml` before trusting it; this allows mise to load the checkout's configuration.

Read [AGENTS.md](./AGENTS.md) for platform boundaries. Use the
[developer manual](./apps/developer-portal/src/app/developers/docs/manual/developer/page.mdx)
for code ownership, or the [LLM task guide](./landing/llms-full.txt) to locate code
by symptom. An AWS deployment is needed only when your change requires one.

Build the host interfaces with `bun run build:host`, then run `make local
LOCAL_ARGS="--no-build"`. Stop with `make down` to keep event and problem data. Docker is required only for Docker problem execution.
Use `bun run test:host` for real HTTP/SQLite tests and `bun run test:authoring`
for the retained pack tools. See [clean checkout verification](docs/host-build-verification.md).
The old mode-specific launchers are retired. Cloud hosting selectively reuses the
serverless backend without SaaS/SBT and is still under integration verification.

The default `make help` separates hosting commands from these development commands:

- `make install`: install dependencies without lifecycle scripts
- `make test`: run root, authoring, host and workspace tests
- `make lint`: check Markdown, prose, formatting and typed TypeScript lint
- `make before-commit`: run lint, dead-code checks and the complete test suite

## Make one reviewable change

1. Start from a request or [open issue](https://github.com/susumutomita/TenkaCloud/issues).
   Define what a user should be able to do after the change.
2. Create a branch, inspect the owning code and nearby tests, and implement the change.
3. Run relevant tests, type checks, and builds. Update English and Japanese docs together.
4. Inspect the diff and stage only intended files. A normal commit runs
   `make before-commit`: lint, dead-code checks, and tests. Use `make ci-local`
   when you also need the full local CI sequence, including coverage and dependency audit.
5. Open a PR describing the problem, resulting behavior, verification, and material risks.
   Use a [Conventional Commit](https://www.conventionalcommits.org/) title under 70 characters.

The hook checks that `problems/` matches its staged commit and never switches its
checkout. Initialize a fresh clone with `git submodule update --init --recursive problems`.
Preserve catalog work before aligning a checkout or staging a deliberate pin update.
Report any live AWS or browser checks that were not run.

## Share work and ask for help

- File reproduction steps and expected/actual behavior in an Issue; propose code in a PR.
  Do not attach archives, binaries, installers, scripts, or patches to comments.
- Contribute original or compatibly licensed work. Do not include employer code,
  confidential documents, customer data, credentials, or private competition content.
- Keep decisions and bug reports on GitHub so contributors can follow them asynchronously.
  Ask questions in [Discussions](https://github.com/susumutomita/TenkaCloud/discussions).

Contributions are released under the [Apache License 2.0](./LICENSE).
