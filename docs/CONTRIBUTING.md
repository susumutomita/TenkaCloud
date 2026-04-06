# コントリビューションガイド

TenkaCloud へのコントリビューションを歓迎します。

## 開発環境

### 前提

- [Bun](https://bun.sh) v1.2+（`mise` で自動管理）
- Docker Desktop
- Git

### セットアップ

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make install   # 依存関係インストール
make start     # 全サービス起動
```

詳細は [QUICKSTART.md](./QUICKSTART.md) を参照。

## 開発フロー

1. Issue を確認し、ブランチを作成する
2. **テストを先に書く**（TDD）
3. 実装する
4. `make before-commit` を通す
5. PR を作成する

```bash
git checkout -b feat/your-feature
# テストを書く → 実装する → 繰り返す
make before-commit   # 必須。通らなければ PR を出さない
git push -u origin HEAD
gh pr create
```

## 品質基準

### `make before-commit` が実行するチェック

| チェック | ツール | 基準 |
|---------|-------|------|
| Markdown lint | Textlint | 日本語ルール準拠 |
| フォーマット | Biome | 自動整形ルール準拠 |
| 型チェック | TypeScript (`tsc --noEmit`) | エラーゼロ |
| テスト | Vitest + Istanbul | カバレッジ 99％+ (statements, branches, functions, lines) |
| ビルド | Next.js | 全アプリビルド成功 |

### テスト

- テストタイトルは**日本語「〜すべき」形式**
- カバレッジ 99％+ を維持する
- テスト不能コード（SSE abort 等）は `/* istanbul ignore next */` で除外し理由を書く
- `vi.hoisted` + `vi.mock` パターンで `instanceof` チェックのあるクラスをモックする

### セキュリティ

- ユーザー入力は **Zod スキーマ**でバリデーション
- 認証バイパス（`AUTH_SKIP`）には **`NODE_ENV !== "production"` ガード**必須
- シークレットをコミットしない（`.env`, credentials）
- XSS/インジェクション対策を意識する

### コーディングスタイル

- **TypeScript strict mode**
- **Biome** でフォーマット・リント（フロントエンド）
- **Cloudscape Design System** で UI を構築（独自コンポーネントより Cloudscape 優先）
- パッケージ操作は `ni` / `nr` / `bunx` を使う（**`npx` 禁止**）

## コミットメッセージ

[Conventional Commits](https://www.conventionalcommits.org/) に従う。

| Type | 用途 |
|------|------|
| `feat` | 新機能 |
| `fix` | バグ修正 |
| `test` | テスト追加・修正 |
| `docs` | ドキュメント変更 |
| `refactor` | リファクタリング |
| `chore` | ビルド設定・ツール変更 |

```
feat: テナント一覧の検索機能を追加
fix: ログイン時のリダイレクトエラーを修正
test(gameday-service): カバレッジを 99% 以上に改善
```

## 禁止事項

以下に該当する PR はリジェクトされます。

| 禁止 | 理由 |
|------|------|
| `rm` コマンド | 環境破壊リスク |
| `npx` | `bunx` を使う |
| コミットでの `#番号` Issue 引用 | GitHub 自動クローズ誤作動 |
| モックデータ・スタブ API | DynamoDB を使う |
| カバレッジ 99％未満 | 品質基準 |
| 設定ファイルの直接変更 | コードで解決する |

## プロジェクト構造

```
TenkaCloud/
├── apps/
│   ├── control-plane/         # テナント管理 UI (Next.js, :13000)
│   └── application-plane/     # GameDay/Battle UI (Next.js, :13001)
├── backend/services/
│   ├── shared/                # DynamoDB, イベント型, 認証
│   ├── control-plane/         # テナント管理, プロビジョニング
│   └── application-plane/     # problem, gameday, battle, scoring, leaderboard
├── packages/                  # 共有ライブラリ
├── docs/decisions/            # ADR（アーキテクチャ決定記録）
├── infrastructure/            # IaC（Terraform, Auth0）
└── Makefile                   # 開発コマンド（`make help` で一覧）
```

## よく使うコマンド

```bash
make start           # 全サービス起動
make stop            # 全サービス停止
make status          # サービス状態確認
make test_quick      # 高速テスト（カバレッジなし）
make before-commit   # コミット前チェック（必須）
make help            # 全コマンド一覧
```

## 質問・相談

- 技術的な質問: [GitHub Discussions](https://github.com/susumutomita/TenkaCloud/discussions)
- バグ報告: [GitHub Issues](https://github.com/susumutomita/TenkaCloud/issues)

## ライセンス

コントリビューションは MIT License の下で公開されます。
