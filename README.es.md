<!-- markdownlint-disable MD033 -->
<div align="center">

# TenkaCloud

**La plataforma open-source para ejecutar competiciones reales de cloud en cuentas AWS reales.**

Problemas Battle (en tiempo real) y Challenge (a tu ritmo) que se despliegan directamente en la cuenta AWS de cada competidor — incluye infraestructura SaaS multi-tenant.

[![CI](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml/badge.svg)](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![Built with CDK](https://img.shields.io/badge/Built%20with-AWS%20CDK-orange)](https://aws.amazon.com/cdk/)
[![SBT](https://img.shields.io/badge/SBT-0.3.9-blue)](https://github.com/awslabs/sbt-aws)

🌐 [English](./README.md) · [日本語](./README.ja.md) · [Español](./README.es.md) · [中文](./README.zh.md)

</div>

---

## Por qué TenkaCloud

Las competiciones de cloud necesitan tres cosas que rara vez vienen juntas: un control plane SaaS multi-tenant, una pipeline de deploy a la cuenta AWS del *competidor*, y un portal donde cada equipo ve su propio scoreboard. TenkaCloud agrupa las tres en una sola app CDK.

- **🏗 Deploys AWS reales** — Los problemas son templates CloudFormation que aterrizan en la cuenta del competidor vía AssumeRole + ExternalId. Sin sandbox simulado.
- **🔐 Multi-tenant por diseño** — SBT (Serverless SaaS Builder Toolkit) para el control plane; Cognito, DynamoDB y API Gateway por tenant en el application plane. Tiers pooled (BASIC/STANDARD/PREMIUM) y silo (PLATINUM) soportados de fábrica.
- **💸 Compatible con Free Tier** — Cada tabla DynamoDB se fuerza a PROVISIONED 1 RCU / 1 WCU mediante un CDK Aspect, por lo que toda la plataforma cabe en el AWS Free Tier en condiciones normales.

## Inicio rápido

### Modo Lite (5 minutos, single tenant)

Para evaluadores y contribuidores OSS que quieren ver TenkaCloud funcionando sin configurar el control plane SBT completo:

```bash
git clone https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make install
cp infrastructure/environments/development/.env.example \
   infrastructure/environments/development/.env
# edita SYSTEM_ADMIN_EMAIL + AWS_ACCOUNT_ID

make lite-up    # cdk deploy 2 stacks (~10 min en la primera ejecución)
```

Qué obtienes con `make lite-up`:

- **Application Admin Console** — UI de Tenant Admin (CloudFront)
- **Participant Portal** — UI del competidor (CloudFront)
- **Problem Deploy Backend** — DynamoDB + Lambda + Step Functions + CodeBuild
- **EventBridge local** — sin bus compartido, sin control plane
- Un problema `hello-world` precargado que puedes desplegar a tu *propia* cuenta AWS

Desmontaje:

```bash
make lite-down
```

### Modo Full (SaaS multi-tenant)

Para competiciones reales con múltiples tenants, tiers pooled y onboarding de System Admin:

```bash
make deploy   # install.sh de 3 fases: backend → admin console → callback CORS
```

`scripts/install.sh` maneja el deploy SBT de 3 fases.

## Arquitectura

```
┌────────────────────┐   ┌──────────────────────────┐   ┌────────────────────────┐
│  Admin Console     │   │ Application Admin Console│   │  Participant Portal    │
│  (System Admin)    │   │  (Tenant Admin)          │   │  (Competidores)        │
└─────────┬──────────┘   └─────────────┬────────────┘   └────────────┬───────────┘
          ▼                            ▼                             ▼
┌────────────────────┐   ┌──────────────────────────┐   ┌────────────────────────┐
│ ControlPlaneStack  │   │ TenantTemplateStack      │   │ ProblemDeployBackend   │
│  (SBT)             │──▶│  per-tenant runtime      │   │  Step Functions +      │
│  Cognito + EvBridge│   │  Cognito + DDB + API GW  │   │  CodeBuild + Lambda    │
└─────────┬──────────┘   └──────────────────────────┘   └────────────┬───────────┘
          │  onboardingRequest             DeployRequested            │
          ▼                                                          ▼
┌────────────────────┐                                  ┌────────────────────────┐
│ ServerlessSaaS     │                                  │ Cuenta AWS Competidor  │
│   Pipeline         │                                  │  (AssumeRole + ExtId)  │
└────────────────────┘                                  └────────────────────────┘
```

## Características

| | |
|---|---|
| 🎮 **Problemas Battle** | Competiciones PvP en tiempo real |
| 🧩 **Problemas Challenge** | Entrenamiento a tu ritmo, siempre disponible |
| 🔌 **Arquitectura plugin** | Cada problema lleva su propio `metadata.json` + `template.yaml` (+ `portal/*.tsx` opcional) |
| 📊 **5 tipos de scoring** | `flag` / `uptime-flat` / `uptime-multi` / `phased-polling` / `attack-detection` |
| 🌐 **i18n** | Japonés por defecto, con overrides EN / ES / ZH por problema |
| 🛡 **Seguridad** | ExternalId obligatorio en AssumeRole; SSM SecureString para secretos; Cognito JWT en todas partes; rate limiting por equipo |
| 📡 **Trust Bridge** | `@TenkaCloud/trust-bridge` — protocolo Cloud Action Intent para transferencia de autoridad cross-cloud (adapters AWS + GCP + Azure) |
| 🔭 **Observabilidad** | Dashboard CloudWatch unificado; logs de trace estructurados con `correlationId` |

## Cómo funcionan los problemas

Un problema es un directorio auto-contenido con tres artefactos (ver [ADR-012](./docs/architecture/adr-012-problem-plugin-architecture.html)):

```
problems/<category>/<id>/
├── metadata.json    # display de catálogo + regla de scoring + wiring de portal
├── template.yaml    # CloudFormation desplegado en la cuenta del competidor
└── portal/          # componentes React.lazy opcionales para el Participant Portal
```

Añadir un problema nuevo:

```bash
bun run scripts/tenkacloud-problem.ts create <id> --kind <flag|uptime-flat|...>
bun run scripts/tenkacloud-problem.ts validate <id>
```

Referencia del schema: [`problems/SCHEMA.json`](./problems/SCHEMA.json) · Guía de autoría: [`docs/problems/AUTHORING.html`](./docs/problems/AUTHORING.html)

## Stack tecnológico

| Capa | Tecnología |
|---|---|
| Frontend | Vite 7, React 19, react-router 7, [Cloudscape Design System](https://cloudscape.design/) |
| Backend | AWS Lambda (Node.js 22 + Hono), API Gateway HTTP API |
| IaC | AWS CDK 2 + [`@cdklabs/sbt-aws`](https://github.com/awslabs/sbt-aws) 0.3.9, cdk-nag |
| Auth | AWS Cognito (Hosted UI + OAuth Code + PKCE) |
| Datos | DynamoDB (PROVISIONED 1/1) |
| Eventos | EventBridge |
| Tests | Vitest (1000+ tests) |
| Package | Bun 1.3.11 (workspaces) |

## Hoja de ruta

- ✅ Modo Lite (single-tenant, OSS-friendly) — Issue [#778](https://github.com/susumutomita/TenkaCloud/issues/778)
- ✅ Trust Bridge library (AWS + GCP / Azure prototypes) — Issue [#795](https://github.com/susumutomita/TenkaCloud/issues/795)
- 🔄 Soporte cross-cloud para problemas (targets GCP / Azure / Cloudflare)
- 🔄 Marketplace de problemas (repo privado `TenkaCloudChallenges` para problemas de pago / privados)
- 📋 Modo torneo (agendado multi-evento, agregación de leaderboard)

## Comparación

| | TenkaCloud | AWS GameDay | CTFd | Hack The Box |
|---|---|---|---|---|
| Despliega en la cuenta AWS del participante | ✅ | ✅ | ❌ | ❌ |
| OSS / self-hostable | ✅ | ❌ | ✅ | ❌ |
| Capa SaaS multi-tenant | ✅ | N/A | ❌ | ❌ |
| PvP en tiempo real (Battle) | ✅ | ✅ | ❌ (solo CTF) | Parcial |
| Compatible con Free Tier | ✅ | ❌ | ✅ | N/A |
| Problemas tipo plugin | ✅ | ❌ | ✅ | ❌ |
| Trust Bridge (autoridad cross-cloud) | ✅ | ❌ | ❌ | ❌ |

## Contribuir

Las contribuciones son bienvenidas. Comienza con [CONTRIBUTING.md](./CONTRIBUTING.md), luego:

- Elige un issue con la label [`good first issue`](https://github.com/susumutomita/TenkaCloud/labels/good%20first%20issue)
- Los tests son obligatorios (Vitest)
- Ejecuta `make before-commit` antes de abrir un PR
- Los invariantes de arquitectura se enforcen con `make harness`

## Star history

Si TenkaCloud te ayuda a organizar una competición de cloud, considera darle una estrella al repo — nos ayuda a entender el interés de la comunidad OSS.

[![Star History Chart](https://api.star-history.com/svg?repos=susumutomita/TenkaCloud&type=Date)](https://star-history.com/#susumutomita/TenkaCloud&Date)

## Licencia

[Apache License 2.0](./LICENSE) — Uso comercial, modificación, distribución. Solo mantén el aviso.
