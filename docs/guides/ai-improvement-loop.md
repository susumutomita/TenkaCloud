# AI 改善ループ

AI にコードを書かせる前提では、実装より先に「何を直すべきか」を機械的に拾える必要がある。TenkaCloud では `scripts/ai-improvement-loop.ts` をその入口にする。

## 目的

- 一時しのぎの fallback を検出する
- UI / route / service の責務漏れを検出する
- テスト品質の劣化を検出する
- 次に直すべき負債を優先度付きで出す

## 実行

```bash
bun scripts/ai-improvement-loop.ts --write --fail-on=high
```

生成物は次のとおり。

- `docs/tech-debt/backlog.md`
- `docs/tech-debt/backlog.json`

`--fail-on=high` を付けると、`high` 以上の負債がある場合は non-zero で終了する。AI エージェントやレビュー前チェックではこのモードを使う。

## 強制ポイント

- `.claude/settings.json`
  Claude の `PostToolUse` で `quality-guard.sh` を実行し、編集直後に危険な一時しのぎをブロックする
- `.claude/settings.json`
  `git commit` 実行前に staged files へ `bun scripts/ai-improvement-loop.ts --staged --fail-on=high` を走らせる
- `.husky/pre-commit`
  Git の commit 前に同じ staged check を再実行し、その後 `make before-commit` を実行する

## いま検出する負債

- 空配列返し・stub・empty dataset で握り潰す fallback
- UI からの直接 `fetch`
- UI からの直接 `process.env.*API_URL`
- route handler ごとの fallback 重複
- oversized module
- アサーションルーレット

## 運用ルール

1. 大きい変更の前に実行する
2. 触る領域に `high` 以上があるなら先に解消する
3. 機能追加後に再実行し、新しい負債を増やしていないことを確認する
4. `empty dataset` や `stub` で通したコードは、その時点で未完了扱いにする

## 期待する状態

- AI が最初に backlog を読む
- AI が危険な fallback を自分で止める
- PR に「なぜこの構造なのか」を説明できる
- レビューでアーキテクチャ指摘より仕様確認に時間を使える
