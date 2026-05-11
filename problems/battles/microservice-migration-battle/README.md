# Microservice Migration Battle

> EC2 1 台に同居する 3 サービス (`users` / `orders` / `catalog`) を、競技時間内に Lambda + API Gateway / Amazon ECS (Fargate) / AWS App Runner の 3 種の異なるホスティングに分割していく Battle 問題。

## あらすじ

あなたは EC2 1 台に同居している 3 つのサービス (`users` / `orders` / `catalog`) を運用するスタートアップの SRE。EC2 はそろそろ劣化し始めており、レガシーから抜け出さないと顧客への応答が遅くなりポイントが激減する。競技時間内に各サービスを別々のホスティングに切り出し、可用性とスコアを守れ。

## 学習目的

- モノリスからマイクロサービスへの段階的移行 (strangler fig パターン) を体験する
- Lambda + API Gateway / Amazon ECS (Fargate) / AWS App Runner のトレードオフを比較する
- スコアが時間経過で劣化する制約下で、優先順位を判断する経験を積む
- コードを読み解いて意図的に仕込まれた遅延処理を取り除き、再デプロイで復旧する経験を積む

## 競技フロー

1. **deploy 完了**: 運営側が競技者アカウントに本問題を deploy する。EC2 1 台に 3 サービスが docker compose で起動し、`http://<ec2>/users/score` `/orders/score` `/catalog/score` が払い出される。
2. **登録フェーズ**: 競技者は participant-portal で **3 つのスコア対象 endpoint URL** を登録する (初期は空)。
3. **採点フェーズ**: 運営側スコアエンジンが **1 分毎** に各登録 endpoint を polling し、レスポンス内容に応じてスコアを加減算する。
4. **EC2 劣化フェーズ** (= デフォルト競技開始 60 分後 / イベントパラメータで変更可): EC2 上の 3 サービスが劣化し、EC2 採点値が大幅減。
5. **遅延 endpoint 切替フェーズ** (= デフォルト 90 分後 / 同じくパラメータ): スコアエンジンが checks する path を `/score` から **コード内に仕込まれた legacy endpoint** に切り替える。参加者はコードを読み解き、遅延の原因を取り除いて再デプロイする必要がある。

## 提供される URL (deploy 完了後)

| 名前 | URL 例 | 用途 |
|------|--------|------|
| `FrontendUrl` | `http://<public-dns>/` | nginx の入り口 |
| `UsersEndpoint` | `http://<public-dns>/users/score` | users サービスのスコア endpoint |
| `OrdersEndpoint` | `http://<public-dns>/orders/score` | orders サービスのスコア endpoint |
| `CatalogEndpoint` | `http://<public-dns>/catalog/score` | catalog サービスのスコア endpoint |
| `InstanceId` | `i-xxxxxxxx` | 運営側のデバッグ用 |

## 各サービスのインタフェース契約

3 サービスは共通で以下の HTTP endpoint を持つ。

| Method | Path | 用途 | レスポンス例 |
|--------|------|------|-------------|
| `GET` | `/health` | ヘルスチェック | `{"status": "ok"}` |
| `GET` | `/meta` | サービス情報 | `{"service": "users", "platform": "ec2", "version": "1.0.0"}` |
| `GET` | `/score` | スコア (= 高速経路) | `{"service": "users", "score": 87}` |
| `GET` | `/score?legacy=true` | スコア (= 旧経路 / **要修正**) | `{"service": "users", "score": 87}` (※遅い) |

### `platform` 値

`/meta` の `platform` field は次のいずれかを返す。スコアエンジンはこれをもとに加点係数を判定する。

- `ec2` — 初期状態 (この問題テンプレートが提供する状態)
- `lambda` — Lambda + API Gateway に移行済
- `ecs` — ECS Fargate に移行済
- `apprunner` — AWS App Runner に移行済

`platform` は環境変数 `TC_PLATFORM` で制御する。Lambda / ECS / App Runner に移植する際は、コンテナ env を `TC_PLATFORM=lambda` 等に設定すること。

## マイクロサービス化の指針

3 サービスを **異なる 3 種のホスティング** に分けることを推奨する。組み合わせは自由。

| ホスティング | 強み | 学べること |
|------------|------|-----------|
| **Lambda + API Gateway** | 関数粒度のスケール / cold start / event-driven | Serverless の運用感 |
| **ECS (Fargate)** | 長時間実行 / 永続接続 / VPC 統合 | コンテナオーケストレーションと ALB |
| **AWS App Runner** | URL 1 発で公開 / managed container | Lambda と ECS の中間、source-deploy |

## 攻略のコツ

- 早く分離するほど点数が伸びる設計
- 1 サービスでも分離できれば EC2 劣化フェーズの影響を逃せる
- 遅延 endpoint への切替は事前告知される (Battle Portal の timeline 参照) — 切替前にコード修正を完了させておくと点数を維持できる
- 答えは 1 つではない。3 サービスをすべて Lambda にしても良いし、混在でも良い

## ローカルでの動作確認 (= 寄稿者向け)

```bash
cd services
docker compose up --build
curl http://localhost/users/score
curl http://localhost/orders/meta
curl 'http://localhost/catalog/score?legacy=true'  # 約 2 秒遅延
```

## 参考リンク

- [AWS Lambda](https://aws.amazon.com/lambda/) / [API Gateway HTTP API](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api.html)
- [Amazon ECS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)
- [AWS App Runner](https://docs.aws.amazon.com/apprunner/latest/dg/what-is-apprunner.html)
- [Strangler Fig pattern (Martin Fowler)](https://martinfowler.com/bliki/StranglerFigApplication.html)

## 関連 Issue

- 設計 Issue: 本問題の動機と詳細設計
- ADR-008 v2: 問題カタログを Community Contribution Registry にする (= 本問題は寄稿問題第 1 号として位置づけ)
