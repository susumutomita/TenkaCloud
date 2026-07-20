---
name: harness
description: TenkaCloud architecture harness を実行し、.claude/harness の決定論的 enforcement rule 違反を検出する。コミット前のアーキテクチャ整合チェック、リファクタ後の確認、rule ID の意図や修正方法を調べるときに使う。判断原則の評価ではなく、機械判定可能なリポジトリ状態を検査する。
allowed-tools: Bash(make harness:*), Bash(make harness-test:*), Bash(bun run .claude/harness/bin/architecture.ts:*)
---

# TenkaCloud Architecture Harness

この Skill は、機械判定可能な違反を検出する。

未知の状況で使う判断原則は [`docs/architecture/principles.md`](../../../docs/architecture/principles.md)、enforcement の索引は [`docs/architecture/enforcement-registry.md`](../../../docs/architecture/enforcement-registry.md)、rule 実装は一 rule 一 file で [`.claude/harness/src/rules/`](../../../.claude/harness/src/rules/) に置く。

`INVARIANT_*` / `ONE_PASS_*` の process invariant は PR review と完了監査で扱い、`.claude/harness/src/rules/` の決定論的 rule と混同しない。

## 実行方法

Staged file のみ:

```bash
make harness
```

リポジトリ全体:

```bash
bun run .claude/harness/bin/architecture.ts --fail-on=error
```

harness 自身の unit test:

```bash
make harness-test
```

`--fail-on=error` 指定時は error が 1 件でもあれば exit 2 で終了する。`make before-commit` の前段で必ず通す。

HTTP magic number、template、coverage、IAM ASCII、merge、submodule などの off-body gate は [`/quality-gates`](../quality-gates/SKILL.md) が担当する。

## Process invariants

以下は設計と PR discipline の契約であり、単独の regex rule ではない。

- `INVARIANT_CONTROL_PLANE_USES_SBT` — SaaS mode の Control Plane は `@cdklabs/sbt-aws` の ControlPlane construct に乗せる。Lite mode と Always-On mode は対象外。
- `INVARIANT_CONTROL_PLANE_DOES_NOT_HOST_TENANT_RUNTIME` — Control Plane は tenant manager とし、tenant runtime を持ち込まない。
- `INVARIANT_TENANT_ISOLATION_AT_INFRA_LAYER` — tenant 分離は partition key、stack、repository boundary などの infrastructure / data boundary で強制する。
- `INVARIANT_PR_SHIPS_WORKING_INCREMENT` — PR 単体で観測可能な機能が動く。
- `INVARIANT_PR_TESTS_COUPLED_WITH_CHANGE` — code change と test を同じ PR に含める。
- `INVARIANT_PR_REGRESSION_ANALYSIS_DOCUMENTED` — PR body の `## Regression analysis` に壊れ得る振る舞いを列挙する。
- `INVARIANT_PR_PHYSICAL_IMPACT_DOCUMENTED` — PR body の `## Physical impact` に CFn と artifact の CREATE / UPDATE / REPLACE / DELETE / NO-OP を列挙する。

## Machine enforcement rules

- `secrets-manager-forbidden` — `@aws-sdk/client-secrets-manager` の import を error。SSM Parameter Store SecureString を使う。
- `handler-must-not-call-fetch` — handler から `fetch` を直接呼ばず、Service / Repository に閉じ込める。
- `handler-no-direct-sdk-import` — Lambda entrypoint から AWS SDK client を直接 import しない。
- `handler-tenant-isolation` — tenant-scoped handler が DDB command を発行する場合、同一 file で `tenantId` を参照していることを要求する。tenant logic を禁止する rule ではなく、tenant boundary の欠落を検知する guard である。
- `iam-wildcard-needs-justify` — IAM wildcard には AWS API constraint または設計理由の inline justification を要求する。
- `lambda-env-size` — Lambda environment variable block が 4 KB hard limit に近づく変更を検出する。
- `no-aws-trademark-fictions` — AWS GameDay 系の架空企業名を TenkaCloud content に再利用しない。
- `no-conflict-markers` — conflict marker の混入を error にする。
- `adr-must-be-html` — ADR は `docs/architecture/adr-*.html` を source of truth とする。
- `adr-self-contained` — ADR に chat context、rolling update metadata、agent role split を残さない。
- `file-too-large` — baseline を超えて巨大 file を増やす変更を抑止する。
- `domain-no-infra-import` — control-data domain から adapter、handler、AWS SDK / CDK への逆依存を禁止する。
- `runtime-composition-root-only` — default runtime composition を Lambda entrypoint など許可された composition root に限定する。

rule 一覧を別文書へ手書きで複製すると drift する。説明を更新する場合は、rule implementation、unit test、Enforcement Registry、この Skill を同じ PR で確認する。

## 落ちたときの対処

1. `ruleId`、`filePath`、`line`、`recommendation` を確認する。
2. `.claude/harness/src/rules/<ruleId>.ts` と test を読み、判定契約を確認する。
3. 設定や baseline で隠さず、まず code を修正する。
4. rule の例外が本当に必要なら、影響と代替防御を ADR に記録し、scope と test を明示的に更新する。

## 関連

- [`docs/architecture/principles.md`](../../../docs/architecture/principles.md) — 判断原則。
- [`docs/architecture/enforcement-registry.md`](../../../docs/architecture/enforcement-registry.md) — machine enforcement の索引。
- `/quality-gates` — off-body quality gate。
- `/tech-debt` — test smell、coupling、fallback の backlog scan。
- `/blindspot-pass` — 意味解析が必要な unknown-unknowns review。
- [`.claude/harness/bin/architecture.ts`](../../../.claude/harness/bin/architecture.ts) — entrypoint。
- [`.claude/harness/src/rules/`](../../../.claude/harness/src/rules/) — one-rule-per-file implementation。
