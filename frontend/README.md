# TenkaCloud Frontend

TenkaCloudのフロントエンドは、3層のUIアーキテクチャで構成されています。

## アーキテクチャ

### 3層UI構造

1. **Control Plane UI** (`control-plane/`)
   - プラットフォーム管理者用
   - 全テナント管理、システム監視
   - ポート: 3000

2. **Admin UI** (`admin-app/`)
   - テナント管理者用
   - バトル管理、問題管理、チーム管理
   - ポート: 3001

3. **Participant UI** (`participant-app/`)
   - 競技者用
   - バトル参加、問題を解く、リーダーボード
   - ポート: 3002

4. **Shared Library** (`shared/`)
   - 共通コンポーネント、型定義、ユーティリティ

## 技術スタック

- **フレームワーク**: Next.js 16 (App Router)
- **言語**: TypeScript (strict mode)
- **スタイリング**: Tailwind CSS 4
- **Linter/Formatter**: Biome
- **テスト**: Vitest + React Testing Library
- **モノレポ**: npm workspaces

## 開発

### すべてのアプリを個別に起動

```bash
# Control Plane UI (ポート 3000)
npm run dev:control-plane

# Admin UI (ポート 3001)
npm run dev:admin

# Participant UI (ポート 3002)
npm run dev:participant
```

### ビルド・テスト（全アプリ）

```bash
# すべてのフロントエンドアプリをビルド
npm run build:frontend

# すべてのフロントエンドアプリをテスト
npm run test:frontend

# 型チェック
npm run typecheck:frontend

# Lint
npm run lint:frontend
```

### 個別のアプリで作業

```bash
# Control Plane UI
cd frontend/control-plane
npm install
npm run dev

# Admin UI
cd frontend/admin-app
npm install
npm run dev

# Participant UI
cd frontend/participant-app
npm install
npm run dev

# Shared Library
cd frontend/shared
npm install
npm run test
```

## ディレクトリ構造

```
frontend/
├── control-plane/       # Control Plane UI (既存)
├── control-plane-app/   # Control Plane UI (リネーム後、Issue 8で対応)
├── admin-app/           # Admin UI (新規作成)
├── participant-app/     # Participant UI (新規作成)
├── shared/              # 共通ライブラリ (新規作成)
│   └── src/
│       ├── components/  # 共通UIコンポーネント
│       ├── types/       # 共通型定義
│       └── index.ts     # エクスポート
└── README.md            # このファイル
```

## 認証

すべてのUIアプリは、Keycloak (OIDC) による認証を使用します。
ロールベースのアクセス制御により、各UIへのアクセスを制限します：

- **platform-admin**: Control Plane UIへアクセス可能
- **tenant-admin**: Admin UIへアクセス可能
- **user**: Participant UIへアクセス可能

## 関連ドキュメント

- [Control Plane UI](./control-plane/README.md)
- [Admin UI](./admin-app/README.md)
- [Participant UI](./participant-app/README.md)
- [Shared Library](./shared/README.md)
- [TenkaCloud CLAUDE.md](../CLAUDE.md)
