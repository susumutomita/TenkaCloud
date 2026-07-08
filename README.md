<!-- markdownlint-disable MD033 -->
<div align="center">

# TenkaCloud

**Run real cloud drills. Build reusable AWS problem catalogs.**

TenkaCloud is a self-hostable, Apache-2.0 platform for running hands-on AWS
competitions. Organizers manage events, teams, deploys, scoring, hints, and per-team
AWS Console federation from one application; participants solve real AWS scenarios in
isolated accounts.

[Landing page](https://tenkacloud.com) · [Demo portal](https://tenkacloud.com/portal-demo/?demo=1) · [Quickstart](#quickstart) · [Add your own problems](#add-your-own-problems)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/susumutomita/TenkaCloud)
[![CI](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml/badge.svg)](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![Built with CDK](https://img.shields.io/badge/Built%20with-AWS%20CDK-orange)](https://aws.amazon.com/cdk/)
[![SBT](https://img.shields.io/badge/SBT-0.3.9-blue)](https://github.com/awslabs/sbt-aws)
[![codecov](https://codecov.io/gh/susumutomita/TenkaCloud/graph/badge.svg?token=WfleGvJor9)](https://codecov.io/gh/susumutomita/TenkaCloud)

</div>

> TenkaCloud is an independent open-source project and is not affiliated with,
> endorsed by, or sponsored by Amazon Web Services, Inc. AWS and related marks are
> trademarks of Amazon.com, Inc. or its affiliates.

---

## What TenkaCloud gives you

TenkaCloud turns a problem catalog into a live cloud drill:

1. **Create an event** in the Application Admin Console.
2. **Select problems** from the catalog.
3. **Register teams** and their AWS account trust settings.
4. **Deploy problem stacks** into each team's isolated AWS account (cross-account
   `AssumeRole` + required `ExternalId`).
5. **Run the event** — participants use the portal for instructions, hints,
   submissions, scores, and one-click AWS Console federation.

| Style | Use it for | Scoring |
| --- | --- | --- |
| **Challenge** | Self-paced AWS tasks and labs | Flag / answer submission |
| **Battle** | Real-time operations drills | Health probes, phased polling, attack detection, or other catalog-declared scoring |

## Quickstart

### Try it in your browser (GitHub Codespaces, zero install)

No AWS account, no local Docker, no `git clone` — everything runs in a disposable
cloud dev container that GitHub builds for you.

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/susumutomita/TenkaCloud)

1. Click the badge above → **Create codespace on main**. The first build takes a few
   minutes: it installs Bun, initializes the `problems/` catalog, and starts Docker
   automatically (see [`.devcontainer/devcontainer.json`](./.devcontainer/devcontainer.json)).
2. Once the terminal is ready, run the **"▷ ローカルプレイ開始"** task — open the
   Command Palette (`Cmd/Ctrl+Shift+P`) → **Tasks: Run Task** →
   **"▷ ローカルプレイ開始"** (or press `Cmd/Ctrl+Shift+B`, it is the default build
   task). This runs `make local` for you inside the codespace.
3. When the terminal shows the Participant Portal is running, open the **PORTS** tab
   in the bottom panel and click the preview (globe) icon next to port **5175**.

> **Stay inside the codespace.** Problem instructions reference
> `http://127.0.0.1:<port>` URLs (the challenge surface, e.g. port `18080`). Those
> loopback addresses only resolve correctly from *inside* the codespace: the
> integrated terminal (`curl http://127.0.0.1:18080/...`) or the **PORTS** tab's
> preview / "Open in Browser" action. Pasting a `127.0.0.1` URL into a browser tab on
> your own computer points at your own machine instead, and will not work.

### Try it locally (no AWS)

A fresh clone to a running portal. `make local` diagnoses what it needs (mise trust,
the `problems/` submodule, Bun, the Docker CLI / Compose plugin / daemon) and, only
with your consent, sets it up — then starts the Participant Portal.

```bash
git clone https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make local
```

- `make local-list` lists every local-play problem id if you want to pre-start
  one with `make local PROBLEM=<id>`; otherwise choose and deploy from the portal.
- `make doctor` reports the prerequisites and changes nothing.
- `make local YES=1` pre-approves software installs (also used by CI / automation).
  In a non-interactive run without `YES=1`, nothing is installed — the missing
  prerequisites are reported instead.
- Needs a Docker runtime (Colima or Docker Desktop). If it is missing, `make local`
  shows the exact install command and asks before running it.

### Deploy on AWS

Deploy from the AWS Console. A CloudFormation stack creates a CodeBuild project that
git-clones this repo and runs the deploy for you — **no local install, no GitHub
connection**.

1. Download [`infrastructure/templates/lite-pipeline.yaml`](./infrastructure/templates/lite-pipeline.yaml).
2. Open the [CloudFormation create-stack page](https://console.aws.amazon.com/cloudformation/home?region=ap-northeast-1#/stacks/create/template)
   in `ap-northeast-1` → **Upload a template file** → upload it → stack name
   **`tenkacloud-lite-launcher`**.
3. Set **`TenantAdminEmail`** to your Admin Console login email. That is the only
   required parameter. *(To ship your own problems, also set `ProblemsRepoUrl` — see
   [Add your own problems](#add-your-own-problems).)*
4. Check **acknowledge IAM** and create the stack.
5. Open the CodeBuild project from the stack's **`StartBuildConsoleUrl`** output and
   press **Start build**.

After ~15-30 minutes the build finishes. The **Admin Console** and **Participant Portal**
URLs are in the **Outputs** of the `tenkacloud-lite` and `tenkacloud-lite-problem-deploy`
stacks that the build creates. That is your deployment.

**Tear down:** in the same CodeBuild project, choose **Start build with overrides**, set
the environment variable `ACTION` to `destroy`, and start it — that deletes the two app
stacks in the right order. Then delete the `tenkacloud-lite-launcher` stack to remove the
CodeBuild project itself.

<sub>Prefer a local terminal, or need multi-tenant SaaS? See [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md).</sub>

## Running costs

TenkaCloud runs in one of two profiles. The default is tuned for AWS-native,
zero-friction operation; a second profile is being built for individuals who want the
standing cost as close to $0 as possible.

| Profile | For | Control data | Problem deploy |
| --- | --- | --- | --- |
| **AWS-native** (default) | Teams / companies who want everything inside AWS | DynamoDB (provisioned 1/1) | Lambda `CreateStack` (default) |
| **Zero-cost** (opt-in, in progress) | Individuals, trials, personal events | Turso (libSQL) — being introduced | Lambda `CreateStack` (default) |

Lite mode (`make deploy`) is already the lean path. The problem-deploy backend runs on
**Lambda `CreateStack`/`UpdateStack` by default** (no CodeBuild project), and the KMS
customer-managed key was removed in favor of the AWS-managed key. The one remaining
standing cost in Lite mode is DynamoDB: eight tables plus eight GSIs pinned at
PROVISIONED 1/1, which bills even while idle.

### Measured cost (single AWS account, 2026-06)

| Source | Monthly | Status |
| --- | --- | --- |
| DynamoDB (provisioned tables) | ~$7.06 | Standing cost — a table bills even at 1/1. Turso backend in progress (tracker #2435) |
| CodeBuild (problem deploy) | part of ~$2.55 | **Resolved** — the Lambda deploy path is the default (#2353); no CodeBuild project in Lite mode |
| CodeBuild (SaaS tenant provisioning) | part of ~$2.55 | SaaS-mode only; not present in Lite mode |
| KMS customer-managed key | $0 | **Resolved** — AWS-managed key via a CDK Aspect |
| Retained tables after `destroy` | cumulative | **Resolved** — `make destroy` now warns and prints delete commands (#2445) |

> **Free Tier note.** New-style AWS Free Tier accounts (2025-07 onward) are
> credit-based: there is **no** always-free 25 RCU/WCU DynamoDB allowance. Credits can
> make the visible bill read $0, but Usage still accrues from the first hour and becomes
> a real charge once the credits run out.

The DynamoDB → Turso (libSQL) control-data backend that removes this last standing cost
is **in progress** (tracker #2435, phases A–C). The opt-in setup steps will be
documented here once that path is complete.

## Add your own problems

Problems live in their own repo — [TenkaCloudChallenge][catalog], cloned in at deploy
time. You never fork this platform to add problems:

1. **Fork** [TenkaCloudChallenge][catalog].
2. **Author + validate** with its tooling — `scripts/new-problem.ts` scaffolds a
   problem; the schema and validators check it before you ship.
3. **Deploy your catalog** — run the [Quickstart](#quickstart) with `ProblemsRepoUrl`
   set to your fork. The build clones your catalog instead of the official one; nothing
   else changes.

A problem directory is three files:

```text
metadata.json    # catalog display + scoring rule + portal slot wiring
template.yaml    # CloudFormation deployed into the team's isolated AWS account
portal/          # optional React components for the Participant Portal
```

[catalog]: https://github.com/susumutomita/TenkaCloudChallenge

## Enterprise / internal training

If you are considering TenkaCloud for enterprise or internal training use — hands-on
security/operations drills, evaluation or onboarding exercises, custom/private problem
sets, or instructor-led workshops — please feel free to reach out via the
[contact form](https://forms.gle/djVprYmq3hFgJA7P9) or
[GitHub Discussions](https://github.com/susumutomita/TenkaCloud/discussions).

TenkaCloud is open source, but we would love to learn more about real-world training
needs, custom exercise requirements, and how organizations want to run hands-on
operations/security drills.

企業内での研修・演習・評価・独自教材の提供などで利用を検討される場合は、ぜひ一度お声がけください。TenkaCloud はオープンソースとして公開していますが、実際の現場で求められる題材、運用方法、閉じた環境での利用要件を伺いながら、プロダクトと教材の両方を改善していきたいと考えています。

## Contributing

1. Read [CONTRIBUTING.md](./CONTRIBUTING.md) and [AGENTS.md](./AGENTS.md).
2. Keep infrastructure / template changes separate from application-code changes.
3. Run `make harness` and `make before-commit` before opening a PR.

## License

[Apache License 2.0](./LICENSE) — use commercially, modify, and distribute.
