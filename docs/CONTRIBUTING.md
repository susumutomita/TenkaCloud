# コントリビューションガイド

TenkaCloud へのコントリビューションを歓迎します。

## 開発に参加する方法

### 1. Issue を確認する

[GitHub Issues](https://github.com/susumutomita/TenkaCloud/issues) で現在のタスクを確認してください。

- `good first issue` ラベル: 初めての方におすすめ
- `help wanted` ラベル: コントリビューション募集中
- `bug` ラベル: バグ修正
- `enhancement` ラベル: 機能追加

### 2. 開発環境をセットアップする

```bash
# リポジトリをフォーク後、クローン
git clone --recurse-submodules https://github.com/<your-username>/TenkaCloud.git
cd TenkaCloud

# 依存関係をインストール
bun install

# ローカル環境を起動
make start
```

詳細は [QUICKSTART.md](./QUICKSTART.md) を参照。

### 3. ブランチを作成する

```bash
git checkout -b feature/your-feature-name
# または
git checkout -b fix/bug-description
```

### 4. コードを書く

#### コーディング規約

- **TypeScript**: strict mode を使用
- **テスト**: TDD でテストを先に書く
- **テストタイトル**: 日本語で「〜すべき」形式
- **コミット前**: `make before-commit` を必ず実行

#### 必須チェック

```bash
# コミット前に以下がすべて通ることを確認
make before-commit
```

このコマンドは以下の処理を実行します。

- `lint` - ESLint によるコード検証
- `format` - Prettier によるフォーマット
- `typecheck` - TypeScript 型チェック
- `test` - Vitest によるテスト（カバレッジ 99％ 以上）
- `build` - ビルド成功確認

### 5. Pull Request を送る

```bash
# 変更をコミット
git add .
git commit -m "feat: 機能の説明"

# フォーク先にプッシュ
git push origin feature/your-feature-name
```

GitHub で Pull Request を作成してください。

## コミットメッセージ規約

[Conventional Commits](https://www.conventionalcommits.org/) に従います。

```
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

## プロジェクト構造

```
TenkaCloud/
├── apps/                    # フロントエンド（Next.js）
├── backend/services/        # バックエンド（マイクロサービス）
├── packages/                # 共有パッケージ
├── infrastructure/          # IaC（Terraform）
├── docs/                    # ドキュメント
└── Makefile                 # 開発コマンド
```

詳細は [OVERVIEW.md](./OVERVIEW.md) を参照。

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

## 質問・相談

- **技術的な質問**: [GitHub Discussions](https://github.com/susumutomita/TenkaCloud/discussions)
- **バグ報告**: [GitHub Issues](https://github.com/susumutomita/TenkaCloud/issues)

## ライセンス

コントリビューションは MIT License の下で公開されます。
