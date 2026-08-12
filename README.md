<!-- markdownlint-disable MD033 -->
<div align="center">

**English** | [日本語](./README.ja.md)

# TenkaCloud

**Run real cloud drills. Build reusable AWS problem catalogs.**

TenkaCloud is a self-hostable, Apache-2.0 platform for running hands-on AWS competitions. Organizers manage events, teams, deploys, scoring, hints, and per-team AWS Console federation from one application; participants solve real AWS scenarios in isolated accounts.

<table>
<tr>
<td width="50%" align="center" valign="top">

**A. Play first** <sub>(recommended, no AWS, ~5 min)</sub>

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/susumutomita/TenkaCloud)

</td>
<td width="50%" align="center" valign="top">

**B. Host your own event** <sub>(AWS account, billed, ~30 min)</sub>

[**Deploy on AWS →**](#deploy-on-aws)

</td>
</tr>
</table>

<a href="./landing/videos/lp/tenkacloud-30s.mp4">
  <img src="./docs/assets/lp-30s/tenkacloud-30s-preview.gif" alt="30-second TenkaCloud overview: play in the browser, score, then host your own event on AWS" width="800">
</a>
<br>
<sub>30-second overview (silent, bilingual captions): play in the browser → score → host your own event on AWS. <a href="./landing/videos/lp/tenkacloud-30s.mp4">16:9 MP4</a> · <a href="./landing/videos/lp/tenkacloud-30s-vertical.mp4">9:16 MP4</a></sub>

[Landing page](https://tenkacloud.com) · [Manuals by role](https://tenkacloud.com/docs/manual/index.en.html) · [Demo portal](https://tenkacloud.com/portal-demo/?demo=1) · [Quickstart](#quickstart) · [Add your own problems](#add-your-own-problems)

[![CI](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml/badge.svg)](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/susumutomita/TenkaCloud/graph/badge.svg?token=WfleGvJor9)](https://codecov.io/gh/susumutomita/TenkaCloud)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

<a href="https://www.producthunt.com/products/tenkacloud?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-tenkacloud" target="_blank" rel="noopener noreferrer"><img alt="TenkaCloud - Open-source cloud competitions on real AWS accounts | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1209524&amp;theme=light&amp;t=1785406694086"></a>

</div>

> TenkaCloud is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Amazon Web Services, Inc. AWS and related marks are trademarks of Amazon.com, Inc. or its affiliates.

---

## Vision

TenkaCloud is not only a competition platform. The product direction is a path from safe, individual practice to team competition: **local drills → practical courses / enterprise training → team competitions / GameDay → global community**. Local drills are live today (`tenkacloud local`); courses, enterprise training as a packaged product, and a global community are directions we are building toward, not shipped features.

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

<div align="center">
  <a href="./docs/assets/codespaces-local-mode/codespaces-local-mode-readme-1280x720.mp4">
    <img src="./docs/assets/codespaces-local-mode/codespaces-local-mode-readme-preview.gif" alt="Bilingual 15-second GitHub Codespaces local-mode demo" width="800">
  </a>
  <br>
  <sub>Bilingual 15-second tour: Codespaces → <code>make local</code> → start a drill → instant local scoring.</sub>
</div>

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/susumutomita/TenkaCloud)

1. Click the badge above → **Create codespace on main** (the first build installs Bun, initializes `problems/`, and starts Docker for you).
2. Wait for the container to finish starting. Local play starts automatically, and **the Participant Portal opens automatically** in a preview tab — nothing to type.
3. If the preview does not open by itself, open the **PORTS** tab and click the preview icon next to port **5175**.

> Stay inside the codespace: drill links go through the port `5175` preview URL; a raw `127.0.0.1` URL pasted into a browser tab on your own machine will not work.
>
> **Optional manual re-run:** the automatic start has a four-minute window (the container image is pre-built during setup, so this is normally fast). If it times out (the Codespaces startup log says so), run the **"▷ ローカルプレイ開始"** task yourself (Command Palette → **Tasks: Run Task**, or `Cmd/Ctrl+Shift+B`) — it runs `make local` for you.

### Try it locally (no AWS)

`make local` is the participant entry point: it starts the local scoring API and the Participant Portal in a Docker container, then you pick and start a drill from the portal screen. Progress is stored in a Docker-managed volume; local play has no DynamoDB or AWS SDK dependency.

**Prerequisites: Git, Make, Docker Engine, Docker Compose v2 — no Bun, Node, or `node_modules` on your machine.** For CPU, memory, Docker allocation and free disk, see [the run profiles](./docs/local-play-requirements.md).

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make local
```

`make local` checks Docker is installed and running, fetches the `problems/` submodule if it's missing, builds/starts the local-play container, and prints the Portal URL once it's ready. `make local-down` stops it and clears progress; `make local-status` checks whether it's running.

> **Docker Desktop (macOS/Windows) users:** the local-play container runs with host networking, which Docker Desktop requires you to enable once — **Settings → Resources → Network → Enable host networking** (Desktop 4.34+). `make local` fails loud with this exact instruction if it detects the container came up without it; native Linux Docker Engine and Codespaces need no such setting.

<details>
<summary>For developers: the Bun/Vite hot-reload path</summary>

`make local-dev` runs the same local-play stack directly on the host with Bun and Vite (hot reload, no container rebuild per change) instead of Docker:

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make local-onboard
make local-dev
```

`make local-onboard` asks for consent before installing anything it needs — Bun itself if missing, the `problems/` submodule, and a Docker diagnosis — then reports readiness; it installs nothing without asking. Pass `YES=1` (`make local-onboard YES=1`) to pre-approve every install for unattended runs.

Even lower-level: `make install && git submodule update --init problems && bun link && tenkacloud local` (or `bun run tenkacloud local` without `bun link`). Run `tenkacloud local list` to list every drill id, or pre-start one with `tenkacloud local --problem <id>`. The optional remote state backend is selected explicitly with `--database turso` and `TENKACLOUD_LOCAL_TURSO_URL` / `TENKACLOUD_LOCAL_TURSO_AUTH_TOKEN`; SQLite remains the default.

</details>

See [docs/local-play.md](./docs/local-play.md) for every subcommand and the container/host boundary.

### Deploy on AWS

Deploy from the AWS Console — a CloudFormation stack creates a CodeBuild project that git-clones this repo and runs the deploy for you, **no local install, no GitHub connection**.

The launcher's repository defaults are the immutable platform/catalog pair of the last published
release baseline; the in-progress [`release manifest`](./release/tenkacloud-release.json) describes
the next release, whose platform commit is derived from its `v*` tag at publish time. The
[`generated release report`](./release/tenkacloud-release.md) currently classifies the launcher's
default pair as
**candidate / unverified**: pinning it prevents a moving `main` from changing the deployment, but
does not turn missing Golden Path evidence into certification. If either launcher stack ref
parameter is `main`, the launcher output and build log label it **development / unreleased**. A
one-build CodeBuild environment override changes only that build log; CloudFormation Outputs keep
describing the stack's saved parameters.

> **Design intent — an event-scoped, temporary environment.** The default lifecycle is *create a launcher for one event, deploy, run the event, tear it down* — not a permanently-running SaaS that auto-updates itself. Nothing stops you from leaving it up between events, but every step below (including teardown) is written for the per-event model. See [`infrastructure/templates/README.md`](./infrastructure/templates/README.md#cloudformation-console-lite-mode-deployment-pipeline) for the full launcher/build/destroy responsibility split and the per-parameter rebuild policy, and [`docs/operations/event-runbook.md`](./docs/operations/event-runbook.md) for the day-of-event flow.

1. Download [`infrastructure/templates/lite-pipeline.yaml`](./infrastructure/templates/lite-pipeline.yaml).
2. Open the [CloudFormation create-stack page](https://console.aws.amazon.com/cloudformation/home?region=ap-northeast-1#/stacks/create/template) in `ap-northeast-1` → **Upload a template file** → upload it → stack name **`tenkacloud-lite-launcher`**.
3. In the **Required** parameter group, set **`TenantAdminEmail`** to your Admin Console login email. The other groups are pre-filled; the repository defaults are the immutable candidate shown in the release report above. *(To ship your own problems, open **Advanced: repository sources** and set `ProblemsRepoUrl` — see [Add your own problems](#add-your-own-problems).)*
4. Check **acknowledge IAM** (the console explains why: the build's CodeBuild role needs broad permissions to deploy every TenkaCloud stack) and create the stack.
5. Open the CodeBuild project from the stack's **`StartBuildConsoleUrl`** output and press **Start build**.

There is no one-click *Launch Stack* badge above: CloudFormation's `templateURL` only accepts an S3 URL, and a GitHub raw URL fails validation (`TemplateURL must be a supported URL`). **Upload a template file** (step 2) is the recorded, supported one-click-equivalent for a self-hosted OSS project with no vendor-hosted S3 bucket to publish the template to.

**Why `Start build` stays a manual step:** creating the launcher stack never auto-starts a deploy. That is deliberate, not leftover manual toil — it keeps the AWS-billed action behind an explicit switch, gives you a checkpoint to confirm `RepoRef` / `ProblemsRepoRef` / capacity before spending money, and means an accidental CloudFormation stack update on the launcher never silently redeploys. Treat **Start build** as the switch that turns the event environment on.

After ~15-30 minutes the build finishes. Scroll to the end of the CodeBuild build log you're already watching — the deploy prints a `✓ Lite mode deploy complete` block whose **Access URLs:** section lists the **Application Admin Console** and **Participant Portal** URLs directly, followed by **Next steps:** and **Teardown:** guidance. If you'd rather read them from CloudFormation, the same two URLs are also in the **Outputs** of the `tenkacloud-lite` and `tenkacloud-lite-problem-deploy` stacks that the build creates.

**Complete teardown:** in the same CodeBuild project, choose **Start build with overrides**, set `ACTION` to `destroy-all`, and start it. This removes the Lite stacks, any explicitly retained DynamoDB tables, and problem-deploy logs. Then delete the `tenkacloud-lite-launcher` stack to remove its CodeBuild project, role, and log group. A normal `ACTION=destroy` also deletes DynamoDB tables by default; history survives only when the stack was deployed with `RetainDataTables=true`.

If the launcher predates `destroy-all`, update its CloudFormation stack with the latest `lite-pipeline.yaml` first. Do not pass `destroy-all` to an older launcher: its old buildspec treats unknown actions as deploy.

Re-running the same launcher for a later event works (the buildspec re-clones both repos on every build), but the recommended flow is a fresh launcher per event. The defaults are already fixed to the manifest's exact commits. If you rehearse newer code from `main` or a branch, record the exact platform and catalog commits that passed rehearsal and use those full SHAs for the real event; delete the launcher once you tear down. See the parameter rebuild table and the rehearsal-to-production flow in [`infrastructure/templates/README.md`](./infrastructure/templates/README.md#cloudformation-console-lite-mode-deployment-pipeline) and [`docs/operations/event-runbook.md`](./docs/operations/event-runbook.md).

## Supported environments

- **macOS, Linux, or WSL2** — supported for local play (`make local` / `tenkacloud local`) and for AWS deploys (`make deploy` Lite mode, `make deploy-saas` SaaS mode).
- **Native Windows without WSL2** — not supported for local play; use GitHub Codespaces (above) or install WSL2 first.
- **Browser only, no local install** — use GitHub Codespaces (above).

**How much machine you need** depends on how many problems you run at once, so it
is published as three profiles (`minimum` / `recommended` / `full`) with the
measurements behind them — see
[docs/local-play-requirements.md](./docs/local-play-requirements.md). Check your
own machine against a profile with `make doctor PROFILE=recommended`.

## Running costs

TenkaCloud runs in one of two profiles, selected by the `CDK_PARAM_CONTROL_DATA_BACKEND` env var (unset = default).

| Profile | For | Control data | Problem deploy |
| --- | --- | --- | --- |
| **AWS-native** (default, unset or `dynamodb`) | Teams / companies who want everything inside AWS | DynamoDB (provisioned 1/1), 8 tables + 8 GSIs | Lambda `CreateStack` (default) |
| **Zero-cost** (opt-in, `turso`) | Individuals, trials, personal events | Turso (libSQL) — 0 DynamoDB tables / 0 GSIs in the Lite synth | Lambda `CreateStack` (default) |

Opting in to the zero-cost profile starts with `make turso-live ENV=development`. The interactive wizard handles the Turso CLI and login, database creation, an SSM `SecureString`, public `.env` wiring, read-only preflight, an exact `deploy` confirmation, and the deployed zero-DynamoDB CloudFormation proof as one flow. The token travels to SSM over stdin and is never printed, placed in argv, or written to `.env`. The same command is available directly as `ENV=development bun run tenkacloud turso-live`, or as `ENV=development tenkacloud turso-live` after `bun link`. For the remaining console checks and current live-verification status, see [docs/running-costs.md](./docs/running-costs.md).

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

Live, end-to-end verification of the pack flow (`pack-init` through a local-path `pack-install`, `pack-activate --tenant local`, a real Lite mode deploy to AWS, the pack's problem showing up in the Application Admin Console, and a participant submitting a flag that scores) has been run.

[catalog]: https://github.com/susumutomita/TenkaCloudChallenge

## Enterprise / internal training

If you are considering TenkaCloud for enterprise or internal training use — hands-on security/operations drills, evaluation or onboarding exercises, custom/private problem sets, or instructor-led workshops — please feel free to reach out via the [contact form](https://forms.gle/djVprYmq3hFgJA7P9) or [GitHub Discussions](https://github.com/susumutomita/TenkaCloud/discussions). TenkaCloud is open source, but we would love to learn more about real-world training needs.

## Book

**[Build Your Own Cloud Competition](https://leanpub.com/build-your-own-cloud-competition)** — the design decisions and implementation
journey behind TenkaCloud. 日本語版: **[『自分で作るクラウド競技』](https://zenn.dev/bull/books/cloud-competition)**.

The book covers why the platform is shaped the way it is; the repository is the source of truth
for how it currently works. Where the two disagree, the repository is right — the book is a
record of the reasoning, not an API reference.

## Documentation

- [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) — local terminal deploys and SaaS mode
- [docs/local-play.md](./docs/local-play.md) — local drill internals, authoring a container problem, the `/verify` contract
- [docs/running-costs.md](./docs/running-costs.md) — the cost profiles, the zero-cost opt-in walkthrough, measured costs
- [docs/architecture/README.md](./docs/architecture/README.md) — architecture principles and machine-enforced boundaries

## Contributing

1. Read [CONTRIBUTING.md](./CONTRIBUTING.md) and [AGENTS.md](./AGENTS.md).
2. Keep infrastructure / template changes separate from application-code changes.
3. Run `make harness` and `make before-commit` before opening a PR.

## License

[Apache License 2.0](./LICENSE) — use commercially, modify, and distribute.
