# Contributing

Use the [README](./README.md) to try TenkaCloud locally or host an event on AWS.
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
mise exec -- make doctor-dev
```

Review `mise.toml` before trusting it; this allows mise to load the checkout's configuration.

Read [AGENTS.md](./AGENTS.md) for platform boundaries. Use the
[developer manual](./apps/developer-portal/src/app/developers/docs/manual/developer/page.mdx)
for code ownership, or the [LLM task guide](./landing/llms-full.txt) to locate code
by symptom. An AWS deployment is needed only when your change requires one.

For participant UI development, run `make local-onboard`, then `make local-dev`.
For a single SPA, use its dev server, for example
`cd apps/application-admin-console && make dev`. See [Local play](./docs/local-play.md)
for required services and ports.

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
