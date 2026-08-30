# イベント中の DynamoDB キャパシティ運用 Runbook

Issue #2410。有料イベントで throttle を出さないために、イベント中だけキャパシティを上げ、終わったら下げるための運営手順。

## 前提 (プラットフォームの設計)

- 全テーブルは `DynamoDbLowCapacity` Aspect で PROVISIONED に固定され、値は**デプロイ時パラメータ**が決める (デフォルト 1 RCU / 1 WCU = アイドル時コスト最小)。lite pipeline (CFn ワンクリックデプロイ) では `DynamoReadCapacity` / `DynamoWriteCapacity` パラメータ (Issue 2679、デフォルト 1 / 上限 200) が、`.env` 直書きでは `CDK_PARAM_DYNAMODB_READ_CAPACITY` / `_WRITE_CAPACITY` がこの値になる。
- **オートスケーリングは採用しない**。サイレントにランプして課金が膨らむ経路を作らず、人手が介在する明示操作だけを許す。
- イベント中の一時変更は **SSM Automation Runbook** (`<stack 名>-event-capacity`) 経由で行う。bounded (上限 200) / logged (SSM 実行履歴) / deliberate (手動実行) の 3 点を構造化している。

### 2 つのノブの使い分け (デプロイ時 vs イベント中)

| ノブ | 対象 | 持続性 | 用途 |
| --- | --- | --- | --- |
| デプロイパラメータ (`DynamoReadCapacity` / `DynamoWriteCapacity`) | **全テーブル + 全 GSI** に同値 | 次の deploy まで恒久 (= standing cost) | イベント前に適切なベースラインで立てる本線 |
| SSM runbook (`<stack 名>-event-capacity`) | event-hot 5 テーブル (テーブルごとに指定) | 手動で戻すまで / **次の CFn UPDATE deploy で上書き** | イベント中の緊急増強・一時変更 |

**優先関係**: テーブルに CFn UPDATE が入る deploy は、SSM で上げた値を**デプロイパラメータの値に上書きして収斂させる**。イベント中に SSM で上げた状態のまま redeploy すると増強分が黙って消えるので、イベント期間中の deploy は避けるか、デプロイパラメータ側を同じ値にしてから行うこと。

### 課金爆死ガード (4 層)

1. **PROVISIONED のまま**。on-demand (PAY_PER_REQUEST) には切替えない。リクエストが激増しても throttle するだけで、青天井課金にならない。
2. **ハード上限 ceiling = 200 RCU/WCU**。runbook の parameter validation (`allowedPattern`) と script 内 assert の二重化。桁打ち間違い (例: 20 のつもりが 2000) は実行前に fail する。デプロイパラメータ側 (`DynamoReadCapacity` / `DynamoWriteCapacity`) も CFn の `MaxValue: 200` で同じ ceiling を張っている。
3. **手動実行のみ**。`StartAutomationExecution` は必ず SSM の実行履歴に残る (誰が・いつ・どのテーブルを・いくつに変えたか)。
4. **明示 scale-down**。イベント後に同じ runbook で戻す。CFn がテーブルを次に UPDATE する deploy では**デプロイパラメータの値 (デフォルト 1/1) に収斂する** (ただし template 差分がない deploy はテーブルに触らないため、**戻し忘れの保険にはならない**。イベント終了チェックリストに scale-down を入れること。デプロイパラメータを上げて運用している環境では「戻す先」もそのパラメータ値になる点に注意)。

## 対象テーブル (event-hot 5 テーブル)

runbook の `TableName` は以下の 5 テーブルに `allowedValues` + IAM resource の二重で固定されている。

| テーブル | 役割 | GSI 数 | 課金倍率 | イベント中の負荷源 |
| --- | --- | --- | --- | --- |
| Deployments | deploy ジョブ state | 3 | x4 | bulk deploy、参加者 portal の polling |
| Events | イベント定義 | 1 | x2 | 管理画面 / 採点 tick の read |
| Teams | チーム定義 | 2 | x3 | 参加者 login、採点 tick の read |
| ProblemEndpoints | endpoint registry | 0 | x1 | 参加者 portal の endpoint 解決 |
| Disruptions | Red Team 障害の audit | 1 | x2 | disruption fire / 採点 tick |

runbook は base table と全 GSI を**同じ値**に揃える (base だけ上げて GSI throttle で write が詰まる事故を防ぐ)。したがって**課金合計は「指定値 × (1 + GSI 数)」**になる — ceiling 200 は parameter 単位のガードであり、GSI 3 本の Deployments を 200 にすると課金は 800 RCU / 800 WCU 相当。runbook の実行結果 (`billedReadCapacityUnits` / `billedWriteCapacityUnits`) にこの合算値が出力される。

## いつ上げるか

判断材料は application-admin-console → イベント詳細 →「高度操作」tab の **DynamoDB キャパシティ panel** (30 秒 polling)。backend は `GET /admin/capacity` (TenantAdmin のみ) で、DescribeTable の現行プロビジョンと CloudWatch の直近 30 分の消費 / throttle を集計している。

| panel の表示 | 意味 | アクション |
| --- | --- | --- |
| `Throttle 発生` (赤) | 直近 window で throttle が実際に出た | **今すぐ上げる** (下の目安表の 1 段上へ) |
| `余裕なし` (黄) | throttle は無いがピーク消費がプロビジョンの 80％ 以上 | 上げる準備。イベントの山場 (開始直後 / 終了前) が近いなら先に上げる |
| `OK` (緑) | 余裕あり | 何もしない |

イベント開始の 30 分前に、規模の目安表どおりに**事前に**上げておくのが基本。throttle は participant 体験を直撃するので、出てから上げるのは最終手段。

同じ panel の「キャパシティを変更」action (Issue 2680) からも上げ下げできる。中身は下記 CLI と同一の SSM runbook (`StartAutomationExecution`) を `POST /admin/capacity` (TenantAdmin のみ) 経由で起動するだけなので、ceiling などのガードはそのまま効き、実行履歴も SSM に必ず残る。CLI での実行も従来どおり使える。

## 規模 → 目安

チーム数を N とした初期値の目安。迷ったら小さめに設定し、panel を見ながら上げる。

| 規模 | Deployments | Events | Teams | ProblemEndpoints | Disruptions |
| --- | --- | --- | --- | --- | --- |
| 練習会 (N ≤ 5) | 1 / 1 (据え置き) | 1 / 1 | 1 / 1 | 1 / 1 | 1 / 1 |
| 小規模 (N ≤ 15) | 10 / 5 | 5 / 2 | 5 / 2 | 5 / 2 | 2 / 2 |
| 中規模 (N ≤ 40) | 25 / 10 | 10 / 5 | 10 / 5 | 10 / 5 | 5 / 5 |
| 大規模 (N ≤ 100) | 50 / 25 | 25 / 10 | 25 / 10 | 25 / 10 | 10 / 10 |

- read が支配的 (portal polling / 採点 tick)。write は bulk deploy と採点書き込みの瞬間に出る。
- bulk deploy 直前は Deployments の **write** を一時的に 1 段上げると安全 (750 行規模の一括 Put)。
- ceiling (200) に張り付いても足りない場合は、polling 間隔を伸ばす / イベントを分割する。ceiling 自体を上げる変更は課金ガードの再設計を伴うので、単独判断で行わない。
- 表の値は base table への指定値。課金は GSI 分を含む「指定値 × 課金倍率」で見積もる (中規模の合計は base 75 RCU / 30 WCU だが、課金は約 170 RCU / 80 WCU 相当)。

## 上げ方 (scale-up)

document 名は CFn output `EventCapacityRunbookName` (= `<stack 名>-event-capacity`)。panel の footer にも実行コマンド例が表示される。

```bash
# 例: Deployments を 25 RCU / 10 WCU に上げる (base + 全 GSI)
aws ssm start-automation-execution \
  --document-name <EventCapacityRunbookName> \
  --parameters TableName=<Deployments テーブル名>,ReadCapacityUnits=25,WriteCapacityUnits=10

# 実行状態の確認
aws ssm describe-automation-executions \
  --filters Key=DocumentNamePrefix,Values=<EventCapacityRunbookName>
```

- 変更が不要 (すでに指定値) なら runbook は何も変更せず `already at requested capacity` を返す (再実行安全)。
- 201 以上を指定すると parameter validation で即 fail する (実行履歴にも乗らない)。
- テーブルごとに 1 実行。5 テーブル上げるなら 5 回実行する。

## 下げ方 (scale-down)

イベント終了チェックリストに入れること。**上げたら必ず戻す**。

```bash
# 全 event-hot テーブルを 1/1 に戻す
for table in <5 テーブル名>; do
  aws ssm start-automation-execution \
    --document-name <EventCapacityRunbookName> \
    --parameters TableName=$table,ReadCapacityUnits=1,WriteCapacityUnits=1
done
```

注意: DynamoDB の仕様で **scale-down はテーブルごとに 1 日あたり回数制限がある** (最初の 1 時間で 4 回 + 以降 1 時間ごとに 1 回回復)。scale-up は無制限。細かく下げ直すより、イベント終了後に一発で 1/1 に戻すのが安全。

## コスト感覚

ap-northeast-1 の provisioned スループットは 1 RCU ≒ 0.000142 USD/h、1 WCU ≒ 0.000742 USD/h。中規模イベント (課金合計 ≒ 170 RCU / 80 WCU、GSI 分込み) を 8 時間動かしても 1 USD 未満。**戻し忘れて 1 か月放置**すると中規模で 60 USD 前後、ceiling 張り付き (Deployments 200 = 課金 800/800) なら 500 USD 超になるので、ガードは「上げ幅」ではなく「戻し忘れ」に対して張る。

## 権限

- runbook の automation role は event-hot 5 テーブルへの `dynamodb:DescribeTable` / `dynamodb:UpdateTable` のみ (最小権限)。他テーブルには IAM 的にも適用できない。
- **実行する運営側の IAM** には `ssm:StartAutomationExecution` (対象 document) と、automation role を渡すための `iam:PassRole` (対象 = `EventCapacityRunbookName` と同 stack の AutomationRole) が必要。platform を deploy した AdministratorAccess 相当ならそのまま実行できる。least-privilege な運営ユーザーを切る場合はこの 2 権限を付与する。
- 監視 API (`GET /admin/capacity`) は TenantAdmin のみ。read-only で、Lambda 側の IAM も DescribeTable + `cloudwatch:GetMetricData` に限定している。
