# TenkaCloud Launch Funnel

Related: #1023

## Why

TenkaCloud already has deep platform architecture and a working OSS footprint, but first-time visitors still need to read and infer the value before they can feel it.

The launch funnel should move from:

```text
Read → Understand → Imagine
```

to:

```text
See → Try → Understand
```

The first external audience should not be asked to understand the whole platform up front. They should reach a visible cloud competition experience quickly.

## Primary audience for the first launch

Optimize the landing page for one buyer/user first:

> Teams that need to turn internal cloud training into hands-on exercises.

Secondary audiences can remain visible, but they should not compete with the hero message:

- SRE / incident response drills
- Security training
- AWS partner enablement
- Community hackathons
- Hiring skill checks
- Schools and bootcamps

## Hero positioning

Current broad positioning:

```text
Cloud skill is measured in the wild.
Compete on real AWS — build it, defend it, optimize it.
```

Sharper launch positioning:

```text
Turn internal cloud training into hands-on exercises in minutes.
AWS GameDay-style experiences with automated environment provisioning, scoring, and reusable scenarios.
```

Japanese candidate:

```text
社内クラウド研修を、5分で実戦演習に。
AWS GameDay のような演習を OSS で。
環境払い出し、スコアリング、問題管理を自動化します。
```

## First CTA

The first CTA should prefer a fast product experience over source-code reading.

Recommended CTA order:

1. Try in 3 minutes
2. View on GitHub

Until a hosted demo exists, the CTA can point to the most guided path available:

- `problems/hello-world`
- a static demo page
- a demo video
- a local quickstart

## Activation funnel

Track these events once analytics is introduced:

```text
landing_view
  ↓
hero_try_clicked
  ↓
demo_started
  ↓
challenge_completed
  ↓
problem_authoring_started
  ↓
problem_created
```

## Success criteria

### Visitor activation

- A new visitor can understand the product category in 5 seconds.
- A new visitor can start a visible demo in 3 minutes.
- A new visitor can complete the first challenge in 5 minutes.

### Problem author activation

- A new problem author can create a minimal problem in 30 minutes.
- The authoring path includes validation, local preview, and packaging checks.

### Community sharing

- A 30-second demo video exists.
- The LP can be shared without requiring readers to inspect the repository first.
- The README and LP point to the same first experience.

## Suggested implementation phases

### Phase 1: LP copy and CTA

- Replace the hero with the sharper internal-training message.
- Reorder CTA buttons so the first action is a guided trial.
- Keep GitHub as a secondary CTA.
- Add a short `For training teams` section above the generic audience section.

### Phase 2: no-AWS demo path

- Add a static `hello-world` demo path that does not require an AWS account.
- Simulate score changes and challenge completion.
- Make the demo good enough for a 30-second video.

### Phase 3: guided problem authoring

- Add a `create-tenkacloud-problem` style scaffold command or equivalent script.
- Provide one minimal metadata file, one deployable asset, and one scoring probe.
- Add validation errors that explain what to fix.

### Phase 4: signed achievement model

Do not start with NFT or on-chain credentials.

Start with:

```text
signed result JSON
  ↓
public profile / shareable certificate
  ↓
W3C Verifiable Credential
  ↓
optional on-chain proof
```

This keeps the product focused on proof of skill rather than speculative tokens.

## Non-goals for the first launch

Avoid adding these before first community feedback:

- Multi-cloud support
- Marketplace mechanics
- NFT issuance
- Full credential graph
- Enterprise SSO polish
- Complex tournament formats

The next milestone is not feature breadth. It is a first experience that makes people say, "I understand this. I want to run one."