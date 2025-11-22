# TenkaCloud Admin UI

テナント管理者向けダッシュボードです。

## 概要

Admin UI は、テナント管理者がバトル管理・問題管理・チーム管理を担当するための Web アプリケーションです。

## 機能

- バトル管理: バトルセッションの作成、開始、終了、結果確認
- 問題管理: 問題の作成、編集、削除、プレビュー
- チーム管理: チームメンバーの招待、権限管理
- リーダーボード: チーム内のスコアボード表示
- 統計ダッシュボード: バトル参加状況、スコア推移の可視化

## 技術スタック

- Next.js 16 (App Router)
- TypeScript
- Tailwind CSS
- Biome (Linter/Formatter)
- Vitest + React Testing Library (Testing)

## 開発

```bash
# 依存関係のインストール
npm install

# 開発サーバー起動 (ポート 3001)
npm run dev

# ビルド
npm run build

# 型チェック
npm run typecheck

# Lint
npm run lint

# テスト
npm run test

# テストカバレッジ
npm run test:coverage
```

## ディレクトリ構造

```
admin-app/
├── app/              # Next.js App Router
│   ├── layout.tsx    # ルートレイアウト
│   ├── page.tsx      # ホームページ
│   └── globals.css   # グローバルスタイル
├── components/       # React コンポーネント（今後追加）
├── lib/              # ユーティリティ（今後追加）
└── public/           # 静的ファイル（今後追加）
```

## 認証

Admin UI は Keycloak (OIDC) による認証を使用します。
テナント管理者としてログインしてください。

## 関連ドキュメント

- [TenkaCloud CLAUDE.md](/CLAUDE.md)
- [Control Plane UI](/frontend/control-plane-app/README.md)
- [Participant UI](/frontend/participant-app/README.md)
