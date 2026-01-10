---
layout: home

hero:
  name: TenkaCloud
  text: クラウド天下一武道会
  tagline: クラウド技術者のための OSS 競技プラットフォーム
  actions:
    - theme: brand
      text: クイックスタート
      link: /quickstart
    - theme: alt
      text: GitHub
      link: https://github.com/susumutomita/TenkaCloud

features:
  - icon: 🌐
    title: マルチクラウド対応
    details: AWS / GCP / Azure / LocalStack / OCI に対応。クラウドを問わず技術力を競える。
  - icon: 🏢
    title: マルチテナント SaaS
    details: EKS Reference Architecture をベースに設計された、本格的なマルチテナントアーキテクチャ。
  - icon: 🤖
    title: AI 支援
    details: MCP/Claude Code 統合による問題生成・自動採点・コーチング機能。
  - icon: 🔓
    title: 完全 OSS
    details: 社内資産を含まず、ゼロから設計。誰でも自由に利用・貢献可能。
---

## TenkaCloud とは

TenkaCloud は、AWS GameDay 文化をルーツに、完全スクラッチで再構築された常設のクラウド競技プラットフォームです。

### 主な機能

- **バトルモード**: リアルタイムでクラウドインフラ構築を競う
- **問題管理**: AI による問題自動生成と難易度調整
- **チーム戦**: 複数人でのコラボレーション対応
- **リーダーボード**: リアルタイムスコアリング

### アーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│                     Control Plane                           │
│  (テナント管理・認証・課金)                                 │
├─────────────────────────────────────────────────────────────┤
│                    Application Plane                        │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐        │
│  │ Battle  │  │ Problem │  │ Scoring │  │  User   │        │
│  │ Service │  │ Service │  │ Service │  │ Service │        │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘        │
└─────────────────────────────────────────────────────────────┘
```

## クイックスタート

```bash
# クローン
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud

# 依存関係インストール
bun install

# 起動
make start
```

詳細は [クイックスタートガイド](/quickstart) を参照してください。
