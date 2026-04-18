# TenkaCloud

マルチテナント SaaS — AWS クラウドコンペティションプラットフォーム（GameDay / JAM）

## ゲート

### PR 作成前の必須チェック（この順序で実行）

1. `bun scripts/architecture-harness.ts --staged --fail-on=error`
2. `make before-commit` — lint・format・typecheck・test（カバレッジ 99％+）・build
3. `/review` — コードレビュー（品質・慣習・リスク）
4. `/security-review` — セキュリティレビュー（認証・認可・インジェクション）
5. `/simplify` — コード重複・品質・効率の最終チェック

すべて通るまで未完了。失敗したら原因を特定してコードを修正する（設定ファイルを変更しない）。

アーキテクチャ原則の正本は [`docs/architecture/harness.md`](./docs/architecture/harness.md) で、これは `Codex` と `Claude Code` の両方に共通です。

### 作業順序

新規機能を追加する前に、以下を先に実施する。
1. **ドキュメント更新** — 変更に関連する docs/, ADR, CLAUDE.md を先に更新する。
2. **リファクタリング** — 技術的負債（`bun scripts/ai-improvement-loop.ts --staged --fail-on=high` で検出）を先に解消する。

## コマンド体系

```bash
make start            # 全サービス起動（Docker + UI + Backend）
make before-commit    # 全品質チェック（PR 前に必須）
make test_quick       # 高速テスト（カバレッジなし）
make help             # 全コマンド一覧
```

パッケージ操作は **`ni` / `nr` / `bunx`** を使う。**`npx` は禁止**。

## 開発原則

### TDD

テストを先に書く。テストタイトルは日本語「〜すべき」形式。カバレッジ 99％+ を維持する。テスト不能なコード（SSE abort コールバック等）は `/* istanbul ignore next */` で明示的に除外し、理由をコメントに書く。

### セキュリティ

- OWASP Top 10 を常に意識する（SQL インジェクション、XSS、コマンドインジェクション等）
- ユーザー入力・外部 API 境界では必ずバリデーション（Zod スキーマ）
- 認証・認可のバイパス（AUTH_SKIP）は開発環境のみ。本番ガード（`NODE_ENV !== "production"`）を必ず入れる
- シークレット（.env, credentials）をコミットしない
- 依存パッケージの脆弱性に注意する

### コード品質

- 既存パターンに従う。新しいパターンを導入する前にコードベースの既存実装を確認する
- エラーハンドリングは具体的に。`catch {}` で握り潰さず、ユーザーに意味のあるフィードバックを返す
- 型安全を徹底する。`any` を避け、`unknown` + 型ガードを使う
- DRY より明確さを優先。3 行の重複は無理な抽象化より良い

### PR

小さい意味のある単位。PR 作成まで含めてタスク完了。`make before-commit` 通過が前提。

### ハーネス優先

- 仕様より先に [`docs/architecture/harness.md`](./docs/architecture/harness.md) の invariant を確認する
- `tenant 作成 -> provisioning -> tenant app endpoint -> event 作成 -> competitor account 登録 -> problem deploy -> participant join -> attack / defense / vote / aws-console` の one-pass を完了条件にする
- `local` と `AWS` の両方の受け入れ条件がない変更は未完了として扱う

## 禁止事項

- `rm` コマンド（環境破壊リスク）
- `npx`（`bunx` または `nlx` を使う）
- コミット / PR での `#番号` 形式の Issue 引用（自動クローズ防止）
- モックデータ・ハードコード配列・スタブ API（DynamoDB を使う）
- 設定ファイル（`biome.json`, `vitest.config.*` 等）の直接変更 — コードを修正する

## アーキテクチャ

```
Control Plane (port 13000)     — テナント管理 UI (Next.js)
Application Plane (port 13001) — GameDay/Battle UI (Next.js)
Backend Services               — Hono + DynamoDB マイクロサービス群
  problem-service    :3100     — イベント・問題管理
  gameday-service    :3020     — GameDay ゲーム状態管理
  leaderboard-service:3012     — スコア集計・SSE 配信
  battle-service     :3010     — バトル管理
  scoring-service    :3011     — 採点パイプライン
  tenant-management  :13004    — テナント CRUD
```

DynamoDB シングルテーブル設計。PK/SK にテナント ID を含めてテナント分離。

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| フロントエンド | Next.js 16, React 19, Cloudscape Design System, Tailwind CSS 4 |
| バックエンド | Hono, TypeScript, Zod |
| データベース | DynamoDB (LocalStack/Kumo でローカル) |
| テスト | Vitest (Istanbul), Playwright (E2E) |
| Lint/Format | Biome (フロント), Textlint (Markdown) |
| パッケージ管理 | Bun, npm workspaces |
| 認証 | NextAuth v5 + Auth0（開発時は AUTH_SKIP=1） |
| CI | GitHub Actions |

## ポインター

- デザインシステム: [Cloudscape](https://cloudscape.design/components/)（全 UI コンポーネントはここから選択）
- フロントエンドデザイン: `/skill frontend-design`
- スペック・仕様書: `/skill spec`
- アーキテクチャハーネス: `docs/architecture/harness.md`
- アーキテクチャ決定記録: `docs/decisions/`
- エージェント設定: @AGENTS.md
