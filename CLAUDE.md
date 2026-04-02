# TenkaCloud

CRITICAL: タスク完了前に `make before-commit` を実行。lint・format・typecheck・test（カバレッジ 99％+）・build すべて通るまで未完了。

## Rules

- TDD: テストを先に書く。テストタイトルは日本語「〜すべき」形式
- PR: 小さい意味のある単位。PR 作成まで含めてタスク完了
- パッケージ管理: `ni`/`nr`/`nlx` を使用（`npx` 禁止）

## Prohibitions

- `rm` コマンド（環境破壊リスク）
- コミット/PR での `#番号` 形式の Issue 引用
- モックデータ・ハードコード配列・スタブ API

## Quick Start

```bash
make start          # 全サービス起動
make gameday-seed   # GameDay デモデータ投入
make help           # 全コマンド一覧
```

## Pointers

- デザインシステム: [Cloudscape](https://cloudscape.design/components/)（AWS 公式、全コンポーネントはここから選択）
- フロントエンドデザイン: `/skill frontend-design`
- スペック・仕様書: `/skill spec`
- アーキテクチャ決定記録: `docs/decisions/`
- エージェント設定: @AGENTS.md
