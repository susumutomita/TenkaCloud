# TenkaCloud E2E テスト計画

本ドキュメントは、TenkaCloud の E2E テスト戦略、環境構築、実行方法を定義する。

## 目次

1. [テスト戦略](#テスト戦略)
2. [テスト環境](#テスト環境)
3. [認証のモック](#認証のモック)
4. [テストデータ管理](#テストデータ管理)
5. [テストの構成](#テストの構成)
6. [CI/CD 統合](#cicd-統合)
7. [実行方法](#実行方法)

---

## テスト戦略

### テストピラミッド

```
                    ╱╲
                   ╱  ╲
                  ╱ E2E╲        ← 少数の重要なユーザーフロー
                 ╱──────╲
                ╱ 統合    ╲      ← API・コンポーネント間の連携
               ╱────────────╲
              ╱    単体       ╲   ← ビジネスロジック・ユーティリティ
             ╱────────────────────╲
```

### E2E テストの範囲

E2E テストは **クリティカルなユーザーフロー** に集中する：

| 優先度 | フロー | 理由 |
|--------|--------|------|
| P0 | ログイン → ダッシュボード | 全機能の入り口 |
| P0 | テナント作成 → 一覧表示 | Control Plane のコア機能 |
| P0 | 問題作成 → バトルで使用 | Application Plane のコア機能 |
| P0 | バトル参加 → 問題提出 → スコア確認 | 競技者の主要フロー |
| P1 | AI 問題生成 | 差別化機能 |
| P1 | リーダーボード更新 | リアルタイム性の検証 |

### テストしないこと

- 外部サービス（Auth0、AWS）の内部動作
- 単体テストでカバー済みのロジック
- スタイリング・レイアウトの詳細（Visual Regression は別途検討）

---

## テスト環境

### 環境一覧

| 環境 | 用途 | データ | 認証 |
|------|------|--------|------|
| **Local** | 開発者のローカル実行 | シードデータ | AUTH_SKIP=1 |
| **CI** | GitHub Actions での自動実行 | シードデータ | AUTH_SKIP=1 |
| **Staging** | リリース前検証 | 本番相当 | Auth0（テスト用テナント） |

### 必要なサービス

```yaml
# docker-compose.e2e.yml
version: '3.8'
services:
  # LocalStack: AWS サービスのモック
  localstack:
    image: localstack/localstack:latest
    ports:
      - "4566:4566"
    environment:
      - SERVICES=dynamodb,s3,lambda
      - DEFAULT_REGION=ap-northeast-1
    volumes:
      - ./infrastructure/localstack:/etc/localstack/init/ready.d

  # Control Plane UI
  control-plane:
    build:
      context: ./apps/control-plane
    ports:
      - "13000:13000"
    environment:
      - AUTH_SKIP=1
      - DYNAMODB_ENDPOINT=http://localstack:4566
    depends_on:
      - localstack

  # Application Plane UI
  application-plane:
    build:
      context: ./apps/application-plane
    ports:
      - "13001:13001"
    environment:
      - AUTH_SKIP=1
      - DYNAMODB_ENDPOINT=http://localstack:4566
    depends_on:
      - localstack
```

### ポート割り当て

| サービス | ポート | 説明 |
|----------|--------|------|
| Control Plane UI | 13000 | プラットフォーム管理画面 |
| Application Plane UI | 13001 | テナント管理者・競技者画面 |
| LocalStack | 4566 | AWS サービスモック |
| Tenant Management API | 13100 | テナント管理 API |
| Problem Service API | 13101 | 問題管理 API |
| Battle Service API | 13102 | バトル管理 API |

---

## 認証のモック

### AUTH_SKIP モード

開発・CI 環境では `AUTH_SKIP=1` 環境変数で認証をバイパスする。

```typescript
// middleware.ts（既存実装）
export function middleware(request: NextRequest) {
  // AUTH_SKIP モードでは認証チェックをスキップ
  if (process.env.AUTH_SKIP === '1') {
    return NextResponse.next();
  }
  // 本番環境では NextAuth でセッション検証
  // ...
}
```

### モックユーザー

`AUTH_SKIP=1` 時に使用されるモックユーザー：

```typescript
// lib/auth/mock-user.ts
export const mockUsers = {
  platformAdmin: {
    id: 'mock-platform-admin',
    name: 'Platform Admin（開発モード）',
    email: 'admin@tenkacloud.test',
    role: 'platform_admin',
  },
  tenantAdmin: {
    id: 'mock-tenant-admin',
    name: 'Tenant Admin（開発モード）',
    email: 'tenant@acme.test',
    role: 'tenant_admin',
    tenantId: 'tenant-acme',
  },
  participant: {
    id: 'mock-participant',
    name: 'Test Participant',
    email: 'user@example.test',
    role: 'participant',
    tenantId: 'tenant-acme',
  },
};
```

### ロール切り替え

E2E テストでは `?mock_role=` クエリパラメータでロールを切り替える：

```typescript
// e2e/fixtures.ts
import { test as base } from '@playwright/test';

export const test = base.extend({
  // プラットフォーム管理者としてログイン
  platformAdminPage: async ({ page }, use) => {
    await page.goto('/control?mock_role=platform_admin');
    await use(page);
  },
  // テナント管理者としてログイン
  tenantAdminPage: async ({ page }, use) => {
    await page.goto('/app?mock_role=tenant_admin');
    await use(page);
  },
  // 競技者としてログイン
  participantPage: async ({ page }, use) => {
    await page.goto('/app?mock_role=participant');
    await use(page);
  },
});
```

---

## テストデータ管理

### シードデータ

テスト実行前にシードデータを投入する。

```typescript
// e2e/seed/index.ts
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';

const client = new DynamoDBClient({
  endpoint: process.env.DYNAMODB_ENDPOINT || 'http://localhost:4566',
  region: 'ap-northeast-1',
});

export async function seedTestData() {
  // テナント
  await seedTenants();
  // 問題
  await seedProblems();
  // バトル
  await seedBattles();
}

async function seedTenants() {
  const tenants = [
    {
      PK: { S: 'TENANT#tenant-acme' },
      SK: { S: 'METADATA' },
      tenantId: { S: 'tenant-acme' },
      name: { S: 'Acme Corp' },
      status: { S: 'Active' },
      plan: { S: 'Enterprise' },
      createdAt: { S: new Date().toISOString() },
    },
    {
      PK: { S: 'TENANT#tenant-demo' },
      SK: { S: 'METADATA' },
      tenantId: { S: 'tenant-demo' },
      name: { S: 'Demo Company' },
      status: { S: 'Active' },
      plan: { S: 'Free' },
      createdAt: { S: new Date().toISOString() },
    },
  ];

  for (const tenant of tenants) {
    await client.send(
      new PutItemCommand({
        TableName: 'TenkaCloud',
        Item: tenant,
      })
    );
  }
}

async function seedProblems() {
  const problems = [
    {
      PK: { S: 'TENANT#tenant-acme' },
      SK: { S: 'PROBLEM#prob-001' },
      problemId: { S: 'prob-001' },
      title: { S: 'S3 バケット作成' },
      difficulty: { S: 'Easy' },
      status: { S: 'Published' },
    },
    {
      PK: { S: 'TENANT#tenant-acme' },
      SK: { S: 'PROBLEM#prob-002' },
      problemId: { S: 'prob-002' },
      title: { S: 'VPC 構築' },
      difficulty: { S: 'Medium' },
      status: { S: 'Published' },
    },
  ];

  for (const problem of problems) {
    await client.send(
      new PutItemCommand({
        TableName: 'TenkaCloud',
        Item: problem,
      })
    );
  }
}

async function seedBattles() {
  // バトルデータのシード
}
```

### データクリーンアップ

各テストスイート終了後にデータをクリーンアップ：

```typescript
// e2e/global-teardown.ts
import { DynamoDBClient, DeleteTableCommand, CreateTableCommand } from '@aws-sdk/client-dynamodb';

export default async function globalTeardown() {
  const client = new DynamoDBClient({
    endpoint: process.env.DYNAMODB_ENDPOINT || 'http://localhost:4566',
  });

  // テーブルを再作成してデータをクリア
  try {
    await client.send(new DeleteTableCommand({ TableName: 'TenkaCloud' }));
  } catch {
    // テーブルが存在しない場合は無視
  }

  await client.send(
    new CreateTableCommand({
      TableName: 'TenkaCloud',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    })
  );
}
```

---

## テストの構成

### ディレクトリ構造

```
apps/
├── control-plane/
│   ├── e2e/
│   │   ├── fixtures.ts          # 共通 fixture
│   │   ├── auth.spec.ts         # 認証フロー
│   │   ├── dashboard.spec.ts    # ダッシュボード
│   │   └── tenants/
│   │       ├── list.spec.ts     # テナント一覧
│   │       ├── create.spec.ts   # テナント作成
│   │       └── edit.spec.ts     # テナント編集
│   └── playwright.config.ts
│
├── application-plane/
│   ├── e2e/
│   │   ├── fixtures.ts
│   │   ├── auth.spec.ts
│   │   ├── problems/
│   │   │   ├── list.spec.ts     # 問題一覧
│   │   │   ├── create.spec.ts   # 問題作成
│   │   │   └── ai-generate.spec.ts  # AI 生成
│   │   └── battles/
│   │       ├── list.spec.ts     # バトル一覧
│   │       ├── create.spec.ts   # バトル作成
│   │       ├── participate.spec.ts  # バトル参加
│   │       └── leaderboard.spec.ts  # リーダーボード
│   └── playwright.config.ts
│
e2e/
├── global-setup.ts              # グローバルセットアップ
├── global-teardown.ts           # グローバルティアダウン
├── seed/                        # シードデータ
│   ├── index.ts
│   ├── tenants.ts
│   ├── problems.ts
│   └── battles.ts
└── cross-plane/                 # プレーン間のフロー
    └── tenant-onboarding.spec.ts
```

### Playwright 設定

```typescript
// playwright.config.ts（プロジェクト共通）
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['html', { open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
    process.env.CI ? ['github'] : ['list'],
  ],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile',
      use: { ...devices['iPhone 14'] },
    },
  ],
  globalSetup: require.resolve('./e2e/global-setup'),
  globalTeardown: require.resolve('./e2e/global-teardown'),
});
```

### Page Object Model

複雑なページには Page Object を使用：

```typescript
// e2e/pages/tenant-list.page.ts
import { Page, Locator } from '@playwright/test';

export class TenantListPage {
  readonly page: Page;
  readonly createButton: Locator;
  readonly searchInput: Locator;
  readonly statusFilter: Locator;
  readonly tenantTable: Locator;

  constructor(page: Page) {
    this.page = page;
    this.createButton = page.getByRole('link', { name: '新規テナント作成' });
    this.searchInput = page.getByPlaceholder('テナント名で検索');
    this.statusFilter = page.getByRole('combobox', { name: 'ステータス' });
    this.tenantTable = page.getByRole('table');
  }

  async goto() {
    await this.page.goto('/dashboard/tenants');
  }

  async search(query: string) {
    await this.searchInput.fill(query);
    await this.page.keyboard.press('Enter');
  }

  async filterByStatus(status: 'All' | 'Active' | 'Suspended') {
    await this.statusFilter.selectOption(status);
  }

  async getTenantRow(tenantName: string): Promise<Locator> {
    return this.tenantTable.getByRole('row', { name: new RegExp(tenantName) });
  }

  async clickTenant(tenantName: string) {
    const row = await this.getTenantRow(tenantName);
    await row.getByRole('link').first().click();
  }
}
```

---

## CI/CD 統合

### GitHub Actions ワークフロー

```yaml
# .github/workflows/e2e.yml
name: E2E Tests

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    services:
      localstack:
        image: localstack/localstack:latest
        ports:
          - 4566:4566
        env:
          SERVICES: dynamodb,s3

    steps:
      - uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install

      - name: Install Playwright browsers
        run: bunx playwright install --with-deps chromium

      - name: Wait for LocalStack
        run: |
          timeout 60 bash -c 'until curl -s http://localhost:4566/_localstack/health | grep -q running; do sleep 2; done'

      - name: Seed test data
        run: bun run e2e:seed
        env:
          DYNAMODB_ENDPOINT: http://localhost:4566

      - name: Run E2E tests (Control Plane)
        run: bun run --cwd apps/control-plane test:e2e
        env:
          AUTH_SKIP: '1'
          DYNAMODB_ENDPOINT: http://localhost:4566

      - name: Run E2E tests (Application Plane)
        run: bun run --cwd apps/application-plane test:e2e
        env:
          AUTH_SKIP: '1'
          DYNAMODB_ENDPOINT: http://localhost:4566

      - name: Upload test results
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: playwright-report
          path: '**/playwright-report/'
          retention-days: 7

      - name: Upload traces
        uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-traces
          path: '**/test-results/'
          retention-days: 3
```

### テスト並列化

CI では時間短縮のためシャーディングを使用：

```yaml
jobs:
  e2e:
    strategy:
      matrix:
        shard: [1, 2, 3]
    steps:
      - name: Run E2E tests
        run: bunx playwright test --shard=${{ matrix.shard }}/3
```

---

## 実行方法

### ローカル実行

```bash
# 1. インフラ起動（LocalStack）
make start-infrastructure

# 2. シードデータ投入
bun run e2e:seed

# 3. E2E テスト実行
# Control Plane
cd apps/control-plane && bun run test:e2e

# Application Plane
cd apps/application-plane && bun run test:e2e

# UI モードで実行（デバッグ用）
bun run test:e2e:ui

# ヘッドありで実行（ブラウザを表示）
bun run test:e2e:headed
```

### 特定のテストのみ実行

```bash
# ファイル指定
bunx playwright test e2e/tenants/create.spec.ts

# テスト名でフィルタ
bunx playwright test -g "テナント作成"

# タグでフィルタ
bunx playwright test --grep @smoke
```

### デバッグ

```bash
# デバッグモード
PWDEBUG=1 bunx playwright test

# トレースビューアー
bunx playwright show-trace test-results/trace.zip

# レポート表示
bunx playwright show-report
```

---

## 次のステップ

1. [USER_STORIES.md](./USER_STORIES.md) - ユーザーストーリー定義
2. [TEST_SCENARIOS.md](./TEST_SCENARIOS.md) - 詳細なテストシナリオ（Playwright コード）
