# TenkaCloudChallenges

[TenkaCloud](https://github.com/susumutomita/TenkaCloud) の **private 競技用問題** を格納するリポジトリです。 ADR-008 に基づき、「答え」や完成形の services コードを public な本体 repo に置かないアーキテクチャの片割れにあたります。

## 構造

```
problems/
├── battles/
│   └── <id>/
│       ├── metadata.json
│       ├── template.yaml
│       └── services/        # 答え相当のコード (microservice-migration-battle 等)
└── challenges/
    └── <id>/
        ├── metadata.json
        └── template.yaml
.github/workflows/
├── publish.yml              # main push で問題 zip を S3 にアップロード
└── catalog-pr.yml           # metadata 変更を本体 repo に PR で同期
```

## 配信フロー

1. contributor が `problems/<category>/<id>/` 配下を更新して main にマージ
2. `publish.yml` が AWS OIDC で AssumeRole → 該当問題を zip 化 → `s3://tc-challenges-${env}/<problemId>/<gitSha>.zip` にアップロード
3. `catalog-pr.yml` が metadata diff を検知 → 本体 repo に `bot/catalog-sync-YYYYMMDD` ブランチで PR
4. 本体 repo の Worker Lambda が `metadata.visibility === "private"` の deploy 要求を受けたとき、 S3 から 15min TTL presigned URL を発行 → CodeBuild が `CHALLENGE_PAYLOAD_URL` を fetch して deploy

## セットアップ (一度だけ)

1. AWS account に `ChallengePayloadStack` (= S3 bucket + lifecycle) を deploy (Issue #642 で別管理)
2. 本 repo に `oidc-iam-trust.template.yaml` を CloudFormation で deploy → 出力 Role ARN を取得
3. 本 repo の Settings → Secrets and variables → Actions に bind:
   - `AWS_CHALLENGE_PUBLISH_ROLE_ARN` = 上記 Role ARN
   - `TENKACLOUD_CATALOG_BOT_TOKEN` = 本体 repo に PR を作るための PAT (scope=repo) または GitHub App token

## 新しい問題を追加するとき

1. `problems/<category>/<id>/metadata.json` を ADR-012 schema (= 本体 repo の `problems/SCHEMA.json`) に準拠して書く
2. `metadata.visibility` を `"private"` に
3. `template.yaml` (CFn ペライチ) を書く
4. 必要なら `services/` などの内部ディレクトリを追加 (= 答え相当のコード)
5. PR レビュー後 main にマージ → 自動で S3 publish + 本体 repo catalog PR

## 既存問題の private 化

本体 repo にすでにある問題 (例: `microservice-migration-battle`) を private 化する場合は次の順序で進めます。

1. 本 repo に dir をコピー (= `problems/battles/<id>/` まるごと)
2. 本体 repo 側で `services/` 等の答え相当ディレクトリを削除
3. 本体 repo 側の `metadata.json` の `visibility` を `"private"` に変更
4. 本 repo にコミット → 自動同期で `problems/index.json` 更新

## 関連

- 本体 repo: <https://github.com/susumutomita/TenkaCloud>
- ADR-008 = 問題ペイロード分離アーキテクチャ
- Issue #643 = 本 repo bootstrap
- Issue #642 = Worker Lambda S3 fetch 経路
