---
name: tech-debt
description: TenkaCloud tech-debt analyzer を実行し、test smell / 結合漏れ / magic number 等の技術的負債を検出する。コード品質、テスト改善、リファクタの優先順位、技術的負債バックログを訊かれたときに使う。
allowed-tools: Bash(make tech-debt:*), Bash(bun run .claude/harness/bin/tech-debt.ts:*)
---

# TenkaCloud Tech Debt Loop

リポジトリ全体を静的解析し、ルールごとにグルーピングした finding 一覧を出力する。ルール実装は [`.claude/harness/src/tech-debt/`](../../../.claude/harness/src/tech-debt/) 配下に 1 ルール = 1 ファイルで配置。

## 実行方法

全 tracked file を scan (デフォルト):

```bash
make tech-debt
```

Staged ファイルのみ + severity gate (PR 前 / pre-commit 用):

```bash
bun run .claude/harness/bin/tech-debt.ts --staged --fail-on=error
```

`--fail-on` が無指定の場合は `warning` 以上で exit 2 になる (= advisory ベース)。`error` 指定で error 級だけを blocker 扱いにできる。

現状を baseline として凍結し、 新規違反のみ block する:

```bash
bun run .claude/harness/bin/tech-debt.ts --baseline
```

これで `.claude/harness/baselines/tech-debt-<rule>.json` が更新される。 既存違反は許容、 新規追加のみ次回 run で finding として上がる。

## 検出するパターン

各 finding には severity (`error` / `warning` / `info`) と修正方針 (`recommendation`) が付く。

- **assertion-roulette** (= test smell) — `it()` / `test()` 1 ブロック内の `expect()` が 6 個以上。 失敗時にどの assertion で死んだか読み取りにくいので、 振る舞い単位で test case を分割する。
- **high-coupling** (= SRP 違反候補) — `infrastructure/lib/` 等 production code で 1 ファイルが 16 個以上の module を import している。 26 個で重警告、 41 個で error (= 必ず分割)。
- **magic-number** (= 意図不明な数値リテラル) — HTTP status code (`c.json(body, 500)` / `res.status === 401`) / timeout (`60000` ms 等) / port (`3000` / `8080` 等) を直書きしている。 `StatusCodes.*` (= `http-status-codes`) や名前付き定数に抽出する。

## 落ちたときの対処

1. 同じ `ruleId` が複数出ている場合は、 まずそのパターンを 1 箇所だけ模範実装で直して、 残りを追従
2. 既存大規模違反 (= legacy debt) は `--baseline` で凍結し、 新規追加だけ block する設計
3. 1 PR で同 rule の finding を 5+ 件解消したら baseline を再生成して "ratchet" を進める

## 関連

- `/harness` (= `make harness`) — アーキテクチャ不変条件チェック (= 兄弟 tool)
- [`.claude/harness/src/tech-debt/`](../../../.claude/harness/src/tech-debt/) — ルール実装 (1 file = 1 rule)
- [`.claude/harness/baselines/tech-debt-*.json`](../../../.claude/harness/baselines/) — per-rule baseline (= legacy debt 凍結)
