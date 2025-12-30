# TenkaCloud — The Open Cloud Battle Arena

[![CI](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml/badge.svg)](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> [English](./README.en.md) | 日本語

## 🎯 プロジェクト概要

TenkaCloud は、クラウド技術者のための常設・オープンソースの競技プラットフォームです。AWS GameDay 文化をルーツに、完全スクラッチで再構築された OSS 版クラウド天下一武道会のプラットフォームとして作っています。

## 🏯 コンセプト

世界中のクラウド戦士たちが集い、技を磨き、腕を競い、学び合う常設の天下一武道会。

### コアバリュー

- 🧱 **完全 OSS 実装** — 社内資産を含まず、ゼロから再設計
- ☁️ **マルチクラウド対応** — AWS / GCP / Azure / LocalStack / OCI
- 🏗 **マルチテナント SaaS 構造** — 常設・チーム対戦・観戦モード
- ⚔️ **問題互換設計** — 既存 Cloud Contest 問題を再利用可能
- 🧠 **AI 支援機能** — 問題生成・自動採点・コーチング（MCP/Claude Code 対応）

## 🚀 クイックスタート

### 1分で起動

```bash
# Docker Desktop を起動してから実行
make start
```

これで以下が自動的に起動します。

- LocalStack（AWS ローカルエミュレーター）
- DynamoDB（テナント・設定データ）
- Tenant Management API（バックエンド）
- Control Plane UI（フロントエンド）
- Application Plane UI（フロントエンド）

> **Note:** 認証には Auth0 を使用します。Makefile からセットアップできます:
>
> ```bash
> # 1. terraform.tfvars を作成して Auth0 Management API の認証情報を設定
> cp infrastructure/terraform/environments/dev/terraform.tfvars.example \
>    infrastructure/terraform/environments/dev/terraform.tfvars
> # terraform.tfvars を編集して認証情報を入力
>
> # 2. Auth0 をセットアップ（init + apply + 認証情報表示）
> make auth0-setup
>
> # 3. 表示された認証情報を .env.local にコピー
> ```

ブラウザで以下にアクセスしてください。

- Control Plane: <http://localhost:13000>
- Application Plane: <http://localhost:13001>

### 詳細な手順

詳しいセットアップ手順は [Quick Start Guide](docs/QUICKSTART.md) を参照してください。

## 📦 主な Makefile コマンド

```bash
# ローカル環境管理
make start            # ローカル環境を一括起動（推奨）
make stop             # ローカル環境を一括停止
make restart          # ローカル環境を再起動

# コード品質
make lint             # Linter を実行
make format           # コードを自動整形
make typecheck        # TypeScript 型チェック
make before-commit    # コミット前チェック（lint, format, typecheck, test, build）

# テスト
make test             # テストを実行
make test-coverage    # カバレッジレポート付きテスト（99% 以上必須）

# インフラ
make localstack-up    # LocalStack を起動
make localstack-down  # LocalStack を停止

# Auth0 セットアップ
make auth0-setup      # Auth0 を Terraform でセットアップ
make auth0-output     # 認証情報を表示
```

詳細は `make help` を実行してください。

## 🚀 主要機能

### 1. バトルアリーナ

- リアルタイムバトルセッション
- チーム対戦モード
- 観戦モード（リアルタイム進捗表示）
- バトル履歴とリプレイ

### 2. 問題管理

- 問題ライブラリ
- 問題作成・編集（AI 支援）
- Open Cloud Contest 形式と互換性
- カスタム問題作成

### 3. 自動採点システム

- インフラ構築の自動検証
- コスト最適化スコアリング
- セキュリティ評価
- パフォーマンス評価
- 詳細なフィードバック

### 4. AI 支援機能

- **問題生成**: AI による問題自動生成
- **自動採点**: インフラ構築の自動評価
- **コーチング**: リアルタイムヒントとアドバイス
- **MCP/Claude Code 統合**: 開発者体験の向上

### 5. マルチテナント管理

- テナント登録・管理
- リソース分離
- 使用量追跡
- 課金管理（将来実装）

### 6. リーダーボード

- グローバルランキング
- カテゴリ別ランキング
- チームランキング
- 統計情報

## 🛠 技術スタック

### フロントエンド

- **Next.js** (App Router) - メインフレームワーク
- **TypeScript** - 型安全性の確保
- **Tailwind CSS** - スタイリング
- **React** - UI 構築

### バックエンド

- **AWS EKS** - Kubernetes クラスター
- **マルチテナントアーキテクチャ** - テナント分離とリソース管理
- **マイクロサービス** - スケーラブルなサービス設計

### インフラストラクチャ

- **Kubernetes** - コンテナオーケストレーション
- **Docker** - コンテナ化
- **Terraform** - マルチクラウド対応

### AI/機械学習

- **Claude API** - AI 支援機能
- **MCP (Model Context Protocol)** - AI 統合
- **自動採点システム** - インフラ構築の自動評価

## 🏗 プロジェクト構造

```text
TenkaCloud/
├── apps/                         # フロントエンドアプリケーション
│   ├── control-plane/            # 管理者向け UI（Next.js 16）
│   │   ├── app/                  # App Router
│   │   ├── components/           # React コンポーネント
│   │   └── lib/                  # API クライアント・ユーティリティ
│   └── application-plane/        # 競技者向け UI（Next.js 16）
│       ├── app/                  # App Router
│       └── lib/                  # AWS STS フェデレーション等
├── backend/                      # バックエンドサービス
│   └── services/
│       ├── control-plane/        # Control Plane サービス
│       │   └── tenant-management/  # テナント管理 API（Hono + DynamoDB）
│       ├── application-plane/    # Application Plane サービス
│       └── shared/               # 共有ライブラリ
├── packages/                     # 共有パッケージ
│   ├── core/                     # コアロジック
│   └── shared/                   # 共有型定義・DynamoDB リポジトリ
├── infrastructure/               # インフラストラクチャコード
│   └── terraform/                # Terraform（AWS CDK 移行予定）
├── docker-compose.yml            # ローカル開発用 Docker Compose
├── problems/                     # 問題定義
│   ├── templates/                # 問題テンプレート
│   └── examples/                 # サンプル問題
├── reference/                    # 参考資料
│   └── eks/                      # EKS Reference Architecture
├── scripts/                      # ユーティリティスクリプト
└── docs/                         # ドキュメント
```

## 🚦 開発環境のセットアップ

### 必要要件

- Node.js 18+
- Bun（推奨）または npm
- Docker & Docker Compose
- kubectl
- Terraform（オプション）

### ローカル開発

```bash
# リポジトリのクローン
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud

# 依存関係のインストール（ni は lock ファイルから自動でパッケージマネージャを選択）
ni
# または
bun install

# ローカル環境を一括起動
make start
```

### テスト実行

```bash
# テストの実行
bun run test

# カバレッジ付きテスト
bun run test:coverage

# Linter の実行
bun run lint
make lint_text

# フォーマットチェック
make format_check
```

## 📖 ドキュメント

- [開発ガイド](./CLAUDE.md) - Claude Code/AI エージェント向け開発プレイブック
- [アーキテクチャ設計](./docs/architecture.md)（予定）
- [API ドキュメント](./docs/api.md)（予定）

## 🤝 コントリビューション

本プロジェクトは完全オープンソースです。コントリビューションを歓迎します。

1. Issue を作成して機能提案・バグ報告
2. Fork してブランチを作成
3. 変更をコミット
4. プルリクエストを送信

### コーディング規約

- TypeScript strict mode
- ESLint + Prettier
- コンポーネント駆動開発
- テスト駆動開発（TDD）

## 📄 ライセンス

MIT License（予定）

## 🔮 ロードマップ

### Phase 1: 基盤構築

- [ ] Next.js プロジェクトセットアップ
- [ ] AWS EKS クラスター構築
- [ ] 基本的なマルチテナント構造
- [ ] 認証・認可システム

### Phase 2: コア機能

- [ ] バトルアリーナ機能
- [ ] 問題管理システム
- [ ] 基本的な採点システム

### Phase 3: AI 統合

- [ ] AI 問題生成
- [ ] 自動採点システム
- [ ] コーチング機能

### Phase 4: マルチクラウド対応

- [ ] GCP 対応
- [ ] Azure 対応
- [ ] OCI 対応
- [ ] LocalStack 統合

### Phase 5: 高度な機能

- [ ] 観戦モード
- [ ] リーダーボード
- [ ] 統計・分析機能

## 🎓 参考リソース

- [AWS SaaS Factory EKS Reference Architecture](https://github.com/aws-samples/aws-saas-factory-eks-reference-architecture)
- [Kubernetes 公式ドキュメント](https://kubernetes.io/docs/)
- [Next.js 公式ドキュメント](https://nextjs.org/docs)
