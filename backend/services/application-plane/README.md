# Application Plane Services

Application Plane は、テナント体験と競技体験を担うサービス群です。

## 含まれるサービス

- `problem-service`: 問題、イベント、テンプレート管理
- `gameday-service`: GameDay API
- `battle-service`: Battle セッション管理
- `scoring-service`: 採点処理
- `leaderboard-service`: ランキング集計
- `tenant-provisioner`: テナント環境側のプロビジョニング補助

## 責務

- 競技イベントの実行
- 問題ライフサイクル管理
- 採点とランキング
- テナント参加者向け API の提供

## 技術方針

- TypeScript
- Hono ベースの API サービスを中心に構成
- DynamoDB 系の共有実装を利用
- UI からは `apps/application-plane` 経由で利用される

## ローカル開発

サービス単位で起動します。例は以下のとおりです。

```bash
cd backend/services/application-plane/problem-service
bun run dev
```

```bash
cd backend/services/application-plane/gameday-service
bun run dev
```

## 関連文書

- [docs/architecture/architecture.md](/Users/susumu/product/TenkaCloud/docs/architecture/architecture.md)
- [README.md](/Users/susumu/product/TenkaCloud/README.md)
