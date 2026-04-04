# ADR-007: マルチテナントインフラ分離戦略

- **Status**: Accepted
- **Date**: 2026-04-03
- **Deciders**: TenkaCloud チーム

## Context

TenkaCloud はマルチテナント SaaS として、複数のテナントが同一プラットフォームを利用する。
テナント間のデータ分離を確実に行い、あるテナントが他テナントのデータにアクセスすることを防ぐ必要がある。

現在のシステムは DynamoDB のシングルテーブルデザインを採用しており、テナントモデルには `isolationModel`（POOL/SILO）と `computeType`（SERVERLESS/KUBERNETES）が定義されている。

## Decision

### Pool モデル（共有リソース）
- すべてのテナントが同一の DynamoDB テーブルを共有する
- パーティションキーに `tenantId` を含めることでデータを論理的に分離する
- アプリケーションレベルでテナントコンテキストを強制し、クロステナントアクセスを防止する
- FREE/PRO ティアのテナントに適用

### Silo モデル（専用リソース）
- 各テナントが専用の DynamoDB テーブルおよびコンピュートリソースを持つ
- ENTERPRISE ティアのテナントに適用
- 将来的に Silo モデルへの移行パスを提供

### MVP 方針
- **MVP では Pool モデルを採用**し、全テナントが同一テーブルを共有する
- テナントコンテキスト（`withTenantContext`）をすべての DB 操作に適用
- Hono ミドルウェアで JWT からテナント ID を抽出し、リクエストごとにテナントアクセスを検証
- Enterprise ティアへのアップグレード時に Silo モデルへ移行可能な設計とする

### 実装コンポーネント
1. **テナントコンテキスト** (`tenant-context.ts`): PK プレフィックス付与とアクセス検証
2. **テナント分離ミドルウェア** (`tenant-isolation.ts`): JWT からのテナント ID 抽出とコンテキスト設定
3. **リポジトリ層**: すべての DynamoDB クエリにテナント ID をパーティションキーに含める

## Consequences

### 良い面
- シンプルなインフラ構成で運用コストが低い
- テナント追加が即座に可能（テーブル作成不要）
- アプリケーションレベルの分離により、Silo モデルへの段階的移行が可能

### 悪い面
- Pool モデルでは「ノイジーネイバー」問題が発生する可能性がある
- DynamoDB のスロットリングが他テナントに影響する可能性がある
- アプリケーションレベルの分離はバグによるデータ漏洩リスクがある

### トレードオフ
- MVP の速度を優先し、完全な物理分離は後回しにする
- テナントコンテキストの強制により、論理分離の信頼性を確保する

## References

- AWS SaaS Factory: Multi-tenant data isolation patterns
- DynamoDB single-table design best practices
