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

- `INVARIANT_CONTROL_PLANE_USES_SBT` — SaaS mode の Control Plane は `@cdklabs/sbt-aws` の ControlPlane construct に乗せる。Lite mode は対象外。
- `INVARIANT_CONTROL_PLANE_DOES_NOT_HOST_TENANT_RUNTIME` — Control Plane は tenant manager とし、tenant runtime を持ち込まない。
- `INVARIANT_TENANT_ISOLATION_AT_INFRA_LAYER` — tenant 分離は partition key、stack、repository boundary などの infrastructure / data boundary で強制する。
- `INVARIANT_PR_SHIPS_WORKING_INCREMENT` — PR 単体で観測可能な機能が動く。
- `INVARIANT_PR_TESTS_COUPLED_WITH_CHANGE` — code change と test を同じ PR に含める。
- `INVARIANT_PR_REGRESSION_ANALYSIS_DOCUMENTED` — PR body の `## Regression analysis` に壊れ得る振る舞いを列挙する。
- `INVARIANT_PR_PHYSICAL_IMPACT_DOCUMENTED` — PR body の `## Physical impact` に CFn と artifact の CREATE / UPDATE / REPLACE / DELETE / NO-OP を列挙する。

## Machine enforcement rules

rule ID・principle・scope・severity の一覧は [`docs/architecture/enforcement-registry.md`](../../../docs/architecture/enforcement-registry.md)（人間向け索引）と [`enforcement-rules.json`](../../../docs/architecture/enforcement-rules.json)（machine-readable manifest）を正本とする。この Skill では手書き複製しない — 過去に手書きリストが registry と drift した実例があり、`agent-registry-consistency` rule がその再発を検知する。rule ごとの実装は `.claude/harness/src/rules/<ruleId>.ts`、test は同名の `.test.ts` に一 rule 一 file で置く。

## 落ちたときの対処

1. `ruleId`、`filePath`、`line`、`recommendation` を確認する。
2. `.claude/harness/src/rules/<ruleId>.ts` と test を読み、判定契約を確認する。
3. 設定や baseline で隠さず、まず code を修正する。
4. rule の例外が本当に必要なら、影響と代替防御を該当 code と test の近くに記録し、scope と test を明示的に更新する。

## 関連

- [`docs/architecture/principles.md`](../../../docs/architecture/principles.md) — 判断原則。
- [`docs/architecture/enforcement-registry.md`](../../../docs/architecture/enforcement-registry.md) — machine enforcement の索引。
- `/quality-gates` — off-body quality gate。
- `/tech-debt` — test smell、coupling、fallback の backlog scan。
- `/blindspot-pass` — 意味解析が必要な unknown-unknowns review。
- [`.claude/harness/bin/architecture.ts`](../../../.claude/harness/bin/architecture.ts) — entrypoint。
- [`.claude/harness/src/rules/`](../../../.claude/harness/src/rules/) — one-rule-per-file implementation。
