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

## Vision

TenkaCloud is not only a competition platform. The product direction is a path
from safe, individual practice to team competition: **local drills → practical
courses / enterprise training → team competitions / GameDay → global
community**. Local drills are live today (`make local`); courses, enterprise
training as a packaged product, and a global community are directions we are
building toward, not shipped features. See [`docs/vision.md`](./docs/vision.md)
for the full picture, including what is live today versus where we are still
headed.

TenkaCloud は競技プラットフォームだけを目指しているわけではありません。個人が安全に練習できるローカルドリルから、実践的なコースや企業研修、チーム対抗の競技・GameDay、そしてグローバルなコミュニティへと進む道筋を目指しています。ローカルドリル (`make local`) は現時点で実際に動きますが、コースや企業研修のパッケージ化、グローバルコミュニティは今後の方向性であり、まだ実装されたものではありません。実装済みと構想中の区別を含めた全体像は [`docs/vision.md`](./docs/vision.md) を参照してください。

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

TenkaCloud runs in one of two profiles, selected by the
`CDK_PARAM_CONTROL_DATA_BACKEND` env var (unset = default).

| Profile | For | Control data | Problem deploy |
| --- | --- | --- | --- |
| **AWS-native** (default, unset or `dynamodb`) | Teams / companies who want everything inside AWS | DynamoDB (provisioned 1/1), 8 tables + 8 GSIs | Lambda `CreateStack` (default) |
| **Zero-cost** (opt-in, `turso`) | Individuals, trials, personal events | Turso (libSQL) — 0 DynamoDB tables / 0 GSIs in the Lite synth | Lambda `CreateStack` (default) |

Lite mode (`make deploy`) is already the lean path. The problem-deploy backend runs on
**Lambda `CreateStack`/`UpdateStack` by default** (no CodeBuild project), and the KMS
customer-managed key was removed in favor of the AWS-managed key. What is left standing
on the default profile is DynamoDB: eight tables plus eight GSIs pinned at PROVISIONED
1/1, which bill even while idle. Opting into `CONTROL_DATA_BACKEND=turso` removes all
eight of those tables (Events, Teams, Deployments, ProblemEndpoints,
CompetitorAccounts, Disruptions, AdminAuditLog, and — as of #2499 — SamlIdps) — CDK
does not synthesize any of them, which is what actually removes the standing cost, not
just the read/write path. The SAML IdP CRUD API (`/tenant/idp*`) keeps working on the
Turso profile: the Lambda is decoupled from table presence and resolves the repository
through the same seam as the other seven tables, so opting into `turso` yields a Lite
synth with **zero `AWS::DynamoDB::Table` resources**.

### Opt in to the zero-cost profile

1. **Create a Turso database** ([Turso CLI](https://docs.turso.tech/cli/introduction)):

   ```bash
   turso db create tenkacloud-lite
   turso db show tenkacloud-lite --url
   turso db tokens create tenkacloud-lite
   ```

   `db show --url` prints something like
   `libsql://tenkacloud-lite-<organization>.turso.io`; keep the token from
   `db tokens create` for the next step.

2. **Store the token in SSM as a `SecureString`** — never write it into `.env`:

   ```bash
   aws ssm put-parameter \
     --name /TenkaCloud/development/turso/auth-token \
     --type SecureString \
     --value "<token from step 1>"
   ```

3. **Add three lines to `infrastructure/environments/<env>/.env`** (copy from the
   matching `.env.example` first if you have not already):

   ```bash
   CDK_PARAM_CONTROL_DATA_BACKEND=turso
   CDK_PARAM_TURSO_DATABASE_URL=libsql://tenkacloud-lite-<organization>.turso.io
   CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME=/TenkaCloud/development/turso/auth-token
   ```

4. **`make deploy`.** CDK skips synthesizing all eight DynamoDB tables listed above; the
   first Lambda cold start creates the SQL schema on the Turso database for you (no
   manual migration step).

The steps above are for a **fresh** stack. Moving an *existing* `dynamodb`-backed stack
to `turso` is a separate, riskier path: the Events/Teams/Deployments/ProblemEndpoints/
CompetitorAccounts/Disruptions/AdminAuditLog/SamlIdps DynamoDB tables all use
`RemovalPolicy.RETAIN`, so cutting over directly orphans them (still billing) instead of
deleting them. See the `CDK_PARAM_CONTROL_DATA_BACKEND` comment block in
[`infrastructure/environments/development/.env.example`](./infrastructure/environments/development/.env.example)
for the `turso-mirror` bridge sequence (mirror first, verify the SQL replica, cut over,
then manually delete the orphaned tables).

> **Not yet live-verified.** "CDK does not synthesize these 8 tables" (zero
> `AWS::DynamoDB::Table` resources in the Lite synth) is checked by `Template.fromStack`
> synth assertions and by repository-seam unit tests — solid evidence the code path
> exists, but nobody has run `make deploy` with `CONTROL_DATA_BACKEND=turso` against a
> fresh AWS account + a real Turso database and read the resulting AWS bill yet. The
> SAML IdP CRUD API is exercised against the SQL repository by unit tests only, not by a
> live Turso database either. Treat the "near-$0" claim as implemented-and-tested, not
> as a measured production result.

### Measured cost (single AWS account, 2026-06, AWS-native/`dynamodb` profile)

| Source | Monthly | Status |
| --- | --- | --- |
| DynamoDB (provisioned tables) | ~$7.06 | Standing cost on the default `dynamodb` profile — opt into `CONTROL_DATA_BACKEND=turso` above to remove all 8 tables (zero `AWS::DynamoDB::Table` resources in the Lite synth) |
| CodeBuild (problem deploy) | part of ~$2.55 | **Resolved** — the Lambda deploy path is the default (#2353); no CodeBuild project in Lite mode |
| CodeBuild (SaaS tenant provisioning) | part of ~$2.55 | SaaS-mode only; not present in Lite mode |
| KMS customer-managed key | $0 | **Resolved** — AWS-managed key via a CDK Aspect |
| Retained tables after `destroy` | cumulative | **Resolved** — `make destroy` now warns and prints delete commands (#2445) |

> **Free Tier note.** New-style AWS Free Tier accounts (2025-07 onward) are
> credit-based: there is **no** always-free 25 RCU/WCU DynamoDB allowance. Credits can
> make the visible bill read $0, but Usage still accrues from the first hour and becomes
> a real charge once the credits run out.

### Turso free-plan headroom

[`quota-model.ts`](./infrastructure/lib/problem-deploy/control-data/quota-model.ts)
models the event-day SQL row traffic against Turso's free-plan monthly quota:

| Turso free-plan quota (as modeled in `quota-model.ts`) | Monthly limit |
| --- | --- |
| Row reads | 500,000,000 |
| Row writes | 10,000,000 |

The model counts one leaderboard-snapshot row read per participant per poll, one
summary row write per scored change, and one snapshot row write per refresh interval.
Its test fixture
([`quota-model.test.ts`](./infrastructure/test/problem-deploy/control-data/quota-model.test.ts))
— 300 participants, a 30-second leaderboard poll, a 24-hour event, 25,000 summary
writes, a 30-second snapshot refresh — comes out to 864,000 row reads and 27,880 row
writes: about 0.17% of the read quota and 0.28% of the write quota. That is a **model of
an event-day access pattern**, not a bill from a live database — it shows that a single
mid-size event has wide headroom under the free plan, nothing more.

個人でゼロコストに近い運用をしたい場合は `CDK_PARAM_CONTROL_DATA_BACKEND=turso` を選んでください。
Turso でデータベースを作成し、発行された token を SSM の SecureString に保存し(`.env` には書きません)、
`.env` に 3 行(`CDK_PARAM_CONTROL_DATA_BACKEND` / `CDK_PARAM_TURSO_DATABASE_URL` /
`CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME`)を足してから `make deploy` するだけで、
DynamoDB の control-data テーブル 8 個(Events / Teams / Deployments / ProblemEndpoints /
CompetitorAccounts / Disruptions / AdminAuditLog / SamlIdps)がすべて作られなくなり、Lite mode の
DynamoDB テーブル数は 0 個(GSI も 0 本)になります。SAML IdP の CRUD API(`/tenant/idp*`)は
table の有無から切り離されているため、Turso 上のテーブル経由で引き続き動作します。ただし、この
経路は CDK synth とユニットテストで検証済みであり、実際の AWS アカウント + Turso データベースに
対する live なエンドツーエンド計測はまだ行っていません。実測値の確認が取れ次第この節を更新します。

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
