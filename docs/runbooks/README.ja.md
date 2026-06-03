# イベント当日運用 Runbook 集

> English: [README.md](./README.md)

このディレクトリは、 メンテナの記憶に頼らずに小規模 TenkaCloud イベントを一気通貫で運用するための、 オペレータ向け playbook です。 各 runbook は self-contained で、 Audience / When to use / Step-by-step + 所要時間 /「うまくいかなかったら」のブランチを必ず備えています。

Runbook 全体は Lite mode (`make deploy`) をデフォルトとしています。 有償ホスト型イベントの大半は 1 オペレータ / 1 イベントだからです。 SaaS mode の差分は本文中に inline で記載します。

## 一覧

| # | Runbook | Audience | 使うタイミング | 所要時間 |
|---|---|---|---|---|
| 1 | [事前チェックリスト](./pre-event-checklist.ja.md) | Facilitator | T-7 / T-1 / T-0 の 3 段階準備 | 各 30 分 × 3 回 |
| 2 | [Dry run](./dry-run.ja.md) | オペレータ | 本番 7 日前までに必ず実施 | 90 分 |
| 3 | [Participant onboarding](./participant-onboarding.ja.md) | Facilitator | イベント当日朝、 kickoff 直前 | 20 分 |
| 4 | [Live monitoring](./live-monitoring.ja.md) | オンコールオペレータ | イベント実施中ずっと | 継続 |
| 5 | [インシデント対応](./incident-response.ja.md) | オンコールオペレータ | アラートまたは参加者報告から | 1 件あたり 5 〜 30 分 |
| 6 | [Teardown](./teardown.ja.md) | オペレータ | イベント終了から 24 時間以内 | 60 分 |
| 7 | [マルチクラウドプロバイダ](./multi-cloud-providers.ja.md) | オペレータ | セットアップ — 問題が Sakura / Azure / GCP を対象とする場合のみ、 deploy 前 | チーム × provider ごとに 20 分 |

## Runbook 同士の相互参照

- [事前チェックリスト](./pre-event-checklist.ja.md) は [Dry run](./dry-run.ja.md) を T-7 のゲートとしてリンクする (=「dry run はスキップ不可」)。
- [Live monitoring](./live-monitoring.ja.md) は triage 判断ポイントで [インシデント対応](./incident-response.ja.md) にリンクする。
- [インシデント対応](./incident-response.ja.md) と [Teardown](./teardown.ja.md) はどちらも [Live monitoring](./live-monitoring.ja.md) にバックリンクして、 すでに観測したものを文脈に持ち込む。
- [マルチクラウドプロバイダ](./multi-cloud-providers.ja.md) はイベント当日でなくセットアップ runbook で、 非 AWS 問題を deploy する前にチームごとに実施する。 provider 別の `destroy` は [Teardown](./teardown.ja.md) に集約される。
- すべての runbook は設計判断の正本として下記の ADR を参照する。
  - [ADR-006: Notifications](../architecture/adr-006-notifications.html) — オペレータから参加者への通知契約。
  - [ADR-014: EventBridge 駆動 state reconciliation](../architecture/adr-014-eventbridge-driven-state-reconciliation.html) — SSE / WebSocket を使わずに状態を収束させる仕組み。

## スコープ外

- 自動検知 / 自動 rollback コード (= #1352 で別途追跡)。 本 runbook 群は **オペレータの手動アクション** に限定する。
- 事後アンケート / コマーシャル follow up テンプレート (= 親 epic #1336 側で扱う)。

## 初任オペレータの読み順

1. [事前チェックリスト](./pre-event-checklist.ja.md) を一度通読し、 T-7 / T-1 / T-0 のリマインダーをカレンダーに入れる。
2. [Dry run](./dry-run.ja.md) を最低 1 回実施する。 dry run はゲートであって本番ではない。
3. [Live monitoring](./live-monitoring.ja.md) と [インシデント対応](./incident-response.ja.md) をブラウザの隣接タブにブックマーク。 本番中はこの 2 枚だけ開いておく。
4. [Teardown](./teardown.ja.md) は前日に目を通し、 終了後に手が止まらないようにする。
