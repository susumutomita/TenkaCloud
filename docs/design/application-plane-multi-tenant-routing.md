# Application Plane マルチテナントルーティング設計書

## Overview

Application Plane にマルチテナントルーティングと管理者機能を実装する。

**要件:**
- テナント識別（本番: サブドメイン、開発: クエリパラメータ）
- Admin/Participant のルート分離
- Auth0 Organization 連携（FREE/PRO: 共有、ENTERPRISE: 専用）
- Challenge AWS デプロイ機能

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                 Application Plane                           │
├─────────────────────────────────────────────────────────────┤
│  middleware.ts                                              │
│  ├── テナント識別（subdomain / ?tenant=）                   │
│  ├── 認証チェック（NextAuth.js + Auth0）                    │
│  └── ロールベースルーティング（admin / participant）        │
├─────────────────────────────────────────────────────────────┤
│  Routes                                                     │
│  ├── (participant)/ → 参加者 UI（既存）                     │
│  │   ├── dashboard/                                         │
│  │   └── events/[eventId]/challenges/[challengeId]/         │
│  └── (admin)/ → 管理者 UI（新規）                           │
│      └── admin/                                             │
│          ├── events/ (CRUD)                                 │
│          ├── participants/                                  │
│          ├── teams/                                         │
│          ├── challenges/                                    │
│          ├── deploy/ → AWS Challenge デプロイ               │
│          └── settings/                                      │
└─────────────────────────────────────────────────────────────┘
```

## Auth0 Organization 構造

| Tier | Organization | 識別方法 |
|------|-------------|----------|
| FREE/PRO | 共有 `tenkacloud-shared` | JWT `tenant_id` クレーム |
| ENTERPRISE | 専用 `org-{slug}` | Organization 単位 |

### Auth0 Action による Role 注入

```typescript
// Auth0 Post Login Action
exports.onExecutePostLogin = async (event, api) => {
  const namespace = 'https://tenkacloud.com';
  const org = event.organization;
  const tenantId = org?.metadata?.tenant_id;
  const tier = org?.metadata?.tier;
  const roles = event.authorization?.roles || [];

  api.idToken.setCustomClaim(`${namespace}/roles`, roles);
  api.idToken.setCustomClaim(`${namespace}/tenant_id`, tenantId);
  api.idToken.setCustomClaim(`${namespace}/tier`, tier);
  api.accessToken.setCustomClaim(`${namespace}/roles`, roles);
  api.accessToken.setCustomClaim(`${namespace}/tenant_id`, tenantId);
};
```

## Implementation Phases

### Phase 1: Middleware & Tenant Context（優先）

**新規作成:**
- `apps/application-plane/middleware.ts`
- `apps/application-plane/lib/tenant/identification.ts`
- `apps/application-plane/lib/tenant/context.tsx`

**修正:**
- `apps/application-plane/lib/api/client.ts` - `getAuthToken()` 実装
- `apps/application-plane/components/layout/header.tsx` - セッション反映

### Phase 2: Admin ルート基盤

**新規作成:**
```
apps/application-plane/app/(admin)/
├── admin/
│   ├── page.tsx              # ダッシュボード
│   ├── layout.tsx            # サイドバー付きレイアウト
│   ├── events/
│   │   ├── page.tsx
│   │   └── [eventId]/page.tsx
│   ├── participants/page.tsx
│   ├── teams/page.tsx
│   └── settings/page.tsx
```

### Phase 3: Admin API ルート

**新規作成:**
```
apps/application-plane/app/api/admin/
├── events/route.ts
├── participants/route.ts
├── teams/route.ts
├── challenges/route.ts
└── deploy/route.ts
```

### Phase 4: Challenge AWS デプロイ

- AWS STS AssumeRole でテナント AWS アカウントへアクセス
- CloudFormation/CDK によるリソースデプロイ
- デプロイジョブ管理と進捗表示

## Critical Files

| File | Action | Priority |
|------|--------|----------|
| `apps/application-plane/middleware.ts` | New | P0 |
| `apps/application-plane/lib/tenant/identification.ts` | New | P0 |
| `apps/application-plane/lib/tenant/context.tsx` | New | P0 |
| `apps/application-plane/lib/api/client.ts` | Fix getAuthToken() | P0 |
| `apps/application-plane/components/layout/header.tsx` | Fix hardcoded user | P1 |
| `apps/application-plane/app/(admin)/admin/layout.tsx` | New | P1 |
| `apps/application-plane/app/(admin)/admin/page.tsx` | New | P1 |
| `apps/application-plane/app/api/admin/events/route.ts` | New | P2 |
| `apps/application-plane/app/api/admin/deploy/route.ts` | New | P3 |

## Middleware 実装設計

```typescript
import { type NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';

const authSkipEnabled = process.env.AUTH_SKIP === '1';
const PUBLIC_ROUTES = ['/login', '/api/auth'];
const ADMIN_ROUTES = ['/admin'];

function getTenantSlug(req: NextRequest): string | null {
  const host = req.headers.get('host') || '';
  const subdomain = host.split('.')[0];

  // 1. サブドメイン（本番）: acme.tenka.cloud → "acme"
  if (subdomain && subdomain !== 'localhost' && subdomain !== 'app') {
    return subdomain;
  }

  // 2. クエリパラメータ（開発）: ?tenant=acme → "acme"
  const tenantParam = req.nextUrl.searchParams.get('tenant');
  if (tenantParam) {
    return tenantParam;
  }

  return null;
}

function handleAuth(
  isLoggedIn: boolean,
  roles: string[],
  sessionTenantId: string | null,
  urlTenantSlug: string | null,
  req: NextRequest
): NextResponse {
  const { pathname } = req.nextUrl;

  // 公開ルート
  if (PUBLIC_ROUTES.some(r => pathname.startsWith(r))) {
    if (isLoggedIn && pathname.startsWith('/login')) {
      return NextResponse.redirect(new URL('/dashboard', req.nextUrl.origin));
    }
    return NextResponse.next();
  }

  // 未認証 → /login
  if (!isLoggedIn) {
    const loginUrl = new URL('/login', req.nextUrl.origin);
    loginUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // /admin/* + !admin → /dashboard
  if (ADMIN_ROUTES.some(r => pathname.startsWith(r))) {
    if (!roles.includes('admin')) {
      return NextResponse.redirect(new URL('/dashboard', req.nextUrl.origin));
    }
  }

  // テナント不一致 → 自テナントへリダイレクト
  if (urlTenantSlug && sessionTenantId && urlTenantSlug !== sessionTenantId) {
    const correctUrl = new URL(pathname, req.nextUrl.origin);
    correctUrl.searchParams.set('tenant', sessionTenantId);
    return NextResponse.redirect(correctUrl);
  }

  const response = NextResponse.next();
  if (urlTenantSlug || sessionTenantId) {
    response.headers.set('x-tenant-id', urlTenantSlug || sessionTenantId || '');
  }
  return response;
}

export const middleware = authSkipEnabled
  ? (req: NextRequest) =>
      handleAuth(true, ['participant', 'admin'], 'dev-tenant', getTenantSlug(req), req)
  : auth((req) =>
      handleAuth(
        !!req.auth,
        (req.auth?.roles as string[]) || [],
        req.auth?.tenantId as string | null,
        getTenantSlug(req as NextRequest),
        req as NextRequest
      )
    );

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
```

## Tenant Identification Utility

```typescript
// lib/tenant/identification.ts
import type { NextRequest } from 'next/server';

export interface TenantIdentificationResult {
  tenantSlug: string | null;
  source: 'subdomain' | 'query' | 'session' | 'none';
}

export function identifyTenant(req: NextRequest): TenantIdentificationResult {
  const host = req.headers.get('host') || '';
  const hostParts = host.split('.');

  // 1. サブドメイン
  if (hostParts.length >= 3) {
    const subdomain = hostParts[0];
    if (subdomain !== 'www' && subdomain !== 'app') {
      return { tenantSlug: subdomain, source: 'subdomain' };
    }
  }

  // 2. クエリパラメータ
  const tenantParam = req.nextUrl.searchParams.get('tenant');
  if (tenantParam) {
    return { tenantSlug: tenantParam, source: 'query' };
  }

  return { tenantSlug: null, source: 'none' };
}

export function getTenantAppUrl(tenantSlug: string, path: string = ''): string {
  const isProduction = process.env.NODE_ENV === 'production';
  const baseDomain = process.env.NEXT_PUBLIC_APP_DOMAIN || 'tenka.cloud';

  if (isProduction) {
    return `https://${tenantSlug}.${baseDomain}${path}`;
  }

  const devPort = process.env.NEXT_PUBLIC_APP_PORT || '13001';
  return `http://localhost:${devPort}${path}?tenant=${tenantSlug}`;
}
```

## Tenant Context Provider

```typescript
// lib/tenant/context.tsx
'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { useSession } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';

interface TenantContextValue {
  tenantId: string | null;
  tenantSlug: string | null;
  tier: 'FREE' | 'PRO' | 'ENTERPRISE' | null;
  isAdmin: boolean;
  isParticipant: boolean;
  roles: string[];
}

const TenantContext = createContext<TenantContextValue>({
  tenantId: null,
  tenantSlug: null,
  tier: null,
  isAdmin: false,
  isParticipant: false,
  roles: [],
});

export function TenantProvider({ children }: { children: ReactNode }) {
  const { data: session } = useSession();
  const searchParams = useSearchParams();

  const tenantSlug = searchParams.get('tenant') || session?.tenantId || null;
  const roles = session?.roles || [];

  const value: TenantContextValue = {
    tenantId: session?.tenantId || null,
    tenantSlug,
    tier: null,
    isAdmin: roles.includes('admin'),
    isParticipant: roles.includes('participant'),
    roles,
  };

  return (
    <TenantContext.Provider value={value}>{children}</TenantContext.Provider>
  );
}

export function useTenant() {
  return useContext(TenantContext);
}
```

## Control Plane → Application Plane ハンドオフ

「管理画面を開く」ボタンの URL 生成方法。

```typescript
// 本番: https://{slug}.tenka.cloud/admin
// 開発: http://localhost:13001/admin?tenant={slug}
```

## 認可マトリックス

| ルート | participant | admin |
|--------|-------------|-------|
| /dashboard | Read | Read |
| /events/* | Read | Read |
| /admin/* | - | Full |
| /api/admin/* | - | Full |

## AWS Challenge デプロイアーキテクチャ

```
[Admin UI]
    │
    │ 1. デプロイリクエスト
    ▼
┌─────────────────────────────────────────────────────────┐
│ Application Plane API                                   │
│ POST /api/admin/deploy                                  │
│                                                         │
│ { eventId, challengeId, participantId, targetAwsAccountId } │
└─────────────────────────────────────────────────────────┘
    │
    │ 2. STS AssumeRole
    ▼
┌─────────────────────────────────────────────────────────┐
│ Tenant AWS Account                                      │
│ - VPC, Subnets                                          │
│ - EC2/ECS/Lambda                                        │
│ - RDS/DynamoDB/S3                                       │
│ Tags: tenant-id, event-id, challenge-id                 │
└─────────────────────────────────────────────────────────┘
```

## Related Issues

- GitHub Issue: Application Plane マルチテナントルーティングとテナント識別設計

## Next Steps

1. **Phase 1 実装**: middleware.ts + tenant context
2. **Phase 2 実装**: admin ルート基盤
3. **Phase 3 実装**: admin API
4. **Phase 4 実装**: AWS デプロイ機能
