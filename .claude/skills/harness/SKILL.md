---
name: harness
description: TenkaCloud architecture harness を実行し、.claude/harness の invariant / enforcement rule 違反を検出する。コミット前のアーキテクチャ整合チェック、リファクタ後の確認、不変条件・PR Discipline について訊かれたときに使う。
allowed-tools: Bash(make harness:*), Bash(make harness-test:*), Bash(bun run .claude/harness/bin/architecture.ts:*)
---

# TenkaCloud Architecture Harness

アーキテクチャ不変条件 (`INVARIANT_*`) と PR Discipline、Enforcement Rules との逸脱を機械的に検出するツール。不変条件のまとめは [`CLAUDE.md`](../../../CLAUDE.md) の「Architecture invariants」表、ルール実装は一ルール一ファイルで [`.claude/harness/src/rules/`](../../../.claude/harness/src/rules/) にある。

## 実行方法

Staged ファイルのみ (fast、pre-commit / PR ゲート向け):

```bash
make harness
```

リポジトリ全体:

```bash
bun run .claude/harness/bin/architecture.ts --fail-on=error
```

ハーネス自体のユニットテスト:

```bash
make harness-test
```

`--fail-on=error` 指定時、error が 1 件でもあれば exit 2 で終了する。`make before-commit` の前段で必ず通すこと。なお品質ゲート (HTTP magic number / template / coverage 等) は別系統で、[`/quality-gates`](../quality-gates/SKILL.md) が担当する。

## 検査内容

### Invariants (CLAUDE.md「Architecture invariants」)

- `INVARIANT_CONTROL_PLANE_USES_SBT` — Control Plane は `@cdklabs/sbt-aws` の ControlPlane construct に乗せる
- `INVARIANT_CONTROL_PLANE_DOES_NOT_HOST_TENANT_RUNTIME` — Control Plane は tenant manager。runtime を持ち込まない
- `INVARIANT_TENANT_ISOLATION_AT_INFRA_LAYER` — テナント分離はインフラ層 (DDB PK / stack 分離) で実現
- `INVARIANT_PR_SHIPS_WORKING_INCREMENT` — PR 単体で観察可能な機能が動く
- `INVARIANT_PR_TESTS_COUPLED_WITH_CHANGE` — コード変更とテストを同じ PR に含める
- `INVARIANT_PR_REGRESSION_ANALYSIS_DOCUMENTED` — PR body の `## Regression 分析` で壊しうる挙動を列挙
- `INVARIANT_PR_PHYSICAL_IMPACT_DOCUMENTED` — PR body の `## 物理影響` で CFn / 成果物の差分を列挙

### Enforcement Rules (`.claude/harness/src/rules/`)

- `secrets-manager-forbidden` — `@aws-sdk/client-secrets-manager` の import を error。SSM Parameter Store SecureString (Standard tier = 無料) を使うこと
- `handler-must-not-call-fetch` — `lib/handlers/` 配下で `fetch(` 直接呼び出しを error。Service / Repository に閉じ込める
- `handler-no-direct-sdk-import` — handler から AWS SDK を直接 import しない
- `handler-tenant-isolation` — handler に tenant ロジックを持ち込まない (分離はインフラ層)
- `iam-wildcard-needs-justify` — IAM wildcard には justification を要求
- `lambda-env-size` — Lambda env サイズ上限
- `no-aws-trademark-fictions` — AWS 商標まわりの架空表現を禁止
- `no-conflict-markers` — `<<<<<<<` 等の conflict marker 混入を error
- `adr-must-be-html` — ADR は `docs/architecture/adr-*.html` (HTML)。Markdown ADR は禁止
- `adr-self-contained` — ADR に chat 文脈 / rolling-update メタを残さない
- `file-too-large` — 巨大ファイルの新規追加を抑止

## 落ちたときの対処

1. 出力に `## Findings` で列挙される `ruleId` / `filePath` / `line` を確認
2. `recommendation` 欄に修正方針が書いてある — それに従ってコードを直す
3. 不明なときは `.claude/harness/src/rules/<ruleId>.ts` の実装と同名 `.test.ts` を読むと期待挙動が分かる

## 関連

- `/quality-gates` — 本体と分離した品質ゲート (HTTP magic number / template / coverage / IAM ASCII / merge / submodule)
- `/tech-debt` (= `make tech-debt`) — 技術的負債スキャン (test smell / 結合 / fallback 検出)
- [`.claude/harness/bin/architecture.ts`](../../../.claude/harness/bin/architecture.ts) — エントリポイント
- [`.claude/harness/src/rules/`](../../../.claude/harness/src/rules/) — ルール実装 (一ルール一ファイル)
