# インシデント対応

> English: [incident-response.md](./incident-response.md)

| 属性 | 値 |
|---|---|
| Audience | オンコールオペレータ (= 進行中のインシデントを triage する人) |
| 使うタイミング | [live monitoring](./live-monitoring.ja.md) からここへ送られたとき、 または参加者報告が 1 分以内に解決できないとき |
| 所要時間 | 1 件あたり 5 〜 30 分 |
| 出力 | インシデントが解決されアクション記録が残るか、 理由を明文化したうえでエスカレーションするか |

ホスト型イベントで頻出する 4 種のインシデントを取り上げます。 各セクションは **症状 → 1st response → 安全な remediation → エスカレーション** の同型構造です。 即興しないこと、 該当節を選んでなぞること。

> **動く前に**。 [live monitoring の event timeline](./live-monitoring.ja.md#%E3%82%A4%E3%83%99%E3%83%B3%E3%83%88%E3%82%BF%E3%82%A4%E3%83%A0%E3%83%A9%E3%82%A4%E3%83%B3%E3%81%AE%E8%A8%98%E9%8C%B2) に観測ラインを 1 行追記する。 観測なしの行動が、 オペレータが outage を悪化させる典型経路。

## セクション 1: Lambda エラー

### 症状

- CloudWatch で deploy worker / scoring Lambda / API handler のいずれかにエラー率が出ている。
- オペレータダッシュボードで deployment が `IN_PROGRESS` のまま、 または scoring loop が止まっている。
- 参加者から「scoreboard が古い」「deploy が終わらない」報告。

### 1st response (5 分以内)

1. どの Lambda がエラーかを確定。 CloudWatch を関数名でフィルタ。
2. 最新エラーログを読む。 stack trace / エラークラス / タイムスタンプを確認。
3. 分類する: AWS 由来の transient (throttling / timeout / networking) か、 コード由来 (TypeError / デシリアライゼーション失敗) か。

### 安全な remediation

| エラークラス | アクション |
|---|---|
| AWS 由来 transient (rate limit / timeout / DNS) | 2 分待つ。 大半は retry で解消。 参加者が気づいたなら `info` 通知。 |
| Cold-start のレイテンシだけ | 何もしない。 レイテンシはインシデントではない。 [live monitoring](./live-monitoring.ja.md) を継続。 |
| コード由来 (TypeError / schema validation) | ログをタイムラインにキャプチャ。 イベント中のコードパッチは禁止 (= ライブ中のプラットフォーム再 deploy 禁止)。 影響範囲をメモして継続。 |
| AssumeRole の `AccessDenied` が反復 | そのチームの ExternalId が誤り。 Tenant metadata を確認し、 認証情報を再発行。 |

### エスカレーション

- 5 件/分超のエラーが 5 分続いたら `warning` 通知を送り、 facilitator に共有。
- 全チームに影響していれば plat-wide インシデント。 解決まで scoring 停止を検討。

## セクション 2: DynamoDB throttling

### 症状 (DynamoDB throttling)

- CloudWatch DynamoDB の `UserErrors` または `ThrottledRequests` が非ゼロ。
- Participant portal の scoreboard が遅い / 散発的にエラー。
- オペレータダッシュボードで event 時刻と scoreboard 時刻の lag が拡大。

### 1st response (5 分以内) — DynamoDB throttling

1. Throttle されているテーブル (`Deployments` / `Apps` / `Events` / `TenantMappingTable` 等) を特定。
2. Capacity 設定を確認。 TenkaCloud は AWS Free Tier 安全のため [`DynamoDbLowCapacity`](../../infrastructure/lib/cdk-aspect) aspect で全テーブルを PROVISIONED 1 RCU / 1 WCU に強制している。
3. 原因が participant traffic (正当) か runaway Lambda (インシデント) かを切り分け。

### 安全な remediation — DynamoDB throttling

| 原因 | アクション |
|---|---|
| イベントスパイクによる正当な burst | 「scoreboard 更新が遅れる可能性」と `info` 通知を送り、 burst が収まるのを待つ。 Free Tier ガードレールに紐づく決定をすべて再議論しない限り、 イベント中に capacity を上げない。 |
| Runaway Lambda の hot loop | 発火源の Lambda invocation を止める。 EventBridge rule の誤設定でループしているケースが多い。 |
| オペレータ起因の scan / list | Scan を止める。 オペレータクエリは特定キー検索に限定する。 |

> テーブルを `PAY_PER_REQUEST` に切り替えてはいけない。 Aspect が PROVISIONED 1/1 を強制しており、 モード切替には CDK 変更が必要 (= inline 禁止)。

### エスカレーション — DynamoDB throttling

- 10 分で throttle が解消しなければ scoring を一時停止し、 系統的データ欠落の前に `warning` を送る。
- テーブル名と原因をタイムラインに記録、 事後レビューへ。

## セクション 3: Cognito sign in 失敗

### 症状 (Cognito sign in 失敗)

- 参加者から participant portal にログインできない報告。
- Application Admin Console の SSO ログイン失敗。
- CloudWatch に Cognito Hosted UI のエラー。

### 1st response (5 分以内) — Cognito sign in 失敗

1. 範囲を確定: 参加者 1 名 / 1 チーム / 全員。
2. 1 名の場合: Cookie 削除して再試行を依頼。 participant portal URL の末尾空白を確認。
3. 1 チームの場合: チーム metadata の配線を確認。 SSO IdP 構成も併せて確認。
4. 全員の場合: プラットフォーム障害。 セクション 4 または Lambda エラーセクションとして扱う。

### 安全な remediation — Cognito sign in 失敗

| 失敗モード | アクション |
|---|---|
| Login key の typo / 末尾空白 | [participant onboarding](./participant-onboarding.ja.md) の合意チャネルで正しい key を再送。 |
| Cognito Hosted UI の 5xx | 60 秒待って再試行。 大半は transient。 |
| OAuth callback URL の不一致 | Deploy 後に participant portal URL が変わっている。 Cognito callback URL が現行 CloudFront URL と一致するか確認。 修正は再 deploy が正規路。 手動で Cognito を弄らない。 |
| SAML IdP の assertion 拒否 | IdP 側ログを先に確認。 [`docs/operations/application-plane-saml-setup.md`](../operations/application-plane-saml-setup.md) を参照。 |
| アカウントロック | Cognito は反復失敗でロックする。 15 分待つか AWS Console から解除。 |

### エスカレーション — Cognito sign in 失敗

- 複数チームがログイン不可なら、 イベント進行を保留し `warning` を送ってから次手を発表。
- Callback URL ミスは deploy 時バグ。 ライブで直さない。 [Teardown](./teardown.ja.md) で復旧フェーズへ。

## セクション 4: CloudFormation スタック ROLLBACK

### 症状 (CFn スタック ROLLBACK)

- オペレータダッシュボード / チームアカウントで 1 つ以上のスタックが `CREATE_FAILED` / `ROLLBACK_IN_PROGRESS` / `ROLLBACK_COMPLETE`。
- 参加者から endpoint 不通の報告。
- Deploy trace に `deploy.cfn.deploy.failed`。

### 1st response (5 分以内) — CFn スタック ROLLBACK

1. 失敗 stack と CFn event から失敗理由を特定。
2. 失敗を分類:
   - **Quota** (アカウントレベル上限。 VPC / EIP / Lambda 等)
   - **Region 制約** (該当 region でサービス未提供)
   - **IAM** (AssumeRole 経路の権限不足。 ExternalId 関連が多い)
   - **テンプレート不具合** (問題テンプレートのバグ。 本来 [Dry run](./dry-run.ja.md) で検出されるべきもの)

### 安全な remediation — CFn スタック ROLLBACK

| 失敗クラス | アクション |
|---|---|
| Quota | Quota 緩和申請、 または問題が許すなら別 region に変更。 手動でリソースを補充して回避しない。 |
| Region 制約 | 当該チームの問題を落とすか、 region を変更 (= 単一 region 変更が問題テンプレート的に安全な場合のみ)。 |
| IAM | ExternalId / `competitor-bootstrap.yaml` IAM role の展開 / participant viewer role の policy を確認。 チームアカウントへの AssumeRole は ExternalId 必須 = ハード不変 ([CLAUDE.md](../../CLAUDE.md) の Security 節)。 |
| テンプレート不具合 | ライブパッチ禁止。 当該チームの当該問題を落とし、 `warning` を送り、 事後修正用にキャプチャ。 |

### 安全な再 deploy

[live monitoring](./live-monitoring.ja.md) の triage を経て、 単独チーム再 deploy と決めた場合に限り、 次の順序で実施する。

1. 先に失敗スタックの teardown を発行 (`scripts/delete-battles.sh` または Application Admin Console の teardown action)。 `DELETE_COMPLETE` を確認してから再作成。
2. オペレータ UI から `DeployRequested` を再発行。
3. 新しい `jobId` で deploy trace を観察。 `deploy.cfn.deploy.succeeded` が出るまで完了宣言しない。

### エスカレーション — CFn スタック ROLLBACK

- 複数チームが同原因で同時失敗 → プラットフォーム全体扱い。 Scoring 停止 / `warning` 送信 / 原因理解までは redeploy 禁止。
- ROLLBACK で残存リソースがあれば、 [Teardown](./teardown.ja.md) で扱う。

## インシデント後の共通ステップ

各インシデントの解決後、 次を必ず実施する。

1. タイムラインに最終エントリを追記 (observed / acted / resolved)。
2. `info` を 1 件送信し、「問題は解消した。 scoring は HH:MM 時点で最新」と明示する。
3. 原因 / アクション / コードレベル follow up を記述した post-event issue を起票。
4. Orphan リソース / scoring 状態が不明瞭なら、 [Teardown](./teardown.ja.md) に持ち越して処理。

## 関連 runbook / ADR

- 併用: [live monitoring](./live-monitoring.ja.md) — インシデントは常に live monitoring 観測から始まる。
- イベント後: [Teardown](./teardown.ja.md) — インシデントが残した orphan リソースはここで復旧。
- 背景: [ADR-006: Notifications](../architecture/adr-006-notifications.html) (通知は編集不可なので文言が重要) / [ADR-014: EventBridge 駆動 state reconciliation](../architecture/adr-014-eventbridge-driven-state-reconciliation.html) (状態が非同期に収束する理由) / [`docs/operations/deploy-trace.md`](../operations/deploy-trace.md) (インシデント時の jobId tracing)。
