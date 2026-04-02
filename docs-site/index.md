---
layout: home

hero:
  name: TenkaCloud
  text: クラウド競技プラットフォーム
  tagline: Control Plane と Application Plane を分離した OSS 基盤
  actions:
    - theme: brand
      text: Quickstart
      link: /quickstart
    - theme: alt
      text: Architecture
      link: /guide/architecture

features:
  - icon: 🏢
    title: Control Plane
    details: テナント管理、設定、運用導線を担う共有領域。
  - icon: ⚔️
    title: Application Plane
    details: GameDay、Battle、問題、ランキングを担うテナント向け領域。
  - icon: 🔐
    title: Auth0 + Auth Skip
    details: 本番相当の Auth0 と、ローカル確認用の認証スキップを両立。
  - icon: 🧱
    title: Monorepo
    details: apps、backend/services、packages、problems を単一リポジトリで管理。
---

## Overview

TenkaCloud は、クラウド競技イベントを継続的に運営するための OSS プラットフォームです。

- `apps/control-plane`: プラットフォーム管理 UI
- `apps/application-plane`: テナント向け UI
- `backend/services/control-plane/*`: 共有管理サービス
- `backend/services/application-plane/*`: 競技サービス

詳細な手順は [Quickstart](/quickstart)、設計の正本は [Architecture](/guide/architecture) を参照してください。
