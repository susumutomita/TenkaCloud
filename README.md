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

## Quickstart

Already invited to an event? Use the **Participant Portal URL and team key from your organizer**. You do not need to deploy TenkaCloud or install the local environment.

### Try it in your browser (GitHub Codespaces, zero install)

<div align="center">
  <a href="./docs/assets/codespaces-local-mode/codespaces-local-mode-readme-1280x720.mp4">
    <img src="./docs/assets/codespaces-local-mode/codespaces-local-mode-readme-preview.gif" alt="Bilingual 15-second GitHub Codespaces local-mode demo" width="800">
  </a>
  <br>
  <sub>Bilingual 15-second tour: Codespaces → <code>make local</code> → start a drill → instant local scoring.</sub>
</div>

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/susumutomita/TenkaCloud)

1. [Create a codespace on main](https://codespaces.new/susumutomita/TenkaCloud).
2. Wait for setup. The **Participant Portal opens automatically**.
3. Choose a local drill and press **Start**. If the preview did not open, use **PORTS → 5175 → preview**.

These are Docker-based local drills. Problems that require AWS use the hosted path below. Follow drill links inside the Codespaces preview.

> **Optional manual re-run:** if automatic startup fails, run the **▷ ローカルプレイ開始** task from the command palette.

### Try it locally (no AWS)

You need **Git, Make, Docker Engine, and Docker Compose v2** — no Bun, Node, or `node_modules` on your machine. Use macOS, Linux, or WSL2; native Windows users can use Codespaces.

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make local
```

Open the printed Portal URL, choose a drill, and press **Start**. **Your first success: submit the answer requested by that problem and see its result.**

- Docker Desktop: enable **Settings → Resources → Network → Enable host networking** (4.34+).
- Startup trouble: run `make doctor`. [Requirements and troubleshooting](./docs/local-play-requirements.md).
- Finish: `make local-down` stops the environment **and clears local progress**.

<details>
<summary>Developers: edit the UI with hot reload</summary>

```bash
make local-onboard
make local-dev
```

This path uses Bun and Vite. [Developer setup and commands](./docs/local-play.md).

</details>

### Deploy on AWS

Use **Lite mode** for one organizing group. Prepare an AWS account and an administrator email address, then choose your [database](#running-costs) and deployment method.

| Method | Choose it when | Build cost |
| --- | --- | --- |
| **Local terminal: `make deploy`** | You can install tools and want to reduce setup cost | Builds on your computer without CodeBuild |
| **AWS console pipeline** | You prefer no local tool installation | CodeBuild charges for build duration |

Both create the same Lite environment; the deployed AWS resources incur charges. Check [CodeBuild pricing and allowances](https://aws.amazon.com/codebuild/pricing/) for the pipeline option.

#### A. Deploy from your computer

Install Git, Make, Bash, zip, rsync, Python 3 (`python3`), AWS CLI v2, and the Bun/Node.js versions in [mise.toml](./mise.toml). Source packaging needs rsync and Python 3. Sign in to the target account through your AWS CLI profile or SSO.

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make install
aws sts get-caller-identity
make env-init
```

Check `AWS_ACCOUNT_ID`, `AWS_REGION`, and `TENANT_ADMIN_EMAIL` in the generated `infrastructure/environments/development/.env`. To reduce DB cost, add the [Turso connection settings](./docs/running-costs.md) before deploying.

```bash
make deploy
```

This builds the UI, bootstraps CDK, deploys the AWS resources, invites the administrator, and prints the portal URLs. [Tool setup, permissions, and detailed steps](./DEPLOYMENT_GUIDE.md#lite-mode--local-terminal).

#### B. Deploy from the AWS console

Only trusted deployment administrators should have this launcher's **Start build** permission. It can run overridden source and commands with the deployment role's AWS access. See [AWS permissions](./DEPLOYMENT_GUIDE.md#aws-permissions).

**Using Turso? Prepare its secret before Start build.** Obtain an **HTTPS database URL** (`https://…`) and full-access database token, then store the token as an SSM **SecureString** in the deployment account and region. The launcher does not create this parameter. [Dashboard and AWS console setup](./DEPLOYMENT_GUIDE.md#turso-setup-for-the-console-launcher).

1. Download [lite-pipeline.yaml](./infrastructure/templates/lite-pipeline.yaml).
2. In [CloudFormation](https://console.aws.amazon.com/cloudformation/home?region=ap-northeast-1#/stacks/create/template), choose **Upload a template file** and name the stack `tenkacloud-lite-launcher`.
3. Set **TenantAdminEmail**. For Turso, select **ControlDataBackend=turso**, enter the HTTPS database URL as **TursoDatabaseUrl** and the existing SSM parameter name as **TursoAuthTokenParameterName**. Review the settings and IAM permissions, then create the stack.
4. Open **StartBuildConsoleUrl** from its outputs and press **Start build**. This starts the deployment; creating the launcher alone does not.
5. When the build succeeds, open the **Application Admin Console** URL printed at the end of the log. Follow the [organizer manual](./apps/developer-portal/src/app/developers/docs/manual/organizer/page.mdx) to create an event, register teams, and select problems.

**Your first success: a test team can open a problem, submit an answer, and see its score.** Check this before inviting participants.

**Release status: candidate/unverified.** The launcher's default platform/catalog pair still points to the previous release identity; the [current release manifest](./release/tenkacloud-release.json) certifies no deployment mode or AWS region. Pins identify the code being deployed. Local `make deploy` uses your current checkout. Read the [verification status and identity difference](./release/tenkacloud-release.md) before an event. [All launcher settings](./infrastructure/templates/README.md#cloudformation-console-lite-mode-deployment-pipeline).

#### Required AWS permissions

- **Deployment operator:** needs CloudFormation create/update, `sts:AssumeRole` for CDK roles, IAM role creation and `iam:PassRole`, source uploads to S3, and initial Cognito user creation. Read-only access cannot deploy the platform.
- **First CDK setup:** `make deploy` also creates/updates `CDKToolkit`. Have your AWS administrator review its execution-role permissions. [Actions and resource scopes](./DEPLOYMENT_GUIDE.md#aws-permissions).
- **Event participants:** do not need platform deployment permissions. AWS problem accounts use a separate [competitor bootstrap](./infrastructure/templates/README.md#competitor-bootstrapyaml).

**After the event:** use `make destroy` locally or the pipeline [teardown procedure](./infrastructure/templates/README.md#撤去-teardown). Deleting only the launcher leaves resources running.

- **DynamoDB:** tables are deleted by default. To retain them, deploy with `CDK_PARAM_RETAIN_DATA_TABLES=true` (pipeline: `RetainDataTables=true`).
- **Turso:** rows remain after `make destroy`. To erase control data too, use `make destroy-all` instead, or run `make turso-reset` before teardown while the SSM token is available. These commands keep the database and schema; delete the external database separately if no longer needed.

**Source storage remains:** neither command deletes the source-bundle S3 bucket. Its current bundle and retained versions continue to incur storage charges. [Check and remove unused source storage](./DEPLOYMENT_GUIDE.md#source-storage-after-teardown).

## Running costs

| Database | Choose it when | Effect |
| --- | --- | --- |
| **DynamoDB** (default) | You want all control data inside AWS | Provisioned tables and indexes have a standing cost |
| **Turso** (`ControlDataBackend=turso`) | You want to reduce the database cost | Stores control data in Turso/libSQL; Lite creates no DynamoDB tables or indexes |

**Turso reduces the database cost, not all AWS charges.** Check Turso usage limits and the costs of the platform and selected problems. Switching an existing database does not migrate its data.

[Set up Turso and compare costs](./docs/running-costs.md). From a local checkout, `make turso-live ENV=development` (CLI: `tenkacloud turso-live`) guides setup and asks before deployment. The Turso path has unit/synth coverage; the full real-Turso deployment and billing verification remains unrecorded.

## Add your own problems

The platform and its problems are separate. You do not need to fork TenkaCloud to add a problem.

| Goal | Start here |
| --- | --- |
| Share problems with the community | [TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge) — author and validate in the catalog, then [select your catalog for deployment](./DEPLOYMENT_GUIDE.md#deploy-your-own-problem-catalog) |
| Keep problems private | [Problem Pack tutorial](./apps/developer-portal/src/app/developers/docs/tutorials/first-pack/page.mdx) — install for your own tenant |

The **console launcher** uses `ProblemsRepoUrl` and `ProblemsRepoRef`. Local
**`make deploy`** uses the parent's pinned `problems/` submodule: commit your
catalog changes, check out that commit, and record its URL and pin in the parent
before deployment. Preserve local edits first; deployment force-aligns the submodule.

<details>
<summary>Private pack: create, validate, install, activate</summary>

```bash
make pack-init ARGS="./my-pack --runtime aws/cloudformation"
make pack-validate ARGS="./my-pack"
make pack-install ARGS="./my-pack"
make pack-activate ARGS="com.example.starter@0.1.0 --tenant local"
```

`local` is Lite's tenant ID. Deploy after activation to include the pack. Pack activation is supported in Lite; SaaS refuses to synth with an active pack.

</details>

## Documentation

| You want to… | Read |
| --- | --- |
| Run an event | [Planning and operations](./apps/developer-portal/src/app/developers/docs/operate/run-an-event/page.mdx) |
| Ask an LLM to help you set up or investigate | [LLM entry point](./landing/llms.txt) → [task guide and code map](./landing/llms-full.txt) |
| Change platform code | [Contributing](./CONTRIBUTING.md) · [Agent instructions](./AGENTS.md) |
| Understand the architecture | [Architecture guide](./docs/architecture/README.md) · [Online manual](./apps/developer-portal/src/app/developers/docs/concepts/architecture/page.mdx) · [System diagram](./docs/architecture/diagrams/system-architecture.drawio) |
| Ask for help | [GitHub Discussions](https://github.com/susumutomita/TenkaCloud/discussions) · [Contact](https://forms.gle/djVprYmq3hFgJA7P9) |

## Vision

Practice on your own, then compete as a team. Packaged courses and training services are future directions; the working paths above are the starting point today.

## Book

[Build Your Own Cloud Competition](https://leanpub.com/build-your-own-cloud-competition) · [『自分で作るクラウド競技』](https://zenn.dev/bull/books/cloud-competition).
The books explain design decisions; the repository is the source of truth for how it currently works.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, a focused change, and verification before your PR.

## License

[Apache License 2.0](./LICENSE). TenkaCloud is an independent open-source project, not affiliated with, endorsed by, or sponsored by Amazon Web Services, Inc.
