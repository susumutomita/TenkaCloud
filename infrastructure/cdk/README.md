# TenkaCloud Infrastructure

CDK + [SBT (SaaS Builder Toolkit)](https://github.com/awslabs/sbt-aws) based infrastructure for multi-tenant SaaS.

## Architecture

```
ControlPlaneStack          — Cognito auth + tenant management API + EventBridge bus
AppPlaneStack              — Tenant provisioning/deprovisioning (CodeBuild via ScriptJob)
ProblemDeployPlaneStack    — Problem deployment engine (cross-account, custom events)
```

See [ADR-011](../docs/decisions/011-sbt-control-plane-and-two-layer-application-plane.md) and [ADR-012](../docs/decisions/012-repository-restructuring.md) for design decisions.

## Setup

```bash
cp environments/development/.env.example environments/development/.env
# Edit .env with your AWS_ACCOUNT_ID and SYSTEM_ADMIN_EMAIL
```

## Commands

```bash
make install          # Install dependencies
make bootstrap        # CDK bootstrap (first time only)
make deploy           # Deploy all stacks (ENV=development)
make deploy ENV=staging
make destroy          # Destroy all stacks
make diff             # Show diff against deployed stacks
make synth            # Synthesize CloudFormation templates
make test             # Run tests (vitest)
make lint             # Run linter (biome)
make format           # Auto-format code
make before-commit    # Run all quality checks
make help             # Show all commands
```

## Project Structure

```
infrastructure/
├── bin/cdk.ts                      — Entry point (winston logger, config loading, AJV validation)
├── lib/
│   ├── config/
│   │   ├── config-interface.ts     — Config type definitions
│   │   └── config-schema.json      — JSON Schema for validation
│   ├── constants/
│   │   └── events.ts               — EventBridge event name constants
│   ├── handlers/                   — Testable TypeScript business logic
│   │   ├── provision.ts            — Tenant provisioning (DynamoDB + script builder)
│   │   ├── deprovision.ts          — Tenant deprovisioning (CloudFormation + script builder)
│   │   ├── deploy-problem.ts       — Problem deployment (STS AssumeRole + CloudFormation)
│   │   └── __tests__/              — Unit tests for handlers
│   ├── utils/
│   │   ├── config-loader.ts        — Config file processing and validation
│   │   └── iam-helpers.ts          — IAM PolicyDocument builders
│   ├── control-plane.ts            — ControlPlane stack (SBT)
│   ├── app-plane.ts                — AppPlane stack (tenant lifecycle)
│   └── problem-deploy-plane.ts     — ProblemDeployPlane stack (custom events)
├── environments/
│   ├── development/                — .env.example + config.json
│   ├── staging/
│   └── production/
├── test/                           — CDK stack tests
├── Makefile
├── biome.json
└── vitest.config.ts
```

## Config System

Each environment has `config.json` with `${VAR:-default}` placeholders replaced from `.env` at synth time. Validated against `config-schema.json` via AJV.

## Handler Pattern

Business logic lives in `lib/handlers/*.ts` as testable TypeScript functions. Each handler also exports a `buildXxxScript()` function that generates the bash wrapper for SBT's ScriptJob (CodeBuild). The bash is a thin shell that calls `node -e "..."` with AWS SDK v3.

```
handlers/provision.ts
  ├── provisionTenant(input, client)    — Testable function (mock DynamoDB client)
  └── buildProvisionScript()            — Generates bash for CodeBuild
```
