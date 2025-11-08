# TenkaCloud — The Open Cloud Battle Arena

## 🎯 プロジェクト概要

TenkaCloudは、クラウド技術者のための常設・オープンソースの競技プラットフォームです。AWS GameDay文化をルーツに、完全スクラッチで再構築されたOSS版クラウド天下一武道会のプラットフォームとして作っています。

## 🏯 コンセプト

世界中のクラウド戦士たちが集い、技を磨き、腕を競い、学び合う常設の天下一武道会。

### コアバリュー

- 🧱 完全OSS実装 — 社内資産を含まず、ゼロから再設計
- ☁️ マルチクラウド対応 — AWS / GCP / Azure / LocalStack / OCI
- 🏗 マルチテナントSaaS構造 — 常設・チーム対戦・観戦モード
- ⚔️ 問題互換設計 — 既存Cloud Contest問題を再利用可能
- 🧠 AI支援機能 — 問題生成・自動採点・コーチング（MCP/Claude Code対応）

## 🛠 技術スタック

### フロントエンド

- Next.js (App Router) - メインフレームワーク
- TypeScript - 型安全性の確保
- Tailwind CSS - スタイリング
- React - UI構築

### バックエンド

- AWS EKS - Kubernetesクラスター（参考: [AWS SaaS Factory EKS Reference Architecture](https://github.com/aws-samples/aws-saas-factory-eks-reference-architecture)）
- マルチテナントアーキテクチャ - テナント分離とリソース管理
- マイクロサービス - スケーラブルなサービス設計

### インフラストラクチャ

- Kubernetes - コンテナオーケストレーション
- Docker - コンテナ化
- Terraform - マルチクラウド対応

### AI/ML機能

- Claude API - AI支援機能
- MCP (Model Context Protocol) - AI統合
- 自動採点システム - インフラ構築の自動評価

## アーキテクチャ設計

### 参考アーキテクチャ

本プロジェクトは、[AWS SaaS Factory EKS Reference Architecture](https://github.com/aws-samples/aws-saas-factory-eks-reference-architecture)を参考に、以下の点を採用・拡張します：

1. マルチテナントSaaS構造
   - テナント分離戦略
   - リソースプール管理
   - テナントごとの独立した環境

2. Cloud Agnosticのマイクロサービス
   - Kubernetesネイティブな設計
   - スケーラブルなサービス構成
   - サービスメッシュ

3. セキュリティとアイデンティティ
   - テナントレベルのアクセス制御
   - セキュアなAPI設計

### TenkaCloud固有の拡張

1. マルチクラウド対応
   - AWS以外のクラウドプロバイダー（GCP、Azure、OCI）への対応
   - LocalStackによるローカル開発環境
   - クラウドプロバイダー間の抽象化レイヤー

2. 競技プラットフォーム機能
   - リアルタイムバトル管理
   - チーム対戦システム
   - 観戦モード（リアルタイム進捗表示）
   - リーダーボード

3. 問題管理システム
   - Cloud Contest問題形式との互換性
   - 問題テンプレートシステム
   - 動的問題生成（AI支援）

4. 自動採点・評価システム
   - インフラ構築の自動検証
   - コスト最適化スコアリング
   - セキュリティベストプラクティス評価
   - パフォーマンス評価

## 🏗 プロジェクト構造

```text
TenkaCloud/
├── frontend/              # Next.jsアプリケーション
│   ├── app/              # App Router
│   ├── components/       # Reactコンポーネント
│   ├── lib/              # ユーティリティ
│   └── styles/           # スタイル
├── backend/              # バックエンドサービス
│   ├── api/              # APIサービス
│   ├── auth/             # 認証サービス
│   ├── tenant/           # テナント管理
│   ├── battle/           # バトル管理
│   └── scoring/          # 採点システム
├── infrastructure/       # インフラストラクチャコード
│   ├── k8s/              # Kubernetesマニフェスト
│   └── terraform/        # Terraform（マルチクラウド用）
├── problems/             # 問題定義
│   ├── templates/        # 問題テンプレート
│   └── examples/         # サンプル問題
├── ai/                   # AI機能
│   ├── problem-generator/ # 問題生成
│   ├── scoring/          # 自動採点
│   └── coaching/         # コーチング機能
└── docs/                 # ドキュメント
```

## 🚀 主要機能

### 1. バトルアリーナ

- リアルタイムバトルセッション
- チーム対戦モード
- 観戦モード（リアルタイム進捗表示）
- バトル履歴とリプレイ

### 2. 問題管理

- 問題ライブラリ
- 問題作成・編集（AI支援）
- Open Cloud Contest形式と互換性
- カスタム問題作成

### 3. 自動採点システム

- インフラ構築の自動検証
- コスト最適化スコアリング
- セキュリティ評価
- パフォーマンス評価
- 詳細なフィードバック

### 4. AI支援機能

- 問題生成: AIによる問題自動生成
- 自動採点: インフラ構築の自動評価
- コーチング: リアルタイムヒントとアドバイス
- MCP/Claude Code統合: 開発者体験の向上

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

## セキュリティ設計

- テナント分離: 完全なリソース分離
- IAM統合: AWS IAMベースの認証・認可
- ネットワーク分離: VPC、セキュリティグループ
- データ暗号化: 転送時・保存時の暗号化
- 監査ログ: 全アクションの記録

## マルチクラウド対応戦略

1. 抽象化レイヤー
   - クラウドプロバイダー固有の実装を抽象化
   - 統一されたAPIインターフェース

2. プロバイダーアダプター
   - AWS Adapter
   - GCP Adapter
   - Azure Adapter
   - OCI Adapter
   - LocalStack Adapter（開発用）

3. リソースマッピング
   - 各クラウドプロバイダーのリソースを統一モデルにマッピング

## 🧪 開発環境

### ローカル開発
- LocalStackを使用したAWSエミュレーション
- Docker ComposeによるローカルKubernetes
- Next.js開発サーバー

### テスト環境
- EKSクラスター（開発用）
- CI/CDパイプライン
- 自動テストスイート

## 📝 開発ガイドライン

### コーディング規約
- TypeScript strict mode
- ESLint + Prettier
- コンポーネント駆動開発
- テスト駆動開発（TDD）

### Gitワークフロー
- 機能ブランチ戦略
- プルリクエストベースのレビュー
- セマンティックバージョニング

## 🎓 学習リソース

- [AWS SaaS Factory EKS Reference Architecture](https://github.com/aws-samples/aws-saas-factory-eks-reference-architecture)
- Kubernetes公式ドキュメント
- Next.js公式ドキュメント
- AWS CDK公式ドキュメント

## 🤝 コントリビューション

本プロジェクトは完全オープンソースです。コントリビューションを歓迎します。

1. Issueを作成して機能提案・バグ報告
2. Forkしてブランチを作成
3. 変更をコミット
4. プルリクエストを送信

## 📄 ライセンス

MIT License（予定）

## 🔮 ロードマップ

### Phase 1: 基盤構築
- [ ] Next.jsプロジェクトセットアップ
- [ ] AWS EKSクラスター構築
- [ ] 基本的なマルチテナント構造
- [ ] 認証・認可システム

### Phase 2: コア機能
- [ ] バトルアリーナ機能
- [ ] 問題管理システム
- [ ] 基本的な採点システム

### Phase 3: AI統合
- [ ] AI問題生成
- [ ] 自動採点システム
- [ ] コーチング機能

### Phase 4: マルチクラウド対応
- [ ] GCP対応
- [ ] Azure対応
- [ ] OCI対応
- [ ] LocalStack統合

### Phase 5: 高度な機能
- [ ] 観戦モード
- [ ] リーダーボード
- [ ] 統計・分析機能

## 📞 連絡先

- GitHub Issues: 機能提案・バグ報告
- Discussions: 技術的な議論

