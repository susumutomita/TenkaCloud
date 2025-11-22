# TenkaCloud Shared Components

共通コンポーネントライブラリです。

## 概要

`@tenkacloud/shared` は、TenkaCloud のすべてのフロントエンドアプリケーション（Control Plane UI / Admin UI / Participant UI）で共有されるコンポーネント、ユーティリティ、型定義を提供します。

## 使用方法

各アプリケーションから次のようにインポートします。

```typescript
import { Button, Card } from "@tenkacloud/shared";
```

## ディレクトリ構造

```
shared/
├── src/
│   ├── components/    # 共通 UI コンポーネント（今後追加）
│   ├── hooks/         # カスタムフック（今後追加）
│   ├── utils/         # ユーティリティ関数（今後追加）
│   ├── types/         # 共通型定義（今後追加）
│   └── index.ts       # エクスポート（今後追加）
└── package.json
```

## 開発

```bash
# 依存関係のインストール
npm install

# 型チェック
npm run typecheck

# Lint
npm run lint

# テスト
npm run test

# テストカバレッジ
npm run test:coverage
```

## 追加予定の機能

- **UI コンポーネント**: Button, Card, Modal, Table など
- **フォームコンポーネント**: Input, Select, Checkbox など
- **ユーティリティ**: 日付フォーマット、バリデーション関数
- **カスタムフック**: useAuth, useTenant など
- **型定義**: Tenant, Battle, Problem など

## 関連ドキュメント

- [TenkaCloud CLAUDE.md](/CLAUDE.md)
