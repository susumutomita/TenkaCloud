# TenkaCloud アクター定義

## 概要

TenkaCloud は Control Plane と Application Plane の 2 層構造を持つマルチテナント SaaS です。問題はマーケットプレイス型で提供され、問題作成者が公開した問題をテナントが利用します。

## アクター一覧

| 層 | アクター | 説明 |
|----|----------|------|
| Control Plane | Platform Admin | プラットフォーム全体の管理 |
| Control Plane | Problem Author | 問題の作成・公開 |
| Application Plane | Tenant Admin | テナント内のイベント・参加者管理 |
| Application Plane | Participant | 競技者 |

---

## Control Plane

### Platform Admin (プラットフォーム管理者)

TenkaCloud プラットフォーム全体を管理するスーパーユーザーです。

**できること**

- テナントを作成する
- テナントを停止・再開する
- テナントを削除する
- 全テナントの利用状況を確認する
- 課金プランを設定する
- マーケットプレイスの問題を審査・承認する

**利用画面**: `/control/*`

---

### Problem Author (問題作成者)

マーケットプレイスに問題を提供するコントリビューターです。

**できること**

- 問題を作成する
- 問題をマーケットプレイスに公開申請する
- 公開した問題の利用状況を確認する
- 問題を更新する
- 問題を非公開にする

**利用画面**: `/control/problems/*`

---

## Application Plane

### Tenant Admin (テナント管理者)

特定テナント内でイベント・参加者を管理する管理者です。

**できること**

- イベントを作成・編集・削除する
- イベントを公開・非公開にする
- イベントを開始・終了する
- マーケットプレイスから問題を検索・追加する
- イベント内の問題順序を設定する
- 参加者を招待・削除する
- 参加者のロールを変更する
- 参加者を BAN する
- チームを作成・編集・解散する
- リーダーボードを凍結・解除する
- スコアを手動調整する

**利用画面**

| パス | 用途 |
|------|------|
| `/admin` | 管理ダッシュボード |
| `/admin/events` | イベント一覧・作成 |
| `/admin/events/[eventId]` | イベント詳細・編集 |
| `/admin/marketplace` | 問題マーケットプレイス |
| `/admin/participants` | 参加者一覧・管理 |
| `/admin/teams` | チーム一覧・管理 |
| `/admin/settings` | テナント設定 |

---

### Participant (競技者)

イベントに参加してクラウド構築の課題に挑戦する競技者です。

**できること**

- 公開イベント一覧を見る
- イベントに登録・キャンセルする
- 問題一覧・詳細を見る
- 解答を提出する
- ヒントを購入する
- 自分のスコアを確認する
- チームに参加・脱退する
- リーダーボード・ランキングを見る
- プロフィールを編集する
- 参加履歴・バッジを見る

**利用画面**

| パス | 用途 |
|------|------|
| `/dashboard` | 参加中・登録済みイベント |
| `/events` | イベント一覧・検索 |
| `/events/[eventId]` | イベント詳細・問題一覧 |
| `/events/[eventId]/problems/[problemId]` | 問題詳細・解答提出 |
| `/events/[eventId]/leaderboard` | リーダーボード |
| `/rankings` | グローバルランキング |
| `/profile` | プロフィール編集 |
| `/profile/history` | 参加履歴 |
| `/profile/badges` | バッジ一覧 |

---

## 問題の流れ

```
Problem Author                 Platform Admin              Tenant Admin              Participant
     │                              │                           │                         │
     │  問題を作成                   │                           │                         │
     │──────────────────────────────>│                           │                         │
     │                              │                           │                         │
     │                    審査・承認  │                           │                         │
     │<─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│                           │                         │
     │                              │                           │                         │
     │          マーケットプレイスに公開                          │                         │
     │─────────────────────────────────────────────────────────>│                         │
     │                              │                           │                         │
     │                              │           問題を選択してイベントに追加               │
     │                              │                           │─────────────────────────>│
     │                              │                           │                         │
     │                              │                           │         問題に挑戦       │
     │                              │                           │<─────────────────────────│
```

---

## ロール定義

```typescript
// Control Plane のロール
export type PlatformRole = 'platform_admin' | 'problem_author';

// Application Plane のロール
export type ParticipantRole = 'participant' | 'admin';
```

---

## ルート構造

```
apps/control-plane/app/
├── dashboard/              # Platform Admin ダッシュボード
├── tenants/                # テナント管理
├── problems/               # Problem Author 用
│   ├── page.tsx            # 問題一覧
│   ├── new/                # 問題作成
│   └── [problemId]/        # 問題編集
└── marketplace/            # マーケットプレイス管理

apps/application-plane/app/
├── (admin)/admin/          # Tenant Admin 用
│   ├── page.tsx
│   ├── events/
│   ├── marketplace/        # 問題選択
│   ├── participants/
│   ├── teams/
│   └── settings/
│
├── dashboard/              # Participant 用
├── events/
├── rankings/
└── profile/
```

---

## 関連ドキュメント

- [アーキテクチャ設計](./architecture.md)
- [テナント管理統合](./tenant-management-integration.md)
