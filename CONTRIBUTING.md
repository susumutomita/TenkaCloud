# コントリビューションガイド

TenkaCloud へのコントリビューションを歓迎します。

## セットアップ

```bash
git clone --recurse-submodules https://github.com/<your-username>/TenkaCloud.git
cd TenkaCloud
make install
make start
```

## 開発フロー

1. Issue を確認（`good first issue` / `help wanted`）
2. ブランチを作成: `git checkout -b feat/your-feature`
3. TDD でコードを書く（テストタイトルは日本語「〜すべき」形式）
4. `make before-commit` を実行（lint・format・typecheck・test 99％+・build）
5. PR を作成（タイトル 70 文字以内、Conventional Commits 形式）

## コミットメッセージ

[Conventional Commits](https://www.conventionalcommits.org/) に従います: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`

## ルールと禁止事項

[CLAUDE.md](./CLAUDE.md) を参照してください。

## 質問・相談

- [GitHub Discussions](https://github.com/susumutomita/TenkaCloud/discussions)
- [GitHub Issues](https://github.com/susumutomita/TenkaCloud/issues)

コントリビューションは [MIT License](./LICENSE) の下で公開されます。
