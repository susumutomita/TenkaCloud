# AGENTS.md — TenkaCloud

AI エージェント（Claude Code, Codex 等）向けのガイド。このファイルは CLAUDE.md を補完する。

## セットアップ

```bash
make install    # 依存関係インストール（Bun 自動選択）
make start      # 全サービス起動（Docker + UI + Backend 11 サービス）
```

## 品質ゲート

PR 作成前に以下を **この順序で** 実行する。

```bash
bun scripts/architecture-harness.ts --staged --fail-on=error
make before-commit   # lint, format, typecheck, test (99％+ coverage), build
/review              # コードレビュー
/security-review     # セキュリティレビュー
/simplify            # コード重複・品質・効率チェック
```

**すべて通らない限りタスクは未完了。** 失敗したらコードを修正する（設定ファイルを変えない）。

### 作業順序（厳守）

新規機能を追加する前に以下を実施する。
1. **ドキュメント更新** — 関連する docs/, ADR, CLAUDE.md を先に更新する。
2. **リファクタリング** — 技術的負債を先に解消する（`bun scripts/ai-improvement-loop.ts --staged --fail-on=high`）。

アーキテクチャ原則の正本は [`docs/architecture/harness.md`](./docs/architecture/harness.md) です。`Codex` と `Claude Code` のどちらでも、この script を通らない変更は未完了です。

大きい変更や新機能の前後では、次も実行する。

```bash
bun scripts/architecture-harness.ts --staged --fail-on=error
bun scripts/ai-improvement-loop.ts --write --fail-on=high
```

このループで `high` 以上が出た領域では、機能追加より先に負債を解消する。

## コマンド一覧

| コマンド            | 用途                                 |
| ------------------- | ------------------------------------ |
| `ni`                | 依存関係インストール（bun 自動選択） |
| `nr dev`            | 全サービス起動                       |
| `nr test`           | テスト実行                           |
| `make test_quick`   | カバレッジなし高速テスト             |
| `make gameday-seed` | GameDay デモデータ投入               |
| `make help`         | 全コマンド一覧                       |

## 制約（破ったら即修正）

- **`npx` 禁止** → `bunx` または `nlx` を使う
- **`rm` コマンド禁止** → ファイル削除が必要なら `git` で管理
- **`#番号` 形式の Issue 引用禁止** → コミット・PR で使わない
- **モックデータ・スタブ API 禁止** → DynamoDB を使う
- **空配列返し・stub・empty dataset で握り潰す fallback 禁止**
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

### ハーネス優先

- 先に壊れるテストや検出ルールを書く
- 先に [`docs/architecture/harness.md`](./docs/architecture/harness.md) の invariant を確認する
- `tenant 作成 -> provisioning -> app endpoint -> event -> competitor account -> problem deploy -> participant join -> attack / defense / vote / aws-console` の one-pass を完了条件にする
- 1 テストケースに `expect` を詰め込みすぎない（アサーションルーレット禁止）
- route handler で fallback を重複実装しない
- UI から直接 `fetch` や `process.env.*API_URL` を読まない

## 決定記録

アーキテクチャ決定記録: `docs/decisions/`

- ADR-001: ドキュメント構成
- ADR-002: GameDay 仕様（攻撃カタログ、スコアリング）
- ADR-003: MVP リリースアーキテクチャ
- ADR-007: マルチテナント分離戦略
