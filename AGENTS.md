# AGENTS.md — TenkaCloud

AI エージェント（Claude Code, Codex 等）向けのエントリポイント。

## Setup

```bash
make install && make start
```

## Verify

```bash
make before-commit   # lint, format, typecheck, test (99%+ coverage), build
```

## Key Commands

| Command | Purpose |
|---------|---------|
| `ni` | 依存関係インストール（bun 自動選択） |
| `nr dev` | 全サービス起動 |
| `nr test` | テスト実行 |
| `make gameday-seed` | GameDay デモデータ投入 |

## Constraints

- `rm` コマンド禁止
- `#番号` 形式の Issue 引用禁止
- モックデータ・スタブ API 禁止
- テストタイトルは日本語「〜すべき」形式
- 設定ファイル（`.eslintrc`, `vitest.config.*` 等）の直接編集禁止 — コードを修正する

## Architecture

- **Control Plane** (`apps/control-plane`): テナント管理 UI (Next.js, port 13000)
- **Application Plane** (`apps/application-plane`): GameDay/Battle UI (Next.js, port 13001)
- **Backend Services** (`backend/services/`): Hono + DynamoDB マイクロサービス群

## Decisions

アーキテクチャ決定記録: `docs/decisions/`
