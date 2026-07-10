<!-- markdownlint-disable MD033 -->
<div align="center">

**English** | [日本語](./README.ja.md)

# TenkaCloud

**Run real cloud drills. Build reusable AWS problem catalogs.**

TenkaCloud is a self-hostable, Apache-2.0 platform for running hands-on AWS competitions. Organizers manage events, teams, deploys, scoring, hints, and per-team AWS Console federation from one application; participants solve real AWS scenarios in isolated accounts.

[Landing page](https://tenkacloud.com) · [Demo portal](https://tenkacloud.com/portal-demo/?demo=1) · [Quickstart](#quickstart) · [Add your own problems](#add-your-own-problems)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/susumutomita/TenkaCloud)
[![CI](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml/badge.svg)](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/susumutomita/TenkaCloud/graph/badge.svg?token=WfleGvJor9)](https://codecov.io/gh/susumutomita/TenkaCloud)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

</div>

> TenkaCloud is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Amazon Web Services, Inc. AWS and related marks are trademarks of Amazon.com, Inc. or its affiliates.

---

## Vision

TenkaCloud is not only a competition platform. The product direction is a path from safe, individual practice to team competition: **local drills → practical courses / enterprise training → team competitions / GameDay → global community**. Local drills are live today (`make local`); courses, enterprise training as a packaged product, and a global community are directions we are building toward, not shipped features. See [`docs/vision.md`](./docs/vision.md) for the full picture.

## What TenkaCloud gives you

TenkaCloud turns a problem catalog into a live cloud drill:

1. **Create an event** in the Application Admin Console.
2. **Select problems** from the catalog.
3. **Register teams** and their AWS account trust settings.
4. **Deploy problem stacks** into each team's isolated AWS account (cross-account `AssumeRole` + required `ExternalId`).
5. **Run the event** — participants use the portal for instructions, hints, submissions, scores, and one-click AWS Console federation.

| Style | Use it for | Scoring |
| --- | --- | --- |
| **Challenge** | Self-paced AWS tasks and labs | Flag / answer submission |
| **Battle** | Real-time operations drills | Health probes, phased polling, attack detection, or other catalog-declared scoring |

## Quickstart

### Try it in your browser (GitHub Codespaces, zero install)

Codespaces plays **cloud-independent drills only** — self-contained Docker container problems that need no AWS account. AWS problems (deployed into your own AWS account) are not playable in Codespaces; see **Deploy on AWS** below for those.

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/susumutomita/TenkaCloud)

1. Click the badge above → **Create codespace on main** (the first build installs Bun, initializes `problems/`, and starts Docker for you).
2. Run the **"▷ ローカルプレイ開始"** task (Command Palette → **Tasks: Run Task**, or `Cmd/Ctrl+Shift+B`) — it runs `make local` for you.
3. Once the Participant Portal is running, open the **PORTS** tab and click the preview icon next to port **5175**.

> Stay inside the codespace: drill links go through the port `5175` preview URL; a raw `127.0.0.1` URL pasted into a browser tab on your own machine will not work.

### Try it locally (no AWS)

`make local` is the single local drill entry point: it starts the local scoring API and the Participant Portal, then you pick and start a drill from the portal screen that opens. It installs nothing and does not trust `mise`; use `make local-onboard` for guided setup.

```bash
git clone https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make install
git submodule update --init problems
make local
```

`make local-list` lists every drill id if you would rather pre-start one with `make local PROBLEM=<id>` instead of picking it from the portal. See [docs/local-play.md](./docs/local-play.md) for that and every other detail.

### Deploy on AWS

Deploy from the AWS Console — a CloudFormation stack creates a CodeBuild project that git-clones this repo and runs the deploy for you, **no local install, no GitHub connection**.

1. Download [`infrastructure/templates/lite-pipeline.yaml`](./infrastructure/templates/lite-pipeline.yaml).
2. Open the [CloudFormation create-stack page](https://console.aws.amazon.com/cloudformation/home?region=ap-northeast-1#/stacks/create/template) in `ap-northeast-1` → **Upload a template file** → upload it → stack name **`tenkacloud-lite-launcher`**.
3. Set **`TenantAdminEmail`** (the only required parameter) to your Admin Console login email. *(To ship your own problems, also set `ProblemsRepoUrl` — see [Add your own problems](#add-your-own-problems).)*
4. Check **acknowledge IAM** and create the stack.
5. Open the CodeBuild project from the stack's **`StartBuildConsoleUrl`** output and press **Start build**.

After ~15-30 minutes the build finishes. The **Admin Console** and **Participant Portal** URLs are in the **Outputs** of the `tenkacloud-lite` and `tenkacloud-lite-problem-deploy` stacks that the build creates.

**Tear down:** in the same CodeBuild project, choose **Start build with overrides**, set `ACTION` to `destroy`, and start it; then delete the `tenkacloud-lite-launcher` stack to remove the CodeBuild project itself.

## Running costs

TenkaCloud runs in one of two profiles, selected by the `CDK_PARAM_CONTROL_DATA_BACKEND` env var (unset = default).

| Profile | For | Control data | Problem deploy |
| --- | --- | --- | --- |
| **AWS-native** (default, unset or `dynamodb`) | Teams / companies who want everything inside AWS | DynamoDB (provisioned 1/1), 8 tables + 8 GSIs | Lambda `CreateStack` (default) |
| **Zero-cost** (opt-in, `turso`) | Individuals, trials, personal events | Turso (libSQL) — 0 DynamoDB tables / 0 GSIs in the Lite synth | Lambda `CreateStack` (default) |

Opting in to the zero-cost profile is four steps: create a Turso database, store its token in SSM as a `SecureString`, add three `CDK_PARAM_TURSO_*` lines to your `.env`, then `make deploy`. For the full walkthrough, the migration path for an existing `dynamodb`-backed stack, measured costs, and the current live-verification status, see [docs/running-costs.md](./docs/running-costs.md).

## Add your own problems

You never fork this platform to add problems. There are two paths, depending on whether the problem should be shared:

- **Contribute to the official catalog** — for problems the wider community can reuse.
- **Add a private Problem Pack** — for internal-only or one-off problems that never need to leave your own machine or tenant.

### Option A: contribute to the official catalog

Problems live in their own repo — [TenkaCloudChallenge][catalog], cloned in at deploy time.

1. **Fork** [TenkaCloudChallenge][catalog].
2. **Author + validate** with its tooling — `scripts/new-problem.ts` scaffolds a problem; the schema and validators check it before you ship.
3. **Deploy your catalog** — run the [Quickstart](#quickstart) with `ProblemsRepoUrl` set to your fork. Nothing else changes.

A problem directory is three files: `metadata.json` (catalog display + scoring rule + portal slot wiring), `template.yaml` (the CloudFormation deployed into the team's isolated AWS account), and an optional `portal/` (React components for the Participant Portal).

### Option B: add a private Problem Pack

A **Problem Pack** (Issue #2088) is an offline-validated bundle of one or more problems that you install and activate for a single tenant without publishing to the catalog repo — a fit for internal-only drills or a one-off event problem. The `pack` CLI runs entirely locally: no cloud calls, no network unless you install from a pinned Git commit.

```bash
make pack-init ARGS="./my-pack --runtime aws/cloudformation"        # scaffold a pack
make pack-validate ARGS="./my-pack"                                  # check manifest + template
make pack-install ARGS="./my-pack"                                   # snapshot + lock it
make pack-activate ARGS="com.example.starter@0.1.0 --tenant local"   # activate for one tenant
# then create the event in the Application Admin Console — the activated
# pack's problems appear in the catalog picker there
```

`local` is Lite mode's fixed tenant id, which is what `make deploy` reads at synth time — activate against that tenant id for a real Lite deploy. SaaS mode (`make deploy-saas`) refuses to synth while any pack activation exists, rather than silently dropping it from the pooled catalog.

More detail: [concepts](./apps/developer-portal/src/app/developers/docs/concepts/problem-packs/page.mdx) · [tutorial](./apps/developer-portal/src/app/developers/docs/tutorials/first-pack/page.mdx) · [manifest reference](./apps/developer-portal/src/app/developers/docs/reference/pack-manifest/page.mdx) · [installing from a pinned Git commit](./infrastructure/lib/problem-pack/README-external-git-pack.md). The developer portal is not deployed yet, so these links point at the in-repo MDX source; every `make pack-*` command above is a live, working CLI today.

Live, end-to-end verification of the pack flow has not been run yet (#2459 closed with this recorded as remaining work).

[catalog]: https://github.com/susumutomita/TenkaCloudChallenge

## Enterprise / internal training

If you are considering TenkaCloud for enterprise or internal training use — hands-on security/operations drills, evaluation or onboarding exercises, custom/private problem sets, or instructor-led workshops — please feel free to reach out via the [contact form](https://forms.gle/djVprYmq3hFgJA7P9) or [GitHub Discussions](https://github.com/susumutomita/TenkaCloud/discussions). TenkaCloud is open source, but we would love to learn more about real-world training needs.

## Documentation

- [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) — local terminal deploys, SaaS mode, and [Always-On mode](./DEPLOYMENT_GUIDE.md#always-on-mode-adr-049) (zero always-on compute between events; operator runbook: [docs/always-on/README.md](./docs/always-on/README.md))
- [docs/local-play.md](./docs/local-play.md) — local drill internals, authoring a container problem, the `/verify` contract
- [docs/running-costs.md](./docs/running-costs.md) — the cost profiles, the zero-cost opt-in walkthrough, measured costs
- [docs/vision.md](./docs/vision.md) — product direction and what is live vs. planned
- [docs/architecture/README.md](./docs/architecture/README.md) — ADRs and system design

## Contributing

1. Read [CONTRIBUTING.md](./CONTRIBUTING.md) and [AGENTS.md](./AGENTS.md).
2. Keep infrastructure / template changes separate from application-code changes.
3. Run `make harness` and `make before-commit` before opening a PR.

## License

[Apache License 2.0](./LICENSE) — use commercially, modify, and distribute.
