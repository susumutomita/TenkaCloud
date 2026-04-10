# ADR-008: AI 改善ループをハーネス優先で導入する

- **Status**: Accepted
- **Date**: 2026-04-11
- **Deciders**: susumutomita

## Context

機能追加を優先するあまり、空配列返し・stub・route ごとの fallback 重複・UI 直 fetch のような一時しのぎが入りやすくなっていた。これらはローカルでは動いて見えても、本来の仕様や責務境界を壊し、レビュー品質も落とす。

AI を使う前提の repo では、実装方針を口頭で注意するだけでは足りない。AI が着手前に負債を検出し、危険な実装を自分で落とせるハーネスが必要になる。

## Decision

1. `scripts/ai-improvement-loop.ts` を追加し、repo 全体を走査して技術的負債バックログを出力する
2. 検出ルールは `packages/shared/src/quality/tech-debt-loop.ts` に集約し、テストで固定する
3. 次を高優先の負債として扱う
   - 空配列返し・stub・empty dataset で握り潰す fallback
   - UI からの直接 `fetch`
   - UI からの直接 `process.env.*API_URL`
   - route handler ごとの fallback 重複
   - oversized module
   - アサーションルーレット
4. AI エージェントは大きい変更の前後で `bun scripts/ai-improvement-loop.ts --write --fail-on=high` を実行する
5. `high` 以上の負債がある領域では、機能追加より先に負債解消を優先する

## Consequences

- **Good**: 一時しのぎを仕様として固定化しにくくなる。AI が自発的に改善対象を見つけやすくなる。レビューで指摘される前に境界違反を潰せる。
- **Bad**: すぐに機能追加へ進めない場面が増える。小さな変更でも先に負債整理が必要になる。
- **Tradeoff**: 実装速度は一時的に下がるが、変更容易性とレビュー通過率は上がる。

## References

- [AGENTS.md](../../AGENTS.md)
- [docs/CONTRIBUTING.md](../CONTRIBUTING.md)
