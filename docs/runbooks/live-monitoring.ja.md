# Live monitoring

> English: [live-monitoring.md](./live-monitoring.md)

| 属性 | 値 |
|---|---|
| Audience | オンコールオペレータ (= イベント中にプラットフォームを健全に保つ人) |
| 使うタイミング | イベント開始から終了まで継続。 各 triage 判断で [インシデント対応](./incident-response.ja.md) と必ず併用。 |
| 所要時間 | 継続。 Scoreboard 用とダッシュボード用の 2 タブを常時開く想定 |
| 出力 | 「観測したもの」 / 「打ち手」 / 「Teardown に持ち越したもの」 を 1 ライン単位で記録したイベントタイムライン |

イベント中のオペレータの仕事は問題を直すことではなく、 **素早く観測し、 正確に分類し、 そのあとで初めて動く** ことです。 ライブプラットフォームで圧力下のもと打つアクションは、 事態を悪化させるリスクを持ちます。 このループを締めるための構造が本 runbook です。

## 常時開いておく 3 タブ

| タブ | URL | 何を見るか |
|---|---|---|
| Scoreboard | Participant portal の scoreboard ビュー | 急なスコア下落 / 0 点のまま動かないチーム / 異常なスパイク |
| オペレータダッシュボード | Application Admin Console の deploy / scoring ビュー | 詰まった deployment / scoring 遅延 / 通知配信 |
| Deploy trace | [`docs/operations/deploy-trace.md`](../operations/deploy-trace.md) の手順で `jobId` で CloudWatch Logs Insights をフィルタ | チーム別 deploy 失敗 / CFn rollback |

画面占有が 2 枚しか取れないなら、 オペレータダッシュボードを落として scoreboard + deploy trace を残す。 Scoreboard が参加者の体験で、 deploy trace がプラットフォームの真実だからです。

## 「健全」 とは

| シグナル | 健全状態 | 行動閾値 |
|---|---|---|
| チーム別 scoring tick | Polling 間隔ごとに更新 (uptime は 1 分ごと / flag は提出時) | 10 分間更新が無いチームがあれば endpoint stuck を疑う |
| チーム別 deploy 状態 | 選定問題すべてが `CREATE_COMPLETE` | `CREATE_IN_PROGRESS` のまま 15 分超過するチームは要疑 |
| 通知配信 | `info` / `warning` が polling tick 以内に portal に出る (= 現状 5 秒、 [`docs/operations/notifications.md`](../operations/notifications.md) を参照) | 30 秒経って出ないなら 「壊れた」 と扱う |
| Lambda エラー率 | ほぼゼロ | Deploy worker / scoring Lambda で持続的に 5 件/分以上が出たら triage 開始 |

## Triage 判断: 再 deploy が必要 vs 単独 team 問題

オペレータは「1 チームの症状」を直そうとして、 全チームに効く根本原因を見落としがちです。 次の decision tree を使うこと。

```
観測: あるチームから endpoint が落ちている と報告
│
├── 他チームでも落ちているか?
│   ├── YES → プラットフォーム全体障害。 [インシデント対応](./incident-response.ja.md) を開く。
│   │         原因を理解するまで個別 stack を再 deploy しない。
│   │
│   └── NO  → 単独チーム。 そのチームの deploy trace を読む。
│             │
│             ├── スタックが CREATE_FAILED / ROLLBACK_COMPLETE か?
│             │   → Yes。 単独チーム再 deploy が妥当。
│             │
│             ├── CREATE_COMPLETE だが endpoint 不通か?
│             │   → Yes。 チームによる構成変更が原因の可能性大。
│             │     チームに伝えるだけにとどめる。 盲目的 redeploy は
│             │     チームの進捗を消すので行わない。
│             │
│             └── 判断不能か?
│                 → [インシデント対応](./incident-response.ja.md) を開く。
│                   動く前に必ず記録する。
```

頻出ミスは反射的な再 deploy です。 Redeploy はチームの state を消去します。 すでに scoring に flag が反映済みなら、 redeploy がその成果を無効化することがある。

## Scoreboard の見方

絶対値ではなく形を見ます。

| 形 | 解釈 | 1st check |
|---|---|---|
| 1 チームだけ 0 点で平坦 | そのチームがログイン不可、 または stack 失敗 | プラットフォーム障害と決めつける前に、 ログイン状態を [participant onboarding](./participant-onboarding.ja.md) で確認 |
| 全チームが直近 5 分間平坦 | Scoring loop 停止 | Scoring Lambda の invocation count と error rate を確認 |
| 1 チームのスコアだけ後退 | Uptime scoring のペナルティが発火。 endpoint 落ちか確認 | そのチームの endpoint 障害。 仕様どおりの挙動 |
| 全チームのスコアが同時に後退 | Health check Lambda の誤発火か、 AWS region 障害 | 即座に [インシデント対応](./incident-response.ja.md) へ |

## イベント中の通知ポリシー

通知は控えめに。 Participant portal の polling 間隔は 5 秒。 過剰通知は疲弊を生む。 設計選択は [ADR-006](../architecture/adr-006-notifications.html) を参照。

- 参加者が把握すべきだが行動は不要、 という場合に `info`。 例:「14:30 から scoring 再開しました」。
- 参加者が行動しないと不利益、 という場合のみ `warning`。 例:「15:00 から 5 分間 health check を停止」。
- `warning` は 1 イベント 5 件まで。 6 件目を打ちたくなったら、 それは `info` で十分なメッセージ。

## イベントタイムラインの記録

観測も打ち手も、 1 ライン単位でタイムラインに追記します。

```
HH:MM | observed | scoreboard で team-A が 8 分間平坦
HH:MM | acted    | team-A の deploy trace を確認、 CFn ROLLBACK_COMPLETE を発見
HH:MM | acted    | Application Admin Console から redeploy を発行
HH:MM | observed | team-A の scoring 再開
```

このタイムラインが事後レビューとインシデント postmortem の入力になります。

## うまくいかなかったら

| 症状 | 1st response | エスカレーション |
|---|---|---|
| 全員の scoreboard が止まる | まず scoring Lambda の invocation count と error rate を確認。 60 秒以内に `info` 通知を送る。 | [インシデント対応](./incident-response.ja.md) の 「scoring 更新が止まる」 を開く。 |
| プラットフォーム障害か単独チームか判別できない | デフォルトでプラットフォーム調査に倒す。 「無事の調査コスト」 は 「盲目的 redeploy のコスト」 よりはるかに安い。 | [インシデント対応](./incident-response.ja.md)。 |
| 誤った `warning` を送った | 通知は edit / delete できない ([`docs/operations/notifications.md`](../operations/notifications.md))。 直ちに修正用 `info` を送る。 | 誤通知で参加者が動いてしまった場合は、 タイムラインと事後レポートに必ず記録。 |
| サポートチャネルが質問で溢れる | [participant onboarding](./participant-onboarding.ja.md) のルーティング表を再 pin。 古い順から triage。 | オペレータ容量を超えそうなら 「現在調査中、 10 分ごとに状況更新」 という `info` を打ち、 cadence を維持。 |
| 動いていいか迷う | 動かない。 もう 1 分観測し、 facilitator に相談してから打つ。 | [インシデント対応](./incident-response.ja.md) — 各エントリに 「1st response」 ブランチがあるので、 安全に動ける。 |

## 関連 runbook / ADR

- 前: [事前チェックリスト](./pre-event-checklist.ja.md) / [Dry run](./dry-run.ja.md) / [participant onboarding](./participant-onboarding.ja.md)。
- 併用: [インシデント対応](./incident-response.ja.md) — 動くときは必ず対応する incident 種別を開く。
- イベント後: [Teardown](./teardown.ja.md)。
- 背景: [ADR-006: Notifications](../architecture/adr-006-notifications.html) / [ADR-014: EventBridge 駆動 state reconciliation](../architecture/adr-014-eventbridge-driven-state-reconciliation.html) / [`docs/operations/deploy-trace.md`](../operations/deploy-trace.md) / [`docs/operations/notifications.md`](../operations/notifications.md)。
