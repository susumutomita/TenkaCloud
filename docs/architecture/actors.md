# TenkaCloud アクター定義

## 概要

TenkaCloud は複数のアクター（利用者ロール）が存在するマルチテナント SaaS プラットフォームです。本ドキュメントでは各アクターの責務、権限、利用画面を定義します。

## アクター階層

```
┌─────────────────────────────────────────────────────────────┐
│                    Control Plane                            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │         Platform Admin (プラットフォーム管理者)        │   │
│  │         - テナント作成・管理                          │   │
│  │         - プラットフォーム全体の監視                   │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ テナント作成
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Application Plane                         │
│  ┌─────────────────────────────────────────────────────┐   │
│  │           Tenant Admin (テナント管理者)              │   │
│  │           - イベント作成・管理                        │   │
│  │           - 参加者・チーム管理                        │   │
│  │           - 問題設定・採点管理                        │   │
│  └─────────────────────────────────────────────────────┘   │
│                          │                                  │
│          ┌───────────────┼───────────────┐                 │
│          ▼               ▼               ▼                 │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐          │
│  │ Participant │ │  Spectator  │ │   Coach     │          │
│  │   (競技者)   │ │  (観戦者)   │ │ (コーチ)    │          │
│  └─────────────┘ └─────────────┘ └─────────────┘          │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. Platform Admin (プラットフォーム管理者)

### 概要

TenkaCloud プラットフォーム全体を管理するスーパーユーザー。Control Plane へのアクセス権を持つ。

### 責務

- テナントの作成・停止・削除
- プラットフォーム全体のモニタリング
- 課金・サブスクリプション管理
- システム設定・機能フラグ管理

### 権限

| リソース | 作成 | 読取 | 更新 | 削除 |
|----------|------|------|------|------|
| テナント | ✅ | ✅ | ✅ | ✅ |
| プラットフォーム設定 | ✅ | ✅ | ✅ | - |
| 監査ログ | - | ✅ | - | - |
| 課金情報 | - | ✅ | ✅ | - |

### 利用画面

| パス | 画面名 | 用途 |
|------|--------|------|
| `/control/dashboard` | 管理ダッシュボード | KPI・システム状態の概観 |
| `/control/tenants` | テナント管理 | テナント CRUD |
| `/control/billing` | 課金管理 | サブスクリプション・請求 |
| `/control/settings` | システム設定 | 機能フラグ・グローバル設定 |

### 認証

- Control Plane 専用の認証フロー
- MFA 必須
- IP アドレス制限推奨

---

## 2. Tenant Admin (テナント管理者)

### 概要

特定テナント内でイベント・参加者を管理する管理者。Application Plane の管理機能へアクセスする。

### 責務

- イベントの作成・編集・公開
- 問題（チャレンジ）の設定
- 参加者・チームの管理
- リーダーボード・採点の監視
- テナント内ユーザーへのロール付与

### 権限

| リソース | 作成 | 読取 | 更新 | 削除 |
|----------|------|------|------|------|
| イベント | ✅ | ✅ | ✅ | ✅ |
| 問題 | ✅ | ✅ | ✅ | ✅ |
| 参加者 | ✅ | ✅ | ✅ | ✅ |
| チーム | ✅ | ✅ | ✅ | ✅ |
| リーダーボード | - | ✅ | ✅ (凍結) | - |
| テナント設定 | - | ✅ | ✅ | - |

### 利用画面

| パス | 画面名 | 用途 |
|------|--------|------|
| `/admin` | 管理ダッシュボード | イベント状況・統計の概観 |
| `/admin/events` | イベント管理 | イベント CRUD |
| `/admin/events/[eventId]` | イベント詳細 | 個別イベントの設定・監視 |
| `/admin/participants` | 参加者管理 | 参加者の追加・ロール変更 |
| `/admin/teams` | チーム管理 | チーム編成・メンバー管理 |
| `/admin/settings` | テナント設定 | テナント固有の設定 |

### 認証

- テナント認証フロー（Auth0 / Cognito）
- `admin` ロールを持つユーザー

---

## 3. Participant (競技者)

### 概要

イベントに参加してクラウド構築の課題に挑戦する競技者。TenkaCloud のメインユーザー。

### 責務

- イベントへの登録
- 問題への挑戦・解答提出
- チームへの参加（チーム戦の場合）
- 自身のスコア・順位の確認

### 権限

| リソース | 作成 | 読取 | 更新 | 削除 |
|----------|------|------|------|------|
| イベント登録 | ✅ | ✅ (自分) | ✅ (キャンセル) | - |
| 解答提出 | ✅ | ✅ (自分) | - | - |
| チーム参加 | ✅ | ✅ (所属) | ✅ (脱退) | - |
| プロフィール | - | ✅ | ✅ | - |
| リーダーボード | - | ✅ | - | - |
| ヒント | ✅ (購入) | ✅ | - | - |

### 利用画面

| パス | 画面名 | 用途 |
|------|--------|------|
| `/dashboard` | 競技者ダッシュボード | 参加中イベント・登録済みイベントの一覧 |
| `/events` | イベント一覧 | 参加可能なイベントの検索・登録 |
| `/events/[eventId]` | イベント詳細 | イベント情報・問題一覧 |
| `/events/[eventId]/problems/[problemId]` | 問題詳細 | 課題の確認・解答提出 |
| `/events/[eventId]/leaderboard` | リーダーボード | 順位・スコアの確認 |
| `/rankings` | グローバルランキング | 全期間/月間/週間のランキング |
| `/profile` | プロフィール | 自己紹介・実績の編集 |
| `/profile/history` | 参加履歴 | 過去のイベント参加記録 |
| `/profile/badges` | バッジ | 獲得したバッジ・称号 |

### 認証

- テナント認証フロー
- `participant` ロールを持つユーザー（デフォルトロール）

---

## 4. Spectator (観戦者)

### 概要

競技には参加せず、リーダーボードや進捗を観戦するユーザー。企業の人事担当者や技術ブログライターなどを想定。

### 責務

- リーダーボードの閲覧
- イベント進捗の観戦
- 公開プロフィールの閲覧

### 権限

| リソース | 作成 | 読取 | 更新 | 削除 |
|----------|------|------|------|------|
| イベント | - | ✅ (公開) | - | - |
| リーダーボード | - | ✅ | - | - |
| 参加者プロフィール | - | ✅ (公開) | - | - |
| 問題 | - | ❌ | - | - |

### 利用画面

| パス | 画面名 | 用途 |
|------|--------|------|
| `/spectate` | 観戦ダッシュボード | 開催中イベントの一覧 |
| `/spectate/events/[eventId]` | 観戦画面 | リアルタイムリーダーボード |
| `/rankings` | グローバルランキング | 全体ランキングの閲覧 |

### 認証

- 認証なし（パブリック）または `spectator` ロール
- 一部機能は認証必須（お気に入り登録など）

### 実装状況

現在 Spectator 用の画面は実装されていません。

---

## 5. Coach (コーチ) - 将来拡張

### 概要

チームや個人の競技者を指導するコーチ。企業研修やトレーニングプログラムでの利用を想定。

### 責務

- 担当競技者/チームの進捗モニタリング
- ヒント・フィードバックの提供
- 学習レポートの確認

### 権限

| リソース | 作成 | 読取 | 更新 | 削除 |
|----------|------|------|------|------|
| 担当者の解答 | - | ✅ | - | - |
| 担当者のスコア | - | ✅ | - | - |
| フィードバック | ✅ | ✅ | ✅ | ✅ |
| 学習レポート | - | ✅ | - | - |

### 実装状況

Coach ロールは将来の拡張として検討中です。

---

## ロール定義（技術仕様）

### ParticipantRole 型

```typescript
// apps/application-plane/lib/api/admin-types.ts
export type ParticipantRole = 'participant' | 'admin' | 'spectator';
```

### 将来の拡張

```typescript
// 提案: 拡張ロール
export type ParticipantRole =
  | 'participant'   // 競技者
  | 'admin'         // テナント管理者
  | 'spectator'     // 観戦者
  | 'coach'         // コーチ（将来）
  | 'judge';        // 審判（将来）
```

---

## ルーティング設計

### Application Plane ルート構造

```
apps/application-plane/app/
├── (admin)/                    # Tenant Admin グループ
│   └── admin/
│       ├── page.tsx            # /admin - 管理ダッシュボード
│       ├── events/
│       │   ├── page.tsx        # /admin/events
│       │   └── [eventId]/
│       │       └── page.tsx    # /admin/events/[eventId]
│       ├── participants/
│       │   └── page.tsx        # /admin/participants
│       ├── teams/
│       │   └── page.tsx        # /admin/teams
│       └── settings/
│           └── page.tsx        # /admin/settings
│
├── (participant)/              # Participant グループ（将来の Route Group 化）
│   ├── dashboard/
│   │   └── page.tsx            # /dashboard
│   ├── events/
│   │   ├── page.tsx            # /events
│   │   └── [eventId]/
│   │       ├── page.tsx        # /events/[eventId]
│   │       ├── leaderboard/
│   │       │   └── page.tsx    # /events/[eventId]/leaderboard
│   │       └── problems/
│   │           └── [problemId]/
│   │               └── page.tsx
│   ├── rankings/
│   │   └── page.tsx            # /rankings
│   └── profile/
│       ├── page.tsx            # /profile
│       ├── history/
│       │   └── page.tsx        # /profile/history
│       └── badges/
│           └── page.tsx        # /profile/badges
│
└── (spectator)/                # Spectator グループ（将来実装）
    └── spectate/
        ├── page.tsx            # /spectate
        └── events/
            └── [eventId]/
                └── page.tsx    # /spectate/events/[eventId]
```

---

## 認証・認可フロー

### ミドルウェアでのロールチェック

```typescript
// apps/application-plane/middleware.ts
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Admin routes require admin role
  if (pathname.startsWith('/admin')) {
    // Check for admin role in session
  }

  // Participant routes require authentication
  if (pathname.startsWith('/dashboard') ||
      pathname.startsWith('/events') ||
      pathname.startsWith('/profile')) {
    // Check for authenticated user
  }

  // Spectate routes are public or require spectator role
  if (pathname.startsWith('/spectate')) {
    // Allow public access or check spectator role
  }
}
```

---

## 関連ドキュメント

- [アーキテクチャ設計](./architecture.md) - システム全体の設計
- [テナント管理統合](./tenant-management-integration.md) - マルチテナント実装
- [認証・認可設計](./architecture.md#9-認証認可設計) - 認証システムの詳細

---

## 変更履歴

| 日付 | バージョン | 変更内容 |
|------|------------|----------|
| 2025-01-09 | 1.0 | 初版作成 |
