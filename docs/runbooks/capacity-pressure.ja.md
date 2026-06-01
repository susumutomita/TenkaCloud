# Capacity pressure & throttling response

> English: [capacity-pressure.md](./capacity-pressure.md)

| 属性 | 値 |
|---|---|
| Audience | オンコールオペレータ (= Free Tier / 容量逼迫アラームを受け取る人) |
| 使うタイミング | `tenkacloud-freetier-*` / `tenkacloud-health-*` アラーム、 または CostBudget の 80％ / 100％ 通知を受けたとき |
| 所要時間 | 1 アラームあたり 5〜15 分の triage。 スケールアップ判断を伴う場合はそれ以上 |
| 出力 | 「観測した数値」 / 「分類 (誤検知 / 一時的 / 要対応)」 / 「打ち手 (何もしない含む)」 をイベントタイムラインに 1 ライン記録 |

[`free-tier-alarms.ts`](../../infrastructure/lib/observability/free-tier-alarms.ts) と `CostBudget` は容量・コストの逼迫を **検知** する。 本 runbook はその **応答側** を定義する。 アラームは「動け」ではなく「観測して分類しろ」の合図であり、 圧力下で慌ててスケールすると Free Tier を抜けて無用なコストを生む。 [live-monitoring](./live-monitoring.ja.md) と同じく、 **観測 → 分類 → (必要なら) 行動** の順を守る。

## アラームカタログ

| アラーム名 | 意味 | デフォルトしきい値 | 主因の候補 |
|---|---|---|---|
| `tenkacloud-freetier-lambda-<fn>` | Lambda の日次 invocations が Free Tier (1M/月) の 80％ 相当を超過 | 26,666 / 日 | polling 暴走 / retry ループ / 想定超の参加者数 |
| `tenkacloud-health-lambda-errors-<fn>` | Lambda の日次エラー件数が超過 | 50 / 日 | deploy 失敗 / 権限不足 / 依存先の異常 |
| `tenkacloud-health-apigw-5xx-<api>` | API Gateway の日次 5XX が超過 | 50 / 日 | backend Lambda の例外 / timeout |
| `tenkacloud-freetier-ddb-read-<table>` | テーブルの日次 ConsumedReadCapacityUnits 超過 | 100,000 / 日 | 1 RCU 上限への read 集中 (= throttle 圏) |
| `tenkacloud-freetier-ddb-write-<table>` | テーブルの日次 ConsumedWriteCapacityUnits 超過 | 100,000 / 日 | 1 WCU 上限への write 集中 (= throttle 圏) |
| CostBudget 80％ / 100% | 月次コストが上限の 80％ / 100％ に到達 (SNS email) | 月次予算 | Free Tier 超過リソースの発生 |

しきい値はいずれも CDK props (`lambdaDailyInvocationThreshold` 等) で環境ごとに上書きできる。 デフォルト値の根拠はソースの定数コメントを参照する。

## triage 手順

1. **観測**: アラーム名から対象 (Lambda / API / テーブル) を特定し、 CloudWatch のメトリクスと [`ObservabilityStack`](../../infrastructure/lib/observability/) のダッシュボードで直近の推移を見る。 スパイクか、 右肩上がりの持続かを区別する。
2. **分類**:
   - **誤検知 / 一時的**: 単発スパイクで既に収束 → 記録のみ、 行動しない。
   - **想定内の負荷**: 参加者増による正常な増加 → スケール判断 (下記) に進む。
   - **異常**: retry ループ / エラー連鎖 / 1 チームからの異常リクエスト → 原因を止める ([incident-response](./incident-response.ja.md) と併用)。
3. **行動**: 分類が確定してから、 必要な打ち手のみを実施する。

## アラーム別の応答

### DynamoDB capacity (`tenkacloud-freetier-ddb-read/write-*`)

`DynamoDbLowCapacity` Aspect が全テーブルを **PROVISIONED 1 RCU / 1 WCU** に固定している (Free Tier 25/25 内に収めるため)。 read/write が 1 ユニットの sustained 上限 (≒ 1 req/sec) を超えると DynamoDB が **throttle** する。 まず throttle が実害かどうかを次の基準で見極める。

- **read/write が SDK retry で吸収できている** (= ユーザー影響なし) → 何もしない。 throttle は設計上の節約挙動。
- **throttle で scoring tick / deploy が遅延している** (= ユーザー影響あり) → 対象テーブルのキャパシティを **意図的に** 引き上げる。

> ⚠️ 容量の引き上げは **現状マニュアル** である。 ランタイム可変キャパシティ ([#1431](https://github.com/susumutomita/TenkaCloud/issues/1431) の `[INFRA]` 子項目) は未実装。 現行の引き上げ手順は次のとおり。
>
> 1. `infrastructure/lib/cdk-aspect/` の `DynamoDbLowCapacity` 適用範囲を確認し、 対象テーブルを除外するか、 capacity を引き上げる設定変更を行う (owner レビュー必須)。
> 2. `make diff` で **PROVISIONED 値の変化のみ** であること (テーブル置換でないこと) を確認する。
> 3. 25 RCU/WCU の Free Tier を超える分は **課金される**。 CostBudget の残枠と引き換えに、 イベント期間だけ引き上げ、 teardown で 1/1 に戻す。

`PAY_PER_REQUEST` (オンデマンド) への切り替えは **禁止** (`DynamoDbLowCapacity` が阻止する。 コスト予測不能になるため)。

### Lambda invocations (`tenkacloud-freetier-lambda-*`)

月次 1M req の Free Tier に接近している。 まず **暴走でないか** を次の観点で確かめる。

- フロントの polling 周期が想定どおりか (SSE/WebSocket を使わず polling に寄せている分、 invocations は素直に参加者数 × 周期で効く)。
- EventBridge 駆動の reconciliation ([ADR-014](../architecture/adr-014-eventbridge-driven-state-reconciliation.html)) が過剰発火していないか。
- retry ストームが起きていないか (errors アラームと併発していないか)。

正常な参加者増なら、 invocations は線形なので **イベント終了で自然に収束** する。 行動は不要なことが多い。

### Lambda errors / API Gateway 5XX (`tenkacloud-health-*`)

容量ではなく **健全性** のアラーム。 CloudWatch Logs Insights を `jobId` 等でフィルタ ([deploy-trace](../operations/deploy-trace.md)) し、 例外内容を特定する。 deploy 系なら [incident-response](./incident-response.ja.md) に合流する。

### CostBudget 80％ / 100%

月次コストが上限に接近。 Cost Explorer でサービス別内訳を見て、 **Free Tier を抜けたリソース** を特定する (多くは上記 DDB キャパシティ引き上げの戻し忘れ、 または想定外のデータ転送)。 100％ 到達時は、 課金を止められる範囲で不要リソースを teardown する。

## エスカレーション

- ユーザー影響のある throttle / エラーが 15 分以上継続 → owner にエスカレーションし、 キャパシティ引き上げ (課金判断) の承認を得る。
- イベント終了後は、 引き上げたキャパシティを **必ず 1/1 に戻す** (戻し忘れが翌月コストの最大要因)。

## 関連

- [live-monitoring](./live-monitoring.ja.md) — イベント中の常時監視ループ
- [incident-response](./incident-response.ja.md) — インシデント分類と対応
- [`free-tier-alarms.ts`](../../infrastructure/lib/observability/free-tier-alarms.ts) — アラーム定義 (しきい値の正本)
- [#1431](https://github.com/susumutomita/TenkaCloud/issues/1431) — ランタイム可変キャパシティ (本 runbook が前提とする `[INFRA]` 子項目)
