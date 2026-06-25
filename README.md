<!-- markdownlint-disable MD033 -->
<div align="center">

# TenkaCloud

**Run real cloud drills. Build reusable AWS problem catalogs.**

TenkaCloud is a self-hostable, Apache-2.0 platform for running hands-on AWS
competitions. Organizers manage events, teams, deploys, scoring, hints, and per-team
AWS Console federation from one application; participants solve real AWS scenarios in
isolated accounts.

[Landing page](https://tenkacloud.com) · [Demo portal](https://tenkacloud.com/portal-demo/?demo=1) · [Quickstart](#quickstart) · [Add your own problems](#add-your-own-problems)

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

Deploy from the AWS Console. A CloudFormation stack creates a CodeBuild project that
git-clones this repo and runs the deploy for you — **no local install, no GitHub
connection**.

1. Download [`infrastructure/templates/lite-pipeline.yaml`](./infrastructure/templates/lite-pipeline.yaml).
2. Open the [CloudFormation create-stack page](https://console.aws.amazon.com/cloudformation/home?region=ap-northeast-1#/stacks/create/template)
   in `ap-northeast-1` → **Upload a template file** → upload it → stack name
   **`tenkacloud-lite-launcher`**.
3. Set **`TenantAdminEmail`** to your Admin Console login email. That is the only
   required parameter. _(To ship your own problems, also set `ProblemsRepoUrl` — see
   [Add your own problems](#add-your-own-problems).)_
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

## Contributing

1. Read [CONTRIBUTING.md](./CONTRIBUTING.md) and [AGENTS.md](./AGENTS.md).
2. Keep infrastructure / template changes separate from application-code changes.
3. Run `make harness` and `make before-commit` before opening a PR.

## License

[Apache License 2.0](./LICENSE) — use commercially, modify, and distribute.
