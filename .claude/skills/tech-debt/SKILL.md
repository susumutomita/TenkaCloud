---
name: tech-debt
description: TenkaCloud tech-debt analyzer を実行し、test smell / 結合漏れ / 握り潰し fallback 等の技術的負債を検出する。コード品質、テスト改善、リファクタの優先順位、技術的負債バックログを訊かれたときに使う。
allowed-tools: Bash(make tech-debt:*), Bash(bun run .claude/harness/bin/tech-debt.ts:*)
---

# TenkaCloud Tech Debt Loop

リポジトリ全体を静的解析し、優先度つきの技術的負債バックログを生成する。実装は [`.claude/harness/src/tech-debt.ts`](../../../.claude/harness/src/tech-debt.ts)。

## 実行方法

stdout に markdown レポート (デフォルト):

```bash
make tech-debt
```

`docs/tech-debt/backlog.md` と `backlog.json` に書き出し:

```bash
bun run .claude/harness/bin/tech-debt.ts --write
```

Staged ファイルのみ + severity gate (PR 前に走らせる用):

```bash
bun run .claude/harness/bin/tech-debt.ts --staged --fail-on=high
```

`--fail-on=high` 指定時、`high` か `critical` が 1 件でもあれば exit 2 で終了する。

## 検出するパターン

各 finding に severity (`critical` / `high` / `medium`) と修正方針 (`recommendation`) が付く。

- **assertion-roulette** — 単一テストケース内の `expect` が多すぎて失敗原因が読み取れない
- **auth-skip-leak** — `AUTH_SKIP` 判定が責務境界の外に漏れている
- **direct-service-env** — フロントエンドから直接 `process.env.*API_URL` を読んでいる (`runtime-config.json` 経由にすべき)
- **router-without-zod** — API router に入力検証 (Zod) が無い
- **band-aid-fallback** — `console.warn("fallback to empty…")` のような握り潰しパターン
- **direct-fetch-in-app** — `apps/*/app/` 配下で直接 `fetch()` を叩いている (api クライアントに閉じ込めるべき)

## 落ちたときの対処

1. `## Hotspots` で finding が集中するファイルを確認
2. 同じ ruleId が複数出ている場合は、まずそのパターンを 1 箇所だけ模範実装で直して、残りを追従
3. `--write` で `docs/tech-debt/backlog.md` を更新し、PR で「この PR で解消したもの / 残存」を明示

## 関連

- `/harness` (= `make harness`) — アーキテクチャ不変条件チェック
- `docs/tech-debt/backlog.md` — `--write` で更新される永続バックログ
- [`.claude/harness/src/tech-debt.ts`](../../../.claude/harness/src/tech-debt.ts) — ルール実装
