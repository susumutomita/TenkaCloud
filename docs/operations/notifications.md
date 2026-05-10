# Notifications 運用ガイド

ADR-006 に基づく運営 → 競技者通知機能の使い方と運用上の制約。実装の経緯と設計判断は
[ADR-006](../architecture/adr-006-notifications.html) を参照。

## 通知の届き方 (運用者が知っておくべき挙動)

| 項目 | 値 |
|---|---|
| 配信方式 | Pull (= participant portal が polling) |
| Polling 間隔 | TeamViewProvider tick (現状 5 秒) |
| 競技者の体感遅延 | **最大 5 秒** (画面開いている場合) |
| 画面を閉じている競技者 | **届かない** (Web Push 不採用、ADR-006 D7) |
| Severity 段階 | `info` / `warning` の 2 段 |
| 一覧の保持期間 | 親 event の `expiresAt` まで (DDB TTL で自動削除) |
| 編集 / 削除 | **不可** (= 一度送ったら取り消せない、idempotent な書き出し前提) |
| 既読管理 | 競技者ブラウザ localStorage (= 同一ブラウザ内で完結) |

ENDED / TEARDOWN / ARCHIVED 状態の event でも DDB TTL までは履歴が残るので、競技後の
振り返りで参照できる。

## いつ何を通知すべきか

### `info` を使うケース

- 競技ステータスのアナウンス:「14:30 から scoring 再開しました」「全 team 配備完了」
- 進行情報:「現在 5 / 8 problem を deploy 済み、残り 3 問は順次解放」
- 軽微な FAQ:「Battle 系問題で endpoint URL は SSO Credentials ページから取得可能」

判断基準: **競技者が今すぐ行動を変えなくてもいい** 通知。確認して脳内 update できれば
十分なもの。

### `warning` を使うケース

- メンテ予告:「30 分後に 5 分間 health check を停止」
- 障害告知:「特定 region で AWS 側障害が発生中、一時的に scoring 反映遅延あり」
- 競技ルール変更:「flag 形式を 1 問差し替え。提出前に最新要件を要確認」

判断基準: **競技者がそれを把握していないと不利益を被る** か、**行動の手戻り** が出る通知。

### 使い分けに迷ったら

- 1 event あたり `warning` は **5 件以下** に抑える (頻発するとオオカミ少年化して `info`
  と区別がつかなくなる)
- 「これは `warning` か?」と迷ったら基本 `info`
- 競技者の Battle Portal は防御中で集中している → 通知を送りすぎない (= 1 時間に 1 件
  程度を上限の目安に)

## 操作手順 (運営側)

1. application admin console から対象 event の **Event Detail** ページを開く
2. ヘッダー右上の **「通知を送る」** ボタン (DRAFT / TEARDOWN / ARCHIVED 状態では
   disabled。READY / ENDED / DEPLOYING 状態のみ送信可能)
3. Modal で **タイトル** (1〜120 文字) + **本文** (1〜2000 文字) + **severity** を入力
4. **送信** で 201 Created。送信成功 Alert が画面上部に出る
5. 競技者の Participant Portal `/notifications` で次の polling tick (最大 5 秒) で表示

### 競技者目線の確認方法

別 browser のセッションでテスト team の `teamLoginKey` でログインし、`/notifications`
ページを開けば確認できる (本番チームの未読 badge を勝手に既読化しないこと)。

## 失敗時の挙動

| 状況 | 挙動 |
|---|---|
| 入力 validation 違反 (空文字 / 上限超) | Modal 内 Alert で表示、送信されない |
| event 不在 / tenant 不一致 | 404 → Modal 内 Alert |
| 競技者ブラウザの localStorage 不可 (private mode) | 既読管理が無効化、毎回全件未読扱い (graceful degradation) |
| participant が旧 jobId-based deployment | 404 → portal 側で「通知配信対象外」 Alert |
| backend Lambda init 失敗 (`EVENTS_TABLE_NAME` 未設定 等) | participant 側 polling が一時的にエラーになるが、他経路 (`/portal/me` / `/portal/leaderboard`) は影響を受けない |

## 設計上の制約 (=今後やらないこと、やるなら別 ADR)

- **編集 / 削除 API は持たない**: 一度送ったら確定。typo を訂正したい場合は **続報を送る**
- **Web Push / Browser Notification API 不採用**: Service Worker / VAPID key の運用負荷が高く、polling で十分カバーできるため (ADR-006 D7)
- **server-side 既読管理なし**: 既読は competitor ブラウザの localStorage のみ。別 PC / 別 browser でログインすると未読バッジが「リセット」される
- **operator 側 GET API はまだ無い**: `EventDetail` 上で履歴を一覧する UI も unscope (= 必要なら別 PR で `GET /events/:eventId/notifications` を追加)

## 関連

- [ADR-006](../architecture/adr-006-notifications.html) — 設計判断 D1〜D7
- [ADR-005](../architecture/adr-005-battle-portal-ui.html) — polling 60s 統一の親規約
- [`docs/api/tenant.openapi.yaml`](../api/tenant.openapi.yaml) — operator 側 API spec
- [`docs/api/participant.openapi.yaml`](../api/participant.openapi.yaml) — participant 側 API spec
