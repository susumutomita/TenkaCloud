# TenkaCloud Participant UI

競技者用UI

## 概要

Participant UIは、クラウド天下一武道会の競技者がバトルに参加し、問題を解くためのWebアプリケーションです。

## 機能

- **バトル参加**: リアルタイムバトルセッションへの参加
- **問題を解く**: クラウドインフラ構築問題への挑戦
- **リーダーボード**: リアルタイムスコア表示
- **進捗トラッキング**: 自分の解答状況と得点の確認
- **観戦モード**: 他の参加者の進捗をリアルタイムで観戦（オプション）

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

# 開発サーバー起動 (ポート 3002)
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
participant-app/
├── app/              # Next.js App Router
│   ├── layout.tsx    # ルートレイアウト
│   ├── page.tsx      # ホームページ
│   └── globals.css   # グローバルスタイル
├── components/       # Reactコンポーネント（今後追加）
├── lib/              # ユーティリティ（今後追加）
└── public/           # 静的ファイル（今後追加）
```

## 認証

Participant UIは、Keycloak (OIDC) による認証を使用します。
競技者としてログインする必要があります。

## 関連ドキュメント

- [TenkaCloud CLAUDE.md](/CLAUDE.md)
- [Control Plane UI](/frontend/control-plane-app/README.md)
- [Admin UI](/frontend/admin-app/README.md)
