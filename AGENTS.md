# AGENTS.md — TenkaCloud

AI エージェント（Claude Code, Codex 等）向けのガイド。このファイルは CLAUDE.md を補完する。

## セットアップ

```bash
make install    # 依存関係インストール（Bun 自動選択）
make start      # 全サービス起動（Docker + UI + Backend 11 サービス）
```

## 品質ゲート

```bash
make before-commit   # lint, format, typecheck, test (99％+ coverage), build
```

**これが通らない限りタスクは未完了。** 失敗したらコードを修正する（設定ファイルを変えない）。

## コマンド一覧

| コマンド | 用途 |
|---------|------|
| `ni` | 依存関係インストール（bun 自動選択） |
| `nr dev` | 全サービス起動 |
| `nr test` | テスト実行 |
| `make test_quick` | カバレッジなし高速テスト |
| `make gameday-seed` | GameDay デモデータ投入 |
| `make help` | 全コマンド一覧 |

## 制約（破ったら即修正）

- **`npx` 禁止** → `bunx` または `nlx` を使う
- **`rm` コマンド禁止** → ファイル削除が必要なら `git` で管理
- **`#番号` 形式の Issue 引用禁止** → コミット・PR で使わない
- **モックデータ・スタブ API 禁止** → DynamoDB を使う
- **テストタイトルは日本語「〜すべき」形式**
- **設定ファイル（`biome.json`, `vitest.config.*` 等）の直接編集禁止** → コードを修正する

## セキュリティ基準

- ユーザー入力は Zod スキーマでバリデーション
- 認証バイパス（AUTH_SKIP）には必ず `NODE_ENV !== "production"` ガード
- シークレットをコードにハードコードしない
- `innerHTML`、`eval`、`dangerouslySetInnerHTML` を使わない
- SQL/NoSQL インジェクション対策: パラメータ化クエリを使う

## アーキテクチャ概要

```
TenkaCloud/
├── apps/
│   ├── control-plane/         # テナント管理 UI (Next.js, :13000)
│   └── application-plane/     # GameDay/Battle UI (Next.js, :13001)
├── backend/services/
│   ├── shared/                # DynamoDB クライアント, イベント型, 認証
│   ├── control-plane/         # テナント管理, プロビジョニング
│   └── application-plane/     # problem, gameday, battle, scoring, leaderboard
├── packages/                  # 共有ライブラリ
├── docs/decisions/            # ADR（アーキテクチャ決定記録）
└── infrastructure/            # IaC
```

### サービス間通信

- フロントエンド → バックエンド: HTTP REST（Hono）
- リアルタイム: SSE（leaderboard-service）、WebSocket（realtime-service）
- クロスプレーン: EventBridge（テナントプロビジョニング）

### データベース設計

DynamoDB シングルテーブル設計。PK/SK パターンは以下の通り。
- イベント: `PK=EVENT#{eventId}`, `SK=METADATA`
- GameDay チーム: `PK=GAMEDAY#{eventId}`, `SK=TEAM#{teamId}`
- テナント別クエリ: GSI1 `PK=TENANT#{tenantId}`

### イベントライフサイクル

```
draft → scheduled → active → paused → active → completed → cancelled
                                 ↑________________↓
```

遷移ルールは `problem-service/src/services/event-lifecycle.ts` で定義。フロントエンドは `getStatusActions()` で有効な遷移のみボタン表示。

## テストパターン

```typescript
// Hono API テスト
const app = new Hono();
app.route("/", targetRoutes);
const res = await app.request("/path", { method: "POST", ... });
expect(res.status).toBe(200);

// vi.mock + vi.hoisted パターン（instanceof チェックがあるクラス）
const mockController = vi.hoisted(() => ({
  myFn: vi.fn(),
  MyError: class extends Error { ... },
}));
vi.mock("../module", () => ({
  myFn: mockController.myFn,
  MyError: mockController.MyError,
}));

// DynamoDB リポジトリテスト
const mockSend = vi.fn();
vi.mock("@tenkacloud/dynamodb", () => ({
  getDocClient: () => ({ send: mockSend }),
  getTableName: () => "TestTable",
}));
```

## 決定記録

アーキテクチャ決定記録: `docs/decisions/`
- ADR-001: ドキュメント構成
- ADR-002: GameDay 仕様（攻撃カタログ、スコアリング）
- ADR-003: MVP リリースアーキテクチャ
- ADR-007: マルチテナント分離戦略
