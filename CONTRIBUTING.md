# コントリビューションガイド

TenkaCloud へのコントリビューションを歓迎します。このガイドでは、プロジェクトへの参加方法を説明します。

> [English version is coming soon]

## 行動規範

本プロジェクトは [Contributor Covenant](./CODE_OF_CONDUCT.md) を採用しています。参加者全員がこの行動規範に従うことを求めます。

## 開発に参加する方法

### 1. Issue を確認する

[GitHub Issues](https://github.com/susumutomita/TenkaCloud/issues) で現在のタスクを確認してください。

- `good first issue` ラベル: 初めての方におすすめ
- `help wanted` ラベル: コントリビューション募集中
- `bug` ラベル: バグ修正
- `enhancement` ラベル: 機能追加

新しい機能の提案やバグ報告は Issue を作成してください。

### 2. 開発環境をセットアップする

#### 必要要件

- [Bun](https://bun.sh/) 1.2 以上
- [Docker](https://www.docker.com/) & Docker Compose
- [AWS CLI](https://aws.amazon.com/cli/) v2
- [Terraform](https://www.terraform.io/)（Auth0 セットアップ時）

#### セットアップ手順

```bash
# リポジトリをフォーク後、クローン
git clone --recurse-submodules https://github.com/<your-username>/TenkaCloud.git
cd TenkaCloud

# 依存関係をインストール
make install

# ローカル環境を起動（Docker Desktop を先に起動してください）
make start
```

詳細は [クイックスタートガイド](./docs/QUICKSTART.md) を参照してください。

### 3. ブランチを作成する

```bash
git checkout -b feat/your-feature-name
# または
git checkout -b fix/bug-description
```

### 4. コードを書く

#### 開発原則

- **TDD（テスト駆動開発）**: テストを先に書く
- **テストタイトル**: 日本語で「〜すべき」形式
- **カバレッジ**: 99％ 以上を維持
- **インクリメンタル開発**: 小さい意味のある単位で変更する

#### コーディング規約

- TypeScript strict mode を使用
- ESLint + Prettier でコードを検証・整形
- コンポーネント駆動開発

#### コミット前の必須チェック

```bash
make before-commit
```

このコマンドは以下をすべて実行します。

- textlint — Markdown の日本語校正
- format_check — Prettier によるフォーマット検証
- typecheck — TypeScript 型チェック
- test_coverage — Vitest によるテスト（カバレッジ 99％ 以上）
- build — ビルド成功確認

### 5. Pull Request を送る

```bash
# 変更をコミット
git add .
git commit -m "feat: 機能の説明"

# フォーク先にプッシュ
git push origin feat/your-feature-name
```

GitHub で Pull Request を作成してください。

#### PR のガイドライン

- PR タイトルは簡潔に（70 文字以内）
- 変更の目的と内容を説明する
- 大きな機能は複数の PR に分割する
- CI がすべて通ることを確認する

## コミットメッセージ規約

[Conventional Commits](https://www.conventionalcommits.org/) に従います。

```text
<type>: <description>

[optional body]
```

### Type の種類

| Type | 用途 |
|------|------|
| `feat` | 新機能 |
| `fix` | バグ修正 |
| `docs` | ドキュメント変更 |
| `style` | フォーマット変更（コード動作に影響なし） |
| `refactor` | リファクタリング |
| `test` | テスト追加・修正 |
| `chore` | ビルド設定・ツール変更 |

### 例

```bash
feat: テナント一覧の検索機能を追加
fix: ログイン時のリダイレクトエラーを修正
docs: CONTRIBUTING.md を追加
test: tenant-management の単体テストを追加
```

## 禁止事項

以下に該当する PR はリジェクトされます。

- `rm` コマンドの使用（環境破壊リスク）
- コミット/PR での `#番号` 形式の Issue 引用（GitHub 自動リンクでノイズになる）
- モックデータ、ハードコード配列、スタブ API（実際の DB 接続と API 統合を実装する）
- テストカバレッジ 99％ 未満

## よく使うコマンド

```bash
# ローカル環境
make start              # 起動
make stop               # 停止
make status             # 状態確認

# 開発
make dev                # Control Plane のみ起動
make test               # テスト実行
make test-coverage      # カバレッジ付きテスト

# コード品質
make lint               # Linter 実行
make format             # フォーマット
make typecheck          # 型チェック
make before-commit      # コミット前チェック（必須）

# すべてのコマンドを表示
make help
```

## プロジェクト構造

```text
TenkaCloud/
├── apps/                    # フロントエンド（Next.js）
├── backend/services/        # バックエンド（マイクロサービス）
├── packages/                # 共有パッケージ
├── infrastructure/          # IaC（Terraform）
├── docs/                    # ドキュメント
└── Makefile                 # 開発コマンド
```

詳細は [プロジェクト概要](./docs/OVERVIEW.md) を参照してください。

## 質問・相談

- **技術的な質問**: [GitHub Discussions](https://github.com/susumutomita/TenkaCloud/discussions)
- **バグ報告・機能提案**: [GitHub Issues](https://github.com/susumutomita/TenkaCloud/issues)

## ライセンス

コントリビューションは [MIT License](./LICENSE) の下で公開されます。
