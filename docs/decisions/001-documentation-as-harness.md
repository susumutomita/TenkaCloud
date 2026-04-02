# ADR-001: ドキュメント体系をハーネスエンジニアリングに移行

- **Status**: Accepted
- **Date**: 2026-04-02
- **Deciders**: susumutomita

## Context

CLAUDE.md が説明的な内容を含み肥大化傾向にあった。Hooks は Git commit 前の before-commit のみで、ファイル編集時のリアルタイムフィードバックがなかった。設計ドキュメントが docs/ に散在し、現在の実装との乖離が判別できない状態だった。

参照: [Harness Engineering Best Practices 2026](https://nyosegawa.com/posts/harness-engineering-best-practices-2026/)

## Decision

1. **CLAUDE.md をポインター型に**: 30 行以下。ルールと禁止事項のみ記載し、詳細は外部に委譲
2. **AGENTS.md を実体化**: エージェント向けエントリポイントとして独立
3. **Hook 階層を構築**:
   - PreToolUse: 設定ファイル保護ゲート + Git commit 前の before-commit
   - PostToolUse: Prettier 自動フォーマット
   - Stop: 変更検知時のプレビュー検証リマインダー
4. **ADR パターンを導入**: `docs/decisions/` にアーキテクチャ決定を記録
5. **CONTRIBUTING.md を簡潔化**: CLAUDE.md/AGENTS.md と重複する内容をポインターに

## Consequences

- **Good**: エージェントの品質ループが高速化（編集→即フォーマット）、設定ファイルの意図しない変更を防止、CLAUDE.md のプライマシーバイアス低減
- **Bad**: Hook スクリプトの保守コスト増加、新規コントリビューターの学習曲線が若干上昇
- **Tradeoff**: 説明的ドキュメントの削減により、コードリーディング能力が前提となる

## References

- https://nyosegawa.com/posts/harness-engineering-best-practices-2026/
