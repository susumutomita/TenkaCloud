<!-- markdownlint-disable MD033 -->
<div align="center">

# TenkaCloud

**用于在真实 AWS 账户上运行真实云竞赛的开源平台。**

Battle (实时对战) 和 Challenge (自主练习) 问题直接部署到每位参赛者自己的 AWS 账户 — 包含多租户 SaaS 基础设施。

[![CI](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml/badge.svg)](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![Built with CDK](https://img.shields.io/badge/Built%20with-AWS%20CDK-orange)](https://aws.amazon.com/cdk/)
[![SBT](https://img.shields.io/badge/SBT-0.3.9-blue)](https://github.com/awslabs/sbt-aws)

🌐 [English](./README.md) · [日本語](./README.ja.md) · [Español](./README.es.md) · [中文](./README.zh.md)

</div>

---

## 为什么选择 TenkaCloud

云竞赛通常需要三样东西，但现有工具往往缺一样: 多租户 SaaS 控制层、部署到 *参赛者* AWS 账户的 pipeline、以及每个团队查看自己计分板的门户。 TenkaCloud 将这三样集成在单个 CDK 应用中。

- **🏗 真实 AWS 部署** — 问题是 CloudFormation 模板，通过 AssumeRole + ExternalId 部署到参赛者的账户。 非沙箱模拟。
- **🔐 多租户设计** — Control Plane 使用 SBT (Serverless SaaS Builder Toolkit); Application Plane 为每个租户提供 Cognito / DynamoDB / API Gateway。 开箱支持 pooled (BASIC / STANDARD / PREMIUM) 和 silo (PLATINUM) 层级。
- **💸 适配 Free Tier** — 所有 DynamoDB 表通过 CDK Aspect 强制为 PROVISIONED 1 RCU / 1 WCU。 平时运行可控制在 AWS Free Tier 范围内。

## 快速开始

### Lite 模式 (5 分钟，单租户)

适合 OSS 贡献者在不部署完整 SBT 控制层的情况下试用 TenkaCloud:

```bash
git clone https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make install
cp infrastructure/environments/development/.env.example \
   infrastructure/environments/development/.env
# 编辑 SYSTEM_ADMIN_EMAIL + AWS_ACCOUNT_ID

make lite-up    # cdk deploy 2 个 stack (首次约 10 分钟)
```

`make lite-up` 部署内容:

- **Application Admin Console** — Tenant Admin UI (CloudFront)
- **Participant Portal** — 参赛者 UI (CloudFront)
- **Problem Deploy Backend** — DynamoDB + Lambda + Step Functions + CodeBuild
- **本地 EventBridge** — 无需共享 bus / 无需 Control Plane
- 预置的 `hello-world` 问题，可部署到您 *自己* 的 AWS 账户

销毁:

```bash
make lite-down
```

### Full 模式 (多租户 SaaS)

正式运营场景 (多租户 / pooled tier / System Admin 邀请):

```bash
make deploy   # 三阶段 install.sh: backend → admin console → callback CORS
```

`scripts/install.sh` 负责 SBT 三阶段部署 (Control Plane → admin console hosting → callback CORS 更新)。

## 架构

```
┌────────────────────┐   ┌──────────────────────────┐   ┌────────────────────────┐
│  Admin Console     │   │ Application Admin Console│   │  Participant Portal    │
│  (System Admin)    │   │  (Tenant Admin)          │   │  (参赛者)              │
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
│ ServerlessSaaS     │                                  │ 参赛者 AWS 账户         │
│   Pipeline         │                                  │  (AssumeRole + ExtId)  │
└────────────────────┘                                  └────────────────────────┘
```

## 功能特性

| | |
|---|---|
| 🎮 **Battle 问题** | 实时对战型 (security battle royale、 microservice migration battle 等) |
| 🧩 **Challenge 问题** | 自主练习、 常驻挑战 (hello-world、 AWS 服务深入) |
| 🔌 **Plugin 架构** | 每个问题携带自己的 `metadata.json` + `template.yaml` (+ 可选 `portal/*.tsx`) |
| 📊 **5 种评分方式** | `flag` / `uptime-flat` / `uptime-multi` / `phased-polling` / `attack-detection` |
| 🌐 **i18n** | 默认日语、 每个问题可写 EN / ES / ZH 的 locale override |
| 🛡 **安全** | AssumeRole 必带 ExternalId; SSM SecureString 存机密; 全 API Cognito JWT; per-team 限流 |
| 📡 **Trust Bridge** | `@TenkaCloud/trust-bridge` — Cloud Action Intent 协议用于跨云权限转移 (AWS + GCP + Azure adapter) |
| 🔭 **可观测性** | CloudWatch Dashboard 统一展示 deploy chain / DDB / Lambda / API GW; 带 `correlationId` 的结构化 trace log |

## 问题的组织

1 个问题 = 包含 3 个 artifact 的目录 (参见 [ADR-012](./docs/architecture/adr-012-problem-plugin-architecture.html)):

```
problems/<category>/<id>/
├── metadata.json    # 目录显示 + scoring 规则 + portal slot 配线
├── template.yaml    # 部署到参赛者账户的 CloudFormation
└── portal/          # 可选 React.lazy 组件 (用于 Participant Portal)
```

添加新问题:

```bash
bun run scripts/tenkacloud-problem.ts create <id> --kind <flag|uptime-flat|...>
bun run scripts/tenkacloud-problem.ts validate <id>
```

Schema 参考: [`problems/SCHEMA.json`](./problems/SCHEMA.json) · 30 分钟 onboarding: [`docs/problems/AUTHORING.html`](./docs/problems/AUTHORING.html)

## 技术栈

| 层级 | 技术 |
|---|---|
| 前端 | Vite 7、 React 19、 react-router 7、 [Cloudscape Design System](https://cloudscape.design/) |
| 后端 | AWS Lambda (Node.js 22 + Hono)、 API Gateway HTTP API |
| IaC | AWS CDK 2 + [`@cdklabs/sbt-aws`](https://github.com/awslabs/sbt-aws) 0.3.9、 cdk-nag |
| 认证 | AWS Cognito (Hosted UI + OAuth Code + PKCE) |
| 数据 | DynamoDB (PROVISIONED 1/1) |
| 事件 | EventBridge |
| 测试 | Vitest (1000+ tests) |
| 包管理 | Bun 1.3.11 (workspaces) |

## 路线图

- ✅ Lite 模式 (single-tenant、 OSS 亲和) — Issue [#778](https://github.com/susumutomita/TenkaCloud/issues/778)
- ✅ Trust Bridge library (AWS adapter + GCP / Azure prototype) — Issue [#795](https://github.com/susumutomita/TenkaCloud/issues/795)
- 🔄 跨云问题支持 (GCP / Azure / Cloudflare 目标)
- 🔄 问题市场 (`TenkaCloudChallenges` 私有 repo 用于付费 / 私有问题)
- 📋 锦标赛模式 (多事件调度、 排行榜聚合)

## 平台对比

| | TenkaCloud | AWS GameDay | CTFd | Hack The Box |
|---|---|---|---|---|
| 部署到参赛者自己的 AWS | ✅ | ✅ | ❌ | ❌ |
| OSS / 可自部署 | ✅ | ❌ | ✅ | ❌ |
| 多租户 SaaS 层 | ✅ | N/A | ❌ | ❌ |
| 实时 PvP (Battle) | ✅ | ✅ | ❌ (仅 CTF) | 部分 |
| 兼容 Free Tier | ✅ | ❌ | ✅ | N/A |
| Plugin 型问题 | ✅ | ❌ | ✅ | ❌ |
| Trust Bridge (跨云权限) | ✅ | ❌ | ❌ | ❌ |

## 贡献

欢迎贡献。 请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)，然后:

- 选择带 [`good first issue`](https://github.com/susumutomita/TenkaCloud/labels/good%20first%20issue) 标签的 issue
- 必须有测试 (Vitest)
- 提 PR 前先执行 `make before-commit`
- 架构 invariant 由 `make harness` 强制检查

## Star History

如果 TenkaCloud 帮助您举办了云竞赛, 请给 repo 加 star — 这有助于了解 OSS 社区对此类平台的兴趣。

[![Star History Chart](https://api.star-history.com/svg?repos=susumutomita/TenkaCloud&type=Date)](https://star-history.com/#susumutomita/TenkaCloud&Date)

## 许可证

[Apache License 2.0](./LICENSE) — 可商用、 可修改、 可分发。 保留许可证声明即可。
