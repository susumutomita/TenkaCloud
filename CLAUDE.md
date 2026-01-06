# TenkaCloud — The Open Cloud Battle Arena

クラウド技術者のための OSS 競技プラットフォーム。AWS GameDay 文化をルーツに、完全スクラッチで再構築された常設のクラウド天下一武道会。

## Core Values

- 完全 OSS: 社内資産を含まず、ゼロから設計
- マルチクラウド: AWS / GCP / Azure / LocalStack / OCI 対応
- マルチテナント SaaS: [EKS Reference Architecture](./reference/eks) をベースに設計
- AI 支援: MCP/Claude Code 統合による問題生成・自動採点・コーチング

## Development Rules

CRITICAL: タスク完了前に必ず `make before-commit` を実行する。lint、format、typecheck、test（カバレッジ 99％以上）、build がすべて通るまでタスクは完了とみなさない。

インクリメンタル開発: 小さい意味のある単位で PR を作成する。大きな機能は複数の PR に分割し、各 PR はレビュー可能なサイズに保つ。PR 作成まで含めてタスク完了とする。

以下は禁止事項です。
- `rm` コマンドの使用（環境破壊リスク）
- コミット/PR での `#番号` 形式の Issue 引用（GitHub 自動リンクでノイズになる）
- モックデータ、ハードコード配列、スタブ API（実際の DB 接続と API 統合を実装する）

実装原則: TDD でテストを先に書く。テストタイトルは日本語で「〜すべき」形式。小さく動くものを素早く作り、段階的に改善する。

## Ubiquitous Language

プロジェクト全体で統一する用語を以下に示します。
- Tenant: TenkaCloud を利用する組織・企業単位
- Control Plane: テナント管理・認証を担う共有プラットフォーム
- Application Plane: テナント固有のビジネスロジックを実行するサービス群
- Battle: クラウド構築の競技セッション
- Participant: バトルに参加する競技者
- Problem: クラウドインフラ構築の課題

## Technical Notes

Dockerfile: ランタイムバージョンはローカル環境と一致させる（`oven/bun:1.2.20` など）。`latest` タグは lockfile エラーの原因になる。

NextAuth + Auth0: 認証には Auth0 を使用。環境変数 `AUTH0_CLIENT_ID`、`AUTH0_CLIENT_SECRET`、`AUTH0_ISSUER` を `.env.local` で設定する。

パッケージ管理: [@antfu/ni](https://github.com/antfu-collective/ni) を使用。`ni`、`nr`、`nlx` コマンドが lock ファイルから自動で bun を選択する。

フロントエンドデザイン: `/skill frontend-design` を参照。ジェネリックな AI 風デザイン（Inter、Roboto、白背景に紫グラデーション等）は禁止。意図的で独自性のあるデザインを選択する。

スペック・仕様書: `/skill spec` を使用。Open Web Docs 形式（MDN スタイル）で記述する。

## Quick Start

```bash
make start  # 全サービス起動（詳細は Makefile 参照）
```

---

GitHub Issues で機能提案・バグ報告、Discussions で技術的な議論。
