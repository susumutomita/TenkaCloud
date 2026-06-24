# Lite mode イベント・リハーサル runbook

Lite mode で「1 運営者が 6〜10 チームのイベントを最短で安全に運営する」ための、**本番前リハーサル契約**。第三者でも同じ基準で実行・評価できるよう、イベント開始から teardown まで（正常系 + 失敗系）を通しで確認し、運営者が詰まる点とコストを観測する。

機能の使い方そのものは [`docs/deployment/README.md`](../deployment/README.md)（Lite デプロイ手順）と各運用 doc を参照。本 doc は「**何をもってイベント準備完了とするか**」を判定するためのチェックリスト + メトリクス記録テンプレート。

> このリハーサルは [Issue #2018](https://github.com/susumutomita/TenkaCloud/issues/2018) の運用契約。SaaS mode のマルチテナント運用・新規採点種別の追加は非スコープ。

## 前提

| 項目 | 値 |
|---|---|
| 対象モード | Lite mode（`make deploy` で `tenkacloud-lite` + `tenkacloud-lite-problem-deploy` の 2 stack） |
| 想定規模 | 6〜10 チーム × 1〜数問 |
| 必要なもの | 専用の AWS account（リハーサル後に `make destroy` で全消去できる空アカウント推奨）、`TENANT_ADMIN_EMAIL`、participant 役の検証用ブラウザ |
| 所要時間の目安 | 初回 deploy ~10 分 + 通し確認 30〜60 分 + teardown ~10 分 |
| コスト | DynamoDB は Aspect で 1/1 PROVISIONED 固定。Lambda + S3 + CloudFront は無料枠内が前提（実測を本 runbook で記録する） |

## ライフサイクル・チェックリスト

各項目は **判定基準（合格条件）** を持つ。1 つでも未達ならイベント準備は未完了とみなす。

### 1. 初期セットアップ・管理者サインイン

- [ ] `infrastructure/environments/development/.env` に `TENANT_ADMIN_EMAIL` 等を設定（未設定なら `make env-init`）。
- [ ] `make deploy`（Lite）が 2 stack を deploy して成功（CDK 出力に CREATE_COMPLETE）。
- [ ] `make lite-console-url` で Application Admin Console URL、`make lite-portal-url` で Participant Portal URL を取得できる。
- [ ] Console に管理者がサインインでき、Home 画面が表示される。
- **判定**: 初回 deploy が成功し、Console と Portal の URL が解決できる。

### 2. イベント作成・問題選択・チーム登録

- [ ] Console でイベントを 1 件作成（開始/終了時刻、採点ウィンドウ）。
- [ ] 問題を 1 問以上選択（catalog から）。
- [ ] 6〜10 チームを登録し、各チームの参加者ログインキーを発行できる。
- **判定**: イベント・問題・全チームが Console 上で揃い、各チームのログインキーが配布可能。

### 3. 正常な一括デプロイ

- [ ] 全チーム × 全問題の bulk deploy を発火。
- [ ] 各 deployment が `COMPLETE` に到達（Console の Jobs / Deployments で確認、または `make ops-health`）。
- [ ] 競技アカウント側に問題スタックが作成されている。
- **判定**: 全チーム分の deploy が成功し、`make ops-health` が exit 0（healthy）。

### 4. 失敗デプロイと再試行（最低 1 件）

- [ ] 意図的に 1 件を失敗させる（例: 一時的に不正な template / 権限不足を作る、または失敗が起きた実例を使う）。
- [ ] 失敗が Console / Jobs に `FAILED` として可視化され、原因が deploy log から追える。
- [ ] 当該チームを再デプロイして `COMPLETE` に復旧できる。
- **判定**: 失敗が検知・可視化され、再試行で復旧できる（= 当日の失敗を運営者が独力で回復できる）。

### 5. 参加者フロー（ログイン → ヒント → 提出 → スコア → Console federation）

- [ ] 参加者が Portal にログインキーでログインできる。
- [ ] 問題文・フェーズ・ヒントが表示され、ヒント開封でスコアに反映される。
- [ ] flag 提出が採点され、スコア・score-events に反映される。
- [ ] 参加者が AWS Console federation（SSO Credentials）で自チームの AWS Console / CloudShell に入れる。
- **判定**: 1 チームが「ログイン → 解く → 採点 → 自分の AWS を触る」まで一通り通る。

### 6. イベント終了・teardown・残存確認

- [ ] イベントを終了（採点ウィンドウ close）。
- [ ] bulk teardown（または `make destroy`）で問題スタック + Lite stack を削除。
- [ ] 競技アカウント・運営アカウントに**残存リソース**（孤立 stack / S3 / log group）が無いことを確認。
- [ ] teardown 後の概算継続コストが 0 に近いことを確認。
- **判定**: 全リソースが消え、teardown 後の残存コストがほぼ 0。

## 記録するメトリクス

| メトリクス | 取得方法 | 自動/手動 |
|---|---|---|
| 初回 deploy 完了までの時間 | `make ops-metrics TABLE=<DeploymentsTable>` の `first-deploy wall-clock`（= 最初の `createdAt` → 最後の `COMPLETE` の `updatedAt`） | **自動** |
| 1 deploy あたりの所要時間 | 同上 `per-deploy duration`（COMPLETE 各行の `createdAt`→`updatedAt` の min/median/max） | **自動** |
| チーム単位の deploy 成功率 | 同上 `deploy success rate`（COMPLETE / (COMPLETE+FAILED)）+ status 内訳 | **自動** |
| 失敗からの復旧時間 | `FAILED` 検知 〜 再試行 `COMPLETE` の経過 | 手動 |
| 運営者の介入回数・理由 | リハーサル中の手動操作（再試行 / 設定修正 等）を都度記録 | 手動 |
| 参加者が開始までに要した時間 | ログインキー配布 〜 最初の有効アクション（ヒント/提出）まで | 手動（必要なら score-events の最初の occurredAt） |
| 概算 AWS コスト | AWS Cost Explorer の `user:Project$TenkaCloud` tag filter（全リソースに付与済み） | 半自動（Billing console、反映に最大 24h） |
| teardown 後の残存コスト | teardown 翌日の同 tag filter | 半自動 |

> **自動集計**: `make ops-metrics TABLE=<DeploymentsTableName>`（`make lite-status` / CFn outputs で table 名を確認）が Deployments table を scan し、**status 内訳 / deploy 成功率 / per-deploy 所要時間 / 初回 deploy wall-clock** を 1 コマンドで出力する（read-only）。`make ops-health` は全体健全性（healthy=0 / in_progress=1 / failed=2）、`make lite-status` は stack 状態。上表の「自動」3 行はこれで埋まり、残りの手動メトリクスは下のテンプレートに記録する。

## 記録テンプレート（1 回の実施ごとにコピーして埋める）

```markdown
## リハーサル記録 — <YYYY-MM-DD> / 実施者 <name> / env <account-id>

| 区分 | 結果 |
|---|---|
| チーム数 / 問題数 | N / M |
| 初回 deploy 完了時間 | __ 分 __ 秒 |
| deploy 成功率（初回） | __ / __（__%） |
| 失敗 → 復旧時間 | __ 分（失敗 N 件） |
| 運営者介入回数 | __ 回 |
| 介入理由（箇条書き） | - |
| 参加者開始所要時間（中央値/最大） | __ / __ |
| 概算 AWS コスト（実施日） | $__ |
| teardown 後残存コスト | $__ |

### チェックリスト結果
- [ ] 1 初期セットアップ・管理者サインイン
- [ ] 2 イベント作成・問題選択・チーム登録
- [ ] 3 正常な一括デプロイ
- [ ] 4 失敗デプロイと再試行
- [ ] 5 参加者フロー（ログイン→ヒント→提出→スコア→federation）
- [ ] 6 終了・teardown・残存確認

### 発見事項 / 詰まった点 / 改善 TODO
- 
```

## 準備完了の判定（runbook だけで判断できること）

次がすべて満たされたとき、Lite mode でのイベント準備は**完了**とみなす。

1. 上記チェックリスト 1〜6 の全判定が合格（正常系 + 失敗系の両方）。
2. 記録テンプレートに 1 回分の実測が残っている。
3. teardown 後の残存リソース・残存コストがほぼ 0。
4. 発見事項が記録され、当日の運営者がブロッカーなく回せる見通しがある。

## 参考

- [Lite デプロイ手順（`docs/deployment/README.md`）](../deployment/README.md)
- [デプロイ trace の追い方](./deploy-trace.md) / [Observability](./observability.md) / [Notifications](./notifications.md)
- `make help` の `lite-*` / `ops-health` ターゲット
