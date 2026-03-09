# Frontend Full Integration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** フロントエンドの全モック/スタブを実 API 接続に置き換え、QA・User・PM チームレビューで品質担保する

**Architecture:** バックエンドサービス（battle/scoring/leaderboard/problem）は Hono.js で実装済みだが docker-compose/nginx に未接続。まずインフラ配線を通し、フロントエンドの各ページからモックデータを撤去して実 API に差し替える。各タスク完了時に QA エージェントがモック残存・エラーハンドリング・テストを検証し、User エージェントが UX を評価する。

**Tech Stack:** Next.js 16, Hono.js, DynamoDB (LocalStack), nginx, Docker Compose, Bun, vitest

---

## チームレビュープロトコル

各タスク完了後、以下の順序でレビューを実施:

1. **QA エージェント** — コードレビュー + 品質ゲート
   - `grep -r "mock\|Mock\|MOCK\|TODO\|FIXME\|console\.log" <対象ファイル>` でゼロ確認
   - API エラー時の UI（try/catch + error state）が実装されているか
   - ローディング・空データ状態があるか
   - テストが日本語「〜すべき」形式で書かれているか

2. **User エージェント** — UX 評価
   - 初めて使うユーザーとして画面を読み、操作フローが自然か
   - エラー時に何をすればいいか分かるか
   - ラベル・文言が適切か

3. **PM (統括)** — フィードバック統合 → 修正指示 or 次タスクへ

---

## Task 1: バックエンドサービスの Dockerfile 作成

**Files:**
- Create: `backend/services/application-plane/battle-service/Dockerfile`
- Create: `backend/services/application-plane/scoring-service/Dockerfile`
- Create: `backend/services/application-plane/leaderboard-service/Dockerfile`
- Create: `backend/services/application-plane/problem-service/Dockerfile`
- Reference: `backend/services/control-plane/tenant-management/Dockerfile`

**Step 1: Write Dockerfile for battle-service**

```dockerfile
FROM oven/bun:1.2.20-slim AS base
WORKDIR /app

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

COPY . .

RUN bun install --frozen-lockfile

WORKDIR /app/backend/services/application-plane/battle-service

RUN bun run build

EXPOSE 3010

CMD ["bun", "run", "start"]
```

**Step 2: Write Dockerfile for scoring-service**

同じパターン。EXPOSE 3011、WORKDIR を scoring-service に変更。

**Step 3: Write Dockerfile for leaderboard-service**

同じパターン。EXPOSE 3012、WORKDIR を leaderboard-service に変更。

**Step 4: Write Dockerfile for problem-service**

同じパターン。EXPOSE 3100、WORKDIR を problem-service に変更。problem-service は Bun native server なので `CMD ["bun", "run", "start"]` でそのまま動く。

**Step 5: Commit**

```bash
git add backend/services/application-plane/*/Dockerfile
git commit -m "feat(infra): add Dockerfiles for backend application-plane services"
```

---

## Task 2: docker-compose.yml にバックエンドサービス追加

**Files:**
- Modify: `docker-compose.yml`

**Step 1: Write failing test — docker-compose config validation**

Run: `docker compose config --quiet`
Expected: PASS (現状の設定が有効であることを確認)

**Step 2: Add battle-service to docker-compose.yml**

`tenant-management` の後に追加:

```yaml
  battle-service:
    build:
      context: .
      dockerfile: backend/services/application-plane/battle-service/Dockerfile
    expose:
      - "3010"
    environment:
      - PORT=3010
      - DYNAMODB_TABLE_NAME=TenkaCloud-dev
      - DYNAMODB_ENDPOINT=http://localstack:4566
      - AWS_REGION=ap-northeast-1
      - AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-test}
      - AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-test}
      - CORS_ORIGIN=http://localhost:3000,http://localhost:13001
    depends_on:
      localstack:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3010/health"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - tenkacloud
```

**Step 3: Add scoring-service**

同パターン。ポート 3011。

**Step 4: Add leaderboard-service**

同パターン。ポート 3012。

**Step 5: Add problem-service**

同パターン。ポート 3100。追加環境変数: `KEYCLOAK_URL`, `KEYCLOAK_REALM`。

**Step 6: Update nginx depends_on**

nginx の `depends_on` に 4 サービスを追加。

**Step 7: Validate config**

Run: `docker compose config --quiet`
Expected: PASS

**Step 8: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(infra): add battle/scoring/leaderboard/problem services to docker-compose"
```

---

## Task 3: nginx.conf にバックエンド API ルーティング追加

**Files:**
- Modify: `infrastructure/nginx/nginx.conf`

**Step 1: Add upstream definitions**

既存の `upstream tenant-api` の後に追加:

```nginx
upstream battle-api {
    server battle-service:3010;
}

upstream scoring-api {
    server scoring-service:3011;
}

upstream leaderboard-api {
    server leaderboard-service:3012;
}

upstream problem-api {
    server problem-service:3100;
}
```

**Step 2: Add location blocks**

`location /api/tenants` ブロックの後に追加:

```nginx
    # Battle API: /api/battles/*
    location /api/battles {
        proxy_pass http://battle-api/battles;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Scoring API: /api/scores/*, /api/criteria/*, /api/sessions/*
    location /api/scores {
        proxy_pass http://scoring-api/api/scores;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/criteria {
        proxy_pass http://scoring-api/criteria;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/sessions {
        proxy_pass http://scoring-api/sessions;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Leaderboard API: /api/leaderboards/*
    location /api/leaderboards {
        proxy_pass http://leaderboard-api/api/leaderboards;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE support
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding off;
    }

    # Problem Service: /api/admin/*, /api/player/*, /api/participant/*
    location /api/admin {
        proxy_pass http://problem-api/api/admin;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/player {
        proxy_pass http://problem-api/api/player;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/participant {
        proxy_pass http://problem-api/api/participant;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
```

**Step 3: Validate nginx config syntax**

Run: `docker run --rm -v $(pwd)/infrastructure/nginx/nginx.conf:/etc/nginx/conf.d/default.conf:ro nginx:alpine nginx -t`
Expected: `syntax is ok`

**Step 4: Commit**

```bash
git add infrastructure/nginx/nginx.conf
git commit -m "feat(infra): add nginx routing for all backend services"
```

---

## Task 4: フロントエンド API_BASE_URL の修正

**Files:**
- Modify: `apps/application-plane/lib/api/client.ts:9-10`

**Step 1: Update API base URL**

```typescript
// Before:
const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';

// After:
const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api';
```

nginx (port 3000) を経由して全バックエンドに到達する。

**Step 2: Update application-plane docker-compose env**

docker-compose.yml の application-plane セクションに追加:

```yaml
      - NEXT_PUBLIC_API_URL=http://localhost:3000/api
```

**Step 3: Commit**

```bash
git add apps/application-plane/lib/api/client.ts docker-compose.yml
git commit -m "fix(frontend): update API base URL to use nginx proxy"
```

---

## Task 5: ランキングページ — モック撤去 + 実 API 接続

**Files:**
- Modify: `apps/application-plane/app/rankings/page.tsx`
- Test: `apps/application-plane/app/rankings/__tests__/page.test.tsx`
- Reference: `apps/application-plane/lib/api/profile.ts:74-98` (`getGlobalRanking`)

**Step 1: Write failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import RankingsPage from '../page';

// API モックを設定
vi.mock('@/lib/api/profile', () => ({
  getGlobalRanking: vi.fn().mockResolvedValue({
    rankings: [
      { rank: 1, userId: 'u1', name: 'テスト太郎', totalScore: 15000, eventsParticipated: 12 },
    ],
    total: 1,
  }),
}));

describe('ランキングページ', () => {
  it('API からランキングデータを取得して表示すべき', async () => {
    render(<RankingsPage />);
    await waitFor(() => {
      expect(screen.getByText('テスト太郎')).toBeInTheDocument();
    });
  });

  it('モックデータを含まないべき', async () => {
    const fileContent = await import('../page?raw');
    expect(fileContent.default).not.toContain('mockRankings');
    expect(fileContent.default).not.toContain('クラウドマスター');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/application-plane && bunx vitest run app/rankings/__tests__/page.test.tsx`
Expected: FAIL

**Step 3: Replace mock with real API call**

`rankings/page.tsx` を修正:
- `mockRankings` 配列を削除（lines 32-74）
- `useEffect` で `getGlobalRanking()` を呼び出し
- ハードコード統計（'128', '24', '15,000'）を API レスポンスから算出
- ローディング状態とエラー状態を追加

**Step 4: Run test to verify it passes**

Run: `cd apps/application-plane && bunx vitest run app/rankings/__tests__/page.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/application-plane/app/rankings/
git commit -m "feat(rankings): replace mock data with real API call"
```

**Step 6: QA レビュー**
- `grep -r "mock\|Mock\|MOCK\|TODO\|FIXME\|console\.log" apps/application-plane/app/rankings/`
- エラーハンドリングの確認
- ローディング・空データ状態の確認

**Step 7: User レビュー**
- ランキング表示が自然か
- 順位変動（trend）の表示がわかりやすいか
- ページネーションが動くか

---

## Task 6: Admin ダッシュボード — モック撤去 + 実 API 接続

**Files:**
- Modify: `apps/application-plane/app/(admin)/admin/page.tsx`
- Test: `apps/application-plane/app/(admin)/admin/__tests__/page.test.tsx`
- Create: `apps/application-plane/lib/api/admin-dashboard.ts`

**Step 1: Write admin dashboard API client**

```typescript
import { get } from './client';

export interface DashboardStats {
  activeEvents: number;
  totalParticipants: number;
  totalTeams: number;
  upcomingEvents: number;
}

export interface ActivityEntry {
  id: string;
  type: string;
  message: string;
  timestamp: string;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  return get<DashboardStats>('/admin/dashboard/stats');
}

export async function getRecentActivities(limit = 10): Promise<{ activities: ActivityEntry[] }> {
  return get<{ activities: ActivityEntry[] }>('/admin/activities', { limit });
}
```

**Step 2: Write failing test**

テストで `getDashboardStats` と `getRecentActivities` を vi.mock して、ページがモックデータではなく API を呼ぶことを検証。

**Step 3: Replace mock data in admin page**

- lines 121-158 の `// TODO: Replace with actual API call` ブロックを削除
- `getDashboardStats()` と `getRecentActivities()` を useEffect で呼び出し
- ローディング・エラー状態を追加

**Step 4: Run test, verify pass, commit**

**Step 5: QA + User レビュー**

---

## Task 7: Admin イベント詳細 — モック撤去 + 実 API 接続

**Files:**
- Modify: `apps/application-plane/app/(admin)/admin/events/[eventId]/page.tsx`
- Test: `apps/application-plane/app/(admin)/admin/events/[eventId]/__tests__/page.test.tsx`

**Step 1: Write failing test**

**Step 2: Replace mock event data (lines 50-87) with API call**

`/api/admin/events/{eventId}` を GET。既存の problem-service admin routes が `GET /api/admin/events/:eventId` を提供しているはず。

**Step 3: Add error/loading states**

**Step 4: Run test, verify pass, commit**

**Step 5: QA + User レビュー**

---

## Task 8: Admin イベント削除 — 空ハンドラー実装

**Files:**
- Modify: `apps/application-plane/app/(admin)/admin/events/page.tsx`
- Test: `apps/application-plane/app/(admin)/admin/events/__tests__/page.test.tsx`

**Step 1: Write failing test**

削除ボタンクリック → 確認ダイアログ → API 呼び出し → リスト更新を検証。

**Step 2: Implement delete handler (line 238-240)**

```typescript
// Before:
onClick={() => {
  // TODO: Implement delete
}}

// After:
onClick={async () => {
  if (!confirm(`「${event.name}」を削除しますか？`)) return;
  try {
    await del(`/admin/events/${event.id}`);
    setEvents(events.filter(e => e.id !== event.id));
  } catch (error) {
    setError('イベントの削除に失敗しました');
  }
}}
```

**Step 3: Run test, verify pass, commit**

**Step 4: QA + User レビュー**

---

## Task 9: Admin マーケットプレイス — モック撤去 + 実 API 接続

**Files:**
- Modify: `apps/application-plane/app/(admin)/admin/marketplace/page.tsx`
- Reference: `apps/application-plane/lib/api/admin-problems.ts:23-33` (`getProblems`)

**Step 1: Write failing test**

**Step 2: Replace mock problems (lines 53-139) with `getProblems()` call**

既に `admin-problems.ts` に `getProblems()` 関数がある。そのまま使う。

**Step 3: Run test, verify pass, commit**

**Step 4: QA + User レビュー**

---

## Task 10: Admin 設定 — setTimeout 撤去 + 実 API 接続

**Files:**
- Modify: `apps/application-plane/app/(admin)/admin/settings/page.tsx`

**Step 1: Write failing test**

**Step 2: Replace setTimeout (lines 48-51) with real API call**

```typescript
// Before:
await new Promise((resolve) => setTimeout(resolve, 1000));

// After:
await put('/admin/settings', settings);
```

**Step 3: Run test, verify pass, commit**

**Step 4: QA + User レビュー**

---

## Task 11: サインアップ — スタブ撤去 + Auth0 統合

**Files:**
- Modify: `apps/application-plane/app/signup/page.tsx`

**Step 1: Write failing test**

**Step 2: Implement signup flow**

- コメントアウトされた API 呼び出し (lines 55-60) をアンコメント + Auth0 createUser API に接続
- `console.log` の social login (line 76) を `signIn(provider)` (NextAuth) に置き換え
- setTimeout 仮実装 (line 62) を削除

**Step 3: Run test, verify pass, commit**

**Step 4: QA + User レビュー**

---

## Task 12: mock-tenant-api.ts 廃止

**Files:**
- Check usage: `apps/control-plane/lib/api/mock-tenant-api.ts`

**Step 1: Grep for usage**

Run: `grep -r "mock-tenant-api\|mockTenantApi" apps/control-plane/`

**Step 2: If unused, delete file. If used, replace imports with real tenant-api.**

**Step 3: Commit**

---

## Task 13: 最終品質ゲート

**Step 1: 全モック/スタブ検索**

```bash
grep -rn "mock\|Mock\|MOCK\|TODO\|FIXME\|HACK\|console\.log\|setTimeout.*resolve" \
  apps/application-plane/app/ apps/control-plane/app/ \
  --include="*.tsx" --include="*.ts" \
  | grep -v "__tests__" | grep -v "node_modules"
```

Expected: 0 結果（テストファイル内のモックは除外）

**Step 2: 全テスト実行**

Run: `make before-commit`
Expected: ALL PASS

**Step 3: QA 最終レビュー — 全ページ横断チェック**

**Step 4: User 最終レビュー — 全フロー体験**

**Step 5: PM 最終判断 — マージ可否**
