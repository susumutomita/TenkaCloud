# テナントプラン切り替え機能 & 管理画面導線設計

## 概要

テナントのプラン（Tier）切り替え機能と、各テナント専用の Application Plane への導線を設計する。

## 現状分析

### 既存の Tier 定義

```typescript
type TenantTier = 'FREE' | 'PRO' | 'ENTERPRISE';
```

現状の問題点を以下に示す。
- Tier は単なるラベルで、機能制限や料金体系が未定義
- テナント詳細画面から Application Plane への導線がない
- プラン変更は編集画面の select ボックスのみ（確認フローなし）

## 設計

### 1. Tier 定義の拡張

```typescript
// types/tenant.ts に追加
export interface TierFeatures {
  maxParticipants: number;      // 最大参加者数
  maxBattles: number;           // 月間最大バトル数
  maxProblems: number;          // 最大問題数
  customBranding: boolean;      // カスタムブランディング
  apiAccess: boolean;           // API アクセス
  ssoEnabled: boolean;          // SSO 対応
  supportLevel: 'community' | 'email' | 'priority';
  isolationModel: IsolationModel;  // POOL or SILO
}

export const TIER_FEATURES: Record<TenantTier, TierFeatures> = {
  FREE: {
    maxParticipants: 10,
    maxBattles: 5,
    maxProblems: 20,
    customBranding: false,
    apiAccess: false,
    ssoEnabled: false,
    supportLevel: 'community',
    isolationModel: 'POOL',
  },
  PRO: {
    maxParticipants: 100,
    maxBattles: 50,
    maxProblems: 200,
    customBranding: true,
    apiAccess: true,
    ssoEnabled: false,
    supportLevel: 'email',
    isolationModel: 'POOL',
  },
  ENTERPRISE: {
    maxParticipants: -1,  // 無制限
    maxBattles: -1,
    maxProblems: -1,
    customBranding: true,
    apiAccess: true,
    ssoEnabled: true,
    supportLevel: 'priority',
    isolationModel: 'SILO',
  },
};
```

### 2. プラン切り替え UI コンポーネント

#### 2.1 PlanCard コンポーネント

場所: `components/tenants/plan-card.tsx`

```
┌─────────────────────────────────────────────────────────────┐
│ プラン                                                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  現在のプラン: [PRO]                                        │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │    FREE     │  │  ★ PRO ★   │  │ ENTERPRISE  │         │
│  │             │  │  (現在)     │  │             │         │
│  │  ¥0/月     │  │  ¥9,800/月 │  │  お問合せ   │         │
│  │             │  │             │  │             │         │
│  │ 10名まで    │  │ 100名まで   │  │ 無制限      │         │
│  │ 5バトル/月  │  │ 50バトル/月 │  │ 無制限      │         │
│  │             │  │             │  │ SSO対応     │         │
│  │             │  │ API対応     │  │ 専用環境    │         │
│  │             │  │             │  │             │         │
│  │ [ダウン     │  │  現在の     │  │ [アップ    │         │
│  │  グレード]  │  │  プラン     │  │  グレード]  │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### 2.2 プラン変更確認ダイアログ

```
┌─────────────────────────────────────────────────────────────┐
│ プランを変更しますか？                              [×]     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  PRO → ENTERPRISE にアップグレード                          │
│                                                             │
│  変更内容:                                                  │
│  ✓ 参加者数: 100名 → 無制限                                │
│  ✓ バトル数: 50/月 → 無制限                                │
│  ✓ SSO: 無効 → 有効                                        │
│  ✓ 分離モデル: POOL → SILO                                 │
│                                                             │
│  ⚠️ 分離モデルが変更されるため、再プロビジョニングが       │
│     必要です。一時的にサービスが停止します。               │
│                                                             │
│              [キャンセル]  [変更を確定]                      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 3. テナント Application Plane への導線

#### 3.1 テナント詳細画面の拡張

テナント詳細画面 (`/dashboard/tenants/[id]`) に「管理画面を開く」ボタンを追加。

```
┌─────────────────────────────────────────────────────────────┐
│ ← 戻る            Acme Corporation                         │
│                   ID: 01HJXK5K3VDXK5YPNZBKRT5ABC           │
│                                              [削除] [編集]  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ テナント管理画面                                     │   │
│  │                                                      │   │
│  │ このテナントの Application Plane にアクセスします   │   │
│  │                                                      │   │
│  │ URL: https://acme.tenka.cloud                       │   │
│  │                                                      │   │
│  │     [管理画面を開く →]  [URLをコピー]               │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  基本情報                        プロビジョニング           │
│  ┌────────────────────────┐     ┌────────────────────────┐ │
│  │ ステータス: ACTIVE     │     │ ステータス: COMPLETED  │ │
│  │ Tier: PRO              │     │ リージョン: ap-north.. │ │
│  │ ...                    │     │ ...                    │ │
│  └────────────────────────┘     └────────────────────────┘ │
│                                                             │
│  プラン                                                     │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ (PlanCard コンポーネント)                            │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### 3.2 テナント一覧での導線

テナント一覧テーブルのアクション列に「開く」ボタンを追加。

```
| テナント名    | Slug       | Tier  | Status | Actions              |
|--------------|------------|-------|--------|----------------------|
| Acme Corp    | acme       | PRO   | ACTIVE | [開く] [詳細] [削除] |
| Beta Inc     | beta       | FREE  | ACTIVE | [開く] [詳細] [削除] |
```

### 4. URL 設計

```
Control Plane (管理者向け):
  /dashboard/tenants                    # テナント一覧
  /dashboard/tenants/new                # 新規作成
  /dashboard/tenants/[id]               # テナント詳細
  /dashboard/tenants/[id]/edit          # テナント編集
  /dashboard/tenants/[id]/plan          # プラン変更 (新規)

Application Plane (テナント向け):
  https://{slug}.tenka.cloud/           # テナント専用サブドメイン
  または
  https://app.tenka.cloud/{slug}/       # パスベース (開発環境)
```

### 5. API エンドポイント

```typescript
// 既存
PATCH /api/tenants/:id          # tier フィールドで更新可能

// 新規追加
POST  /api/tenants/:id/upgrade  # プランアップグレード
POST  /api/tenants/:id/downgrade # プランダウングレード

// レスポンス
{
  success: boolean;
  tenant: Tenant;
  requiresReprovisioning: boolean;  // POOL → SILO 変更時
  message: string;
}
```

### 6. 実装フェーズ

#### Phase 1: Tier 定義拡張 (1-2日)
- [ ] `types/tenant.ts` に `TierFeatures` 追加
- [ ] `TIER_FEATURES` 定数追加
- [ ] テスト追加

#### Phase 2: PlanCard コンポーネント (2-3日)
- [ ] `components/tenants/plan-card.tsx` 作成
- [ ] プラン比較 UI
- [ ] 変更確認ダイアログ
- [ ] テナント詳細画面に統合
- [ ] テスト追加

#### Phase 3: テナント管理画面導線 (1-2日)
- [ ] `TenantAccessCard` コンポーネント作成
- [ ] テナント詳細画面に統合
- [ ] テナント一覧に「開く」ボタン追加
- [ ] テスト追加

#### Phase 4: プラン変更 API (2-3日)
- [ ] `upgrade`/`downgrade` エンドポイント追加
- [ ] 再プロビジョニングトリガーロジック
- [ ] テスト追加

## 考慮事項

### セキュリティ
- プラン変更は管理者権限が必要
- ダウングレード時の機能制限警告

### UX
- プラン変更後の自動リフレッシュ
- 再プロビジョニング中の進捗表示
- エラー時のロールバック対応

### 課金連携 (将来)
- Stripe 等の決済連携
- 従量課金対応
