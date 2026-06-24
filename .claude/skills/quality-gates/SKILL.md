---
name: quality-gates
description: 本体（Makefile / CI / scripts）から切り離した品質ゲート検査を走らせる。HTTP マジックナンバー・100% カバレッジ・CFn template 整合 / security / 命名上限・IAM Description ASCII・merge 整合・submodule pin を検査する。コミット前チェック、PR 前の品質確認、template の安全性確認のときに使う。
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

# すべて（on-demand の誤検知ありも含む。AI で判断する前提）
bun run .claude/skills/quality-gates/scripts/run.ts --all

# 個別
bun run .claude/skills/quality-gates/scripts/run.ts template-security
```

いずれかが失敗すると runner は exit 1。

## 検査一覧

| check | group | 走査対象 | 何を検査するか |
| --- | --- | --- | --- |
| `http-magic-numbers` | precommit | `infrastructure/lib` + `apps/*/src` | `c.json(body, 200)` / `res.status === 401` の HTTP 数値リテラル直書き禁止（`StatusCodes.*` を使う） |
| `no-conflicts` | precommit | git | HEAD が `origin/main` へ clean に merge できるか（PR 提出前の DIRTY 化を予防） |
| `template-ascii` | precommit | `infrastructure/templates` + `problems` | IAM Description が CJK 等で `CREATE_FAILED` しないよう yaml を ASCII + Latin-1 範囲に gate（#664） |
| `template-cfn-refs` | precommit | `problems` | template の `!Ref` / `!GetAtt` が宣言済 resource を指すか + `ParticipantViewerRole` 必須宣言（#951） |
| `template-name-limits` | precommit | `problems` | `RoleName` / `FunctionName` を `${NamePrefix}` 込みで明示し 64 文字上限を超えないか（#1812） |
| `synth-iam-ascii` | precommit | `infrastructure/cdk.out` | synth 済 template の IAM Description が Latin-1 範囲か（#664）。`make before-commit`（check-synth）が cdk.out を作った後に走る |
| `coverage-gate` | ci | `*/coverage/lcov.info` | agent 所有 workspace（3 SPA + 共有 package）が lines/functions/branches 100% か（#1424）。要 `make test-coverage` |
| `submodule-not-behind` | ci | git submodule | `problems/` pin が `origin/main` より後退/分岐していないか。要 `origin/main` + submodule history |
| `template-security` | ondemand | `problems` | IAM wildcard / SG 全開 / public S3 / KMS rotation 無し等の危険パターン（#869） |
| `template-cli-access` | ondemand | `problems` | `ParticipantViewerRole` に Console federation 後の CLI/CloudShell access に要る managed policy が付くか |

## AI + スクリプトの合わせ技（on-demand）

`template-security` / `template-cli-access` は**意図的に脆弱な問題**や**既存の互換テンプレ**で誤検知（NG 表示）が出る。これらはコミットを機械的に止めず、このスキル経由で Claude が出力を読んで判断する。

- `template-security` の NG → その問題が `Metadata.tenkacloud.allowIntentionallyVulnerable: true` を宣言した意図的脆弱問題（例: `waf-classic-kuyo` の wildcard）なら問題なし。そうでなければ最小権限へ絞る。
- `template-cli-access` の NG → 競技者が Console federation 後に CLI/CloudShell を使う問題なら managed policy を追加。使わない設計なら無視可。

> 問題テンプレート（`problems/**`）は別リポ **TenkaCloudChallenge**（`problems/` submodule）が正本。テンプレ系チェックの最終的な gate はそちらが持つ。ここではプラットフォーム側からオンデマンドで横断確認するために同梱している。

## いつ走るか

- **pre-commit フック**（`.husky/pre-commit`）が `make before-commit`（本体）とは**別の呼び出し**として precommit グループを走らせる。本体と混ざらないが、コミット前には必ず走る。
- **CI**（`.github/workflows/ci.yml`）が成果物を作った後に `--ci` グループを走らせる。
- 手動 / PR 前は `/quality-gates` で `--all` を AI 判断つきで走らせる。

## 関連

- `/harness` — アーキテクチャ不変条件（`INVARIANT_*`）の機械チェック（別系統、`.claude/harness/`）
- `/tech-debt` — 技術的負債スキャン
