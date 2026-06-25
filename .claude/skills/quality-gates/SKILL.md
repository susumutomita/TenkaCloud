---
name: quality-gates
description: 本体（Makefile / CI / scripts）から切り離した品質ゲート検査を走らせる。HTTP マジックナンバー・100% カバレッジ・IAM Description ASCII・merge 整合・submodule pin を検査する。コミット前チェック、PR 前の品質確認のときに使う。
allowed-tools: Bash(bun run .claude/skills/quality-gates/scripts/run.ts:*), Bash(bun run .claude/skills/quality-gates/scripts/check-*.ts:*)
---

# TenkaCloud Quality Gates

製品本体（`apps/` / `infrastructure/` / `scripts/` / Makefile `GATE_CHECKS` / CI）と品質チェックを**混ぜない**ために、検査ロジックをここ（`.claude/` = Claude のツール領域）へ寄せたもの。本体は肥大化させず、品質チェックはコミット前にきちんと走る ―― この 2 つを両立させる設計。

検査の中身（grep / YAML 解析 / lcov 解析 / git）は価値があるので捨てず、スクリプトとして保持する。誤検知が出やすいものは AI（このスキル経由の Claude）が出力を読んで判断する「AI + スクリプトの合わせ技」で扱う。

実装は [`scripts/`](./scripts/) に同梱。**必ずリポジトリルートから実行**する（各スクリプトは `process.cwd()` を起点に走査する）。

## 実行方法

```bash
# pre-commit グループ（高速・決定的。pre-commit フックが自動で走らせる）
bun run .claude/skills/quality-gates/scripts/run.ts

# pre-commit + CI グループ（成果物 / ネットワークが要るもの。CI 用）
bun run .claude/skills/quality-gates/scripts/run.ts --ci

# すべて（precommit + ci。現在 on-demand グループは空）
bun run .claude/skills/quality-gates/scripts/run.ts --all

# 個別
bun run .claude/skills/quality-gates/scripts/run.ts template-ascii
```

いずれかが失敗すると runner は exit 1。

## 検査一覧

| check | group | 走査対象 | 何を検査するか |
| --- | --- | --- | --- |
| `http-magic-numbers` | precommit | `infrastructure/lib` + `apps/*/src` | `c.json(body, 200)` / `res.status === 401` の HTTP 数値リテラル直書き禁止（`StatusCodes.*` を使う） |
| `no-conflicts` | precommit | git | HEAD が `origin/main` へ clean に merge できるか（PR 提出前の DIRTY 化を予防） |
| `template-ascii` | precommit | `infrastructure/templates` | IAM Description が CJK 等で `CREATE_FAILED` しないよう自前テンプレ yaml を ASCII + Latin-1 範囲に gate（#664）。問題テンプレ（`problems/**`）はカタログ側が検証 |
| `synth-iam-ascii` | precommit | `infrastructure/cdk.out` | synth 済 template の IAM Description が Latin-1 範囲か（#664）。`make before-commit`（check-synth）が cdk.out を作った後に走る |
| `coverage-gate` | ci | `*/coverage/lcov.info` | agent 所有 workspace（3 SPA + 共有 package）が lines/functions/branches 100% か（#1424）。要 `make test-coverage` |
| `submodule-not-behind` | ci | git submodule | `problems/` pin が `origin/main` より後退/分岐していないか。要 `origin/main` + submodule history |

## 問題テンプレートの検証はカタログ側が持つ

問題テンプレート（`problems/<category>/<id>/template.yaml`）は別リポ **TenkaCloudChallenge**（`problems/` submodule）が正本で、`!Ref` 整合・命名上限・IAM security・CLI access などの検証はカタログ側（`problems/scripts/`）が持つ。プラットフォームは問題を host するだけで、プラグインである問題テンプレの検証責務は負わない。このため本スキルの template 系チェックは自前の `infrastructure/templates/` のみを対象にし、`problems/**` は除外する。

## いつ走るか

- **pre-commit フック**（`.husky/pre-commit`）が `make before-commit`（本体）とは**別の呼び出し**として precommit グループを走らせる。本体と混ざらないが、コミット前には必ず走る。
- **CI**（`.github/workflows/ci.yml`）が成果物を作った後に `--ci` グループを走らせる。
- 手動 / PR 前は `/quality-gates` で `--all` を走らせて出力を確認する。

## 関連

- `/harness` — アーキテクチャ不変条件（`INVARIANT_*`）の機械チェック（別系統、`.claude/harness/`）
- `/tech-debt` — 技術的負債スキャン
