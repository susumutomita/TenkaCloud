---
name: harness
description: TenkaCloud architecture harness を実行し、docs/architecture/harness.md の invariant 違反を検出する。コミット前のアーキテクチャ整合チェック、リファクタ後の確認、不変条件・PR Discipline について訊かれたときに使う。
allowed-tools: Bash(make harness:*), Bash(make harness-test:*), Bash(bun run .claude/harness/bin/architecture.ts:*)
---

# TenkaCloud Architecture Harness

[`docs/architecture/harness.md`](../../../docs/architecture/harness.md) に固定した不変条件 (`INVARIANT_*`) と PR Discipline、Enforcement Rules との逸脱を機械的に検出するツール。実装は [`.claude/harness/`](../../../.claude/harness/)。

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

`--fail-on=error` 指定時、error が 1 件でもあれば exit 2 で終了する。`make before-commit` の前段で必ず通すこと。

## 検査内容

### Invariants (`docs/architecture/harness.md`)

- `INVARIANT_CONTROL_PLANE_USES_SBT` — Control Plane は `@cdklabs/sbt-aws` の ControlPlane construct に乗せる
- `INVARIANT_CONTROL_PLANE_DOES_NOT_HOST_TENANT_RUNTIME` — Control Plane は tenant manager。runtime を持ち込まない
- `INVARIANT_TENANT_ISOLATION_AT_INFRA_LAYER` — テナント分離はインフラ層 (DDB PK / stack 分離) で実現
- `INVARIANT_PR_SHIPS_WORKING_INCREMENT` — PR 単体で観察可能な機能が動く
- `INVARIANT_PR_TESTS_COUPLED_WITH_CHANGE` — コード変更とテストを同じ PR に含める
- `INVARIANT_PR_REGRESSION_ANALYSIS_DOCUMENTED` — PR body の `## Regression 分析` で壊しうる挙動を列挙
- `INVARIANT_PR_PHYSICAL_IMPACT_DOCUMENTED` — PR body の `## 物理影響` で CFn / 成果物の差分を列挙

### Enforcement Rules

- `secrets-manager-forbidden` — `@aws-sdk/client-secrets-manager` の import を error。SSM Parameter Store SecureString (Standard tier = 無料) を使うこと
- `handler-must-not-call-fetch` — `lib/handlers/` 配下で `fetch(` 直接呼び出しを error。Service / Repository に閉じ込める
- `authoritative-docs-present` — `docs/architecture/harness.md` に必須 invariant ID が並んでいるか
- `agent-guides-run-harness` — `AGENTS.md` / `CLAUDE.md` から harness 実行が参照されているか

## 落ちたときの対処

1. 出力に `## Findings` で列挙される `ruleId` / `filePath` / `line` を確認
2. `recommendation` 欄に修正方針が書いてある — それに従ってコードを直す
3. invariant ID が `docs/architecture/harness.md` から欠落していると言われたら、harness.md に該当 ID の節を追加する (削るのではなく、原則として記述する)

## 関連

- `/tech-debt` (= `make tech-debt`) — 技術的負債スキャン (test smell / 結合 / fallback 検出)
- [`docs/architecture/harness.md`](../../../docs/architecture/harness.md) — 不変条件の正本
- [`.claude/harness/src/architecture.ts`](../../../.claude/harness/src/architecture.ts) — ルール実装
