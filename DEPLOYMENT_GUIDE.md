# TenkaCloud — Deployment guide

Start with the [README Quickstart](./README.md#quickstart). For AWS Lite, choose
local `make deploy` to build without CodeBuild, or the console launcher to avoid
installing local tools. Both create the same platform and incur AWS resource costs.

## What gets deployed (Lite mode)

Lite mode deploys the application plane with `tenantId="local"`:

- **Application Admin Console** — organizers create events, register teams, select
  problems, start deploy jobs, and watch progress.
- **Participant Portal** — teams read instructions, open hints, submit flags, view
  scores, and federate into their own AWS account.
- **Problem deploy backend** — DynamoDB, Lambda, Step Functions, EventBridge, and audit
  records for deploying catalog templates into competitor accounts. The default deploy
  path is Lambda CreateStack + poll — `deployViaLambda` defaults to `true` in
  `infrastructure/lib/app-config/resolve.ts`. A CodeBuild project is only synthesized
  when you explicitly set `CDK_PARAM_DEPLOY_VIA_LAMBDA=false`; see
  `infrastructure/lib/problem-deploy/build-deploy-pipeline.ts`.

## Administrator SSO

SaaS Control Plane administrators and silo-tenant administrators can connect their
Cognito User Pool to an external SAML 2.0 IdP. Use the values rendered by the
Admin Console as the source of truth for the ACS URL, SP エンティティ ID, and email
attribute mapping. The end-to-end setup, rehearsal, troubleshooting, certificate
rotation, and removal procedure is in the
[Cognito / SAML IdP operations playbook](./docs/operations/cognito-saml-idp-playbook.md).

Participant Portal authentication is separate: participants use per-team login keys,
not Cognito or SAML accounts.

## Lite mode — local terminal

Use this to build on your computer and avoid CodeBuild build charges. You need Git,
Make, Bash, zip, AWS CLI v2, and the Bun/Node.js versions in [mise.toml](./mise.toml).
CDK comes from the repository dependencies. On macOS, Linux, or WSL2, install the
tools before running these commands. If using
[mise](https://mise.jdx.dev/getting-started.html), review `mise.toml` in your checkout,
then run `mise trust` before `mise install bun node`. Prefix Make commands below
with `mise exec --` if the installed tools are not on your shell's PATH.

Configure your AWS CLI profile first. For an IAM Identity Center profile:

```bash
aws configure sso --profile tenkacloud
aws sso login --profile tenkacloud
export AWS_PROFILE=tenkacloud
aws sts get-caller-identity
```

For an existing profile, select that profile instead. Check that the returned
account is your intended deployment account and that the role has the
[permissions below](#aws-permissions).

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make install
make env-init    # creates infrastructure/environments/development/.env
```

`make env-init` asks for the administrator email, region, and competitor ExternalId.
Check `AWS_ACCOUNT_ID`, `AWS_REGION`, and `TENANT_ADMIN_EMAIL` in the generated file;
the account must match the identity above. It does not overwrite an existing file.
To set the values by hand instead:

```bash
cp infrastructure/environments/development/.env.example \
   infrastructure/environments/development/.env
# edit AWS_ACCOUNT_ID, AWS_REGION, and TENANT_ADMIN_EMAIL
```

For lower DB cost, set up [Turso](./docs/running-costs.md) before deployment. Put its
token in SSM Parameter Store, never in `.env`; the file holds only the database URL
and parameter name. When the configuration is ready:

```bash
make deploy
```

This builds from the current checkout, prepares and uploads the source bundle,
runs `cdk bootstrap`, deploys the two Lite stacks, and creates the initial Cognito
administrator. The command prints the portal URLs. Sign in, create a test event/team,
and check that a problem submission is reflected in the score before inviting users.

Use `make destroy` to tear down the AWS deployment. Cleanup depends on the backend:

- **DynamoDB:** tables are deleted by default. Retention must have been selected
  during deployment with `CDK_PARAM_RETAIN_DATA_TABLES=true`.
- **Turso:** control-data rows remain after `make destroy`. To erase those rows too,
  use `make destroy-all` instead, or run `make turso-reset` before teardown while
  the SSM token is still available. Both keep the database and schema; delete the
  external database separately if it is no longer needed.

See the [cleanup guide](./infrastructure/templates/README.md#撤去-teardown).

## AWS permissions

Use a deployment role agreed with your AWS administrator. A participant team key
or read-only AWS role is not a deployment credential. Permissions apply to the
selected account/region and the roles or resources created there.

| Stage | Identity and access needed |
| --- | --- |
| First CDK setup / upgrades | The caller creates or updates `CDKToolkit`: CloudFormation, IAM roles/policies, S3, ECR, and SSM bootstrap parameters. `make deploy` invokes bootstrap on every run; an existing stack is not a reason to assume all bootstrap access can be removed. |
| Publish source and assets | The caller needs S3 bucket creation/configuration and object upload on its `tenkacloud-source-<account>-<region>*` bucket. CDK assumes the account's bootstrap publishing/deployment roles with `sts:AssumeRole`; their trust policies must also admit the caller. |
| Deploy Lite stacks | The CDK deployment role uses CloudFormation and `iam:PassRole` for its CloudFormation execution role. The execution role must be able to create/update the services in the selected Lite templates: IAM, Lambda, API Gateway, Cognito, S3, CloudFront, Step Functions, EventBridge, SNS/SQS, Logs, and the chosen data backend (DynamoDB or SSM/Turso wiring). |
| Create the first administrator | The caller needs `cloudformation:DescribeStacks`, `cognito-idp:DescribeUserPoolDomain`, `cognito-idp:AdminGetUser`, and `cognito-idp:AdminCreateUser` for the Lite user pool. These run after CDK, using the caller's credentials. |
| Store a Turso token, if selected | The setup operator needs `ssm:PutParameter` on the chosen `/TenkaCloud/...` parameter. The preflight needs `ssm:DescribeParameters`. Runtime token reads belong to the Lambda role. For a customer-managed KMS key, its key policy and encrypt/decrypt permissions must also allow the relevant identities. |
| Console launcher, if selected | The launcher creator needs CloudFormation, creation of its CodeBuild IAM service role/policy, CodeBuild project and Logs configuration, and `iam:PassRole` limited to that role for CodeBuild. The person starting builds needs `codebuild:StartBuild`, project/build read access, and log read access. |

These are the access boundaries to review, not a tested minimal IAM policy for
every optional configuration. See the actual calls in
[tenkacloud-lite.ts](./scripts/tenkacloud-lite.ts),
[prepare-source-bundle.sh](./scripts/prepare-source-bundle.sh), and the service-role
policy in [lite-pipeline.yaml](./infrastructure/templates/lite-pipeline.yaml).
The launcher policy is broad; do not copy it as a general participant policy.

AWS documents the [bootstrap permissions](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html#bootstrapping-env-permissions).
The standard CDK CloudFormation execution role defaults to `AdministratorAccess`;
that is a powerful deployment role, not a recommendation to grant it to all users.
Have the account administrator review execution policies, permissions boundaries,
and organizational SCPs. See [CDK security guidance](https://docs.aws.amazon.com/cdk/v2/guide/best-practices-security.html).

Competitor-account setup is separate. Its existing
[`competitor-bootstrap.yaml`](./infrastructure/templates/README.md#competitor-bootstrapyaml)
uses an explicit `AdministratorAccess` exception for problem deployment into a
dedicated competitor account, with the platform principal and required `ExternalId`
constraining trust. Event participants do not need the platform deployment role.

## SaaS mode (multi-tenant)

Use SaaS mode only when you need tenant onboarding, pooled tiers (BASIC / ADVANCED),
silo tenants (PLATINUM), and the SBT control plane.

```bash
cp infrastructure/environments/development/.env.example \
   infrastructure/environments/development/.env
# edit SYSTEM_ADMIN_EMAIL, AWS_ACCOUNT_ID, and AWS_REGION

make deploy-saas
```

Tear down with `make destroy-saas`.
