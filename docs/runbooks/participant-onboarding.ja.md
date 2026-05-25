# Participant onboarding

> English: [participant-onboarding.md](./participant-onboarding.md)

| 属性 | 値 |
|---|---|
| Audience | Facilitator (= 参加者を迎えて kickoff を仕切る人) |
| 使うタイミング | イベント当日朝、 公表開始時刻の直前 |
| 所要時間 | Facilitator の準備 20 分、 参加者は kickoff 中 5 〜 10 分 |
| 出力 | 全チームがログイン完了、 質問導線を理解、 participant portal で何を見るかを理解した状態 |

このステップは、「ログインできない / 質問先がわからない」参加者がイベント全体を止めるため必要です。 対応は 3 つのアーティファクト (login key / kickoff ブリーフィング / 明示的なサポートチャネル) を開始前に届けることに集約されます。

## 配布する 3 アーティファクト

| # | アーティファクト | チャネル | オーナー |
|---|---|---|---|
| 1 | Login key (Cognito 単独) または SSO リンク (federated) | [事前チェックリスト T-7](./pre-event-checklist.ja.md#%E8%AA%8D%E8%A8%BC--%E3%82%A2%E3%82%AF%E3%82%BB%E3%82%B9) で決定 | Facilitator |
| 2 | Kickoff ブリーフィングスライド (3 〜 5 枚) | Kickoff のメイン画面に投影 / サポートチャネルにも転載 | Facilitator |
| 3 | サポートチャネルリンク | Kickoff ブリーフィングで共有し、 チャットツール側に pin | Facilitator |

## Step-by-step

### Step 1: Login key / SSO リンクの配布 (10 分)

- [ ] Participant portal URL (`make lite-portal-url` / SaaS CloudFront URL) がログイン画面を描画することを確認。
- [ ] 各チームに login key または SSO リンクを合意済みのチャネル (メール / Slack DM / 紙カード) で送付。 参加者が探さなくて済むよう、 必ず participant portal URL を併記する。
- [ ] Kickoff 前に各チームから受領確認をもらう。 T-15 分時点で未確認のチームには 1:1 で連絡。

> **念のため**: Login key は機微情報。 共有チャネルに投稿しないこと。 1:1 DM または各チーム用メールエイリアスを使う。

### Step 2: Kickoff ブリーフィングの準備 (5 分)

3 〜 5 枚のスライドを次の構成で用意する。

1. **Welcome / イベント識別**。 イベント名 / 主催 / 協賛。 CTF ではなく「クラウド drill」であることを強調。
2. **参加者が見る画面**。 Participant portal の scoreboard とチームビュー dashboard のスクリーンショット。 Flag / endpoint / score の位置を指し示す。
3. **質問の出し方**。 サポートチャネルのリンクとエスカレーション手順。 オペレータの応答は「数分」単位 (= 数秒ではない) と期待値を握る。
4. **Scoring rule / 時間枠**。 開始時刻 / 終了時刻 / 各問題の 1 文サマリ。 詳細は問題ごとの README にリンク。
5. **行動規範 / AWS 制約**。 問題テンプレート範囲外のリソースに触らないこと。 プラットフォーム側の AWS 課金は無いが、 チーム別 CFn stack は実コストが乗ることを明示。

### Step 3: Kickoff の開始 (5 分)

- [ ] T-5 分でブリーフィングをサポートチャネルへ恒久参照として投稿。
- [ ] T-0 でブリーフィングをライブ (= または事前録画) で通読。
- [ ] 公表開始時刻前に各チーム少なくとも 1 名が participant portal にログイン済みであることを確認。

### Step 4: Live monitoring に引継ぎ

Kickoff が完了したら、 [live monitoring](./live-monitoring.ja.md) に切り替えます。 Facilitator はサポートチャネルに残ってもよいが、 プラットフォーム側はここからオペレータの担当。

## 質問ルーティング

参加者が質問する前に、 誰が何に答えるかを決めておきます。

| 質問種別 | ルーティング | 例 |
|---|---|---|
| 「ログインできない」 | Facilitator (= onboarding アーティファクト不備) | Login key 間違い / URL 間違い |
| 「endpoint が落ちている」 | オンコールオペレータ (= [live monitoring](./live-monitoring.ja.md) 経由) | スタックが rollback。 [インシデント対応](./incident-response.ja.md) を参照 |
| 「Flag が rejected された」 | 問題作者または facilitator (= scoring 設定) | Flag 形式の不一致。 問題 README を確認 |
| 「サービス X を使ってよいか」 | Facilitator (= 行動規範) | スコープ外 AWS サービスの利用申請 |
| 「プラットフォームが壊れている?」 | オンコールオペレータ | [インシデント対応](./incident-response.ja.md) で triage |

この表を kickoff 前にサポートチャネルへ投稿し、 参加者が自己ルーティングできるようにする。

## うまくいかなかったら

| 症状 | 1st response | エスカレーション |
|---|---|---|
| あるチームに login key が届いていない | チャネルを確認し、 1:1 で再送する。 participant portal URL も同梱されているかを確認。 | 複数チームで未受領が発生したら、 開始を保留して配布チャネルを見直す。 |
| ログインしたが portal が空 | チーム metadata (tenantId / teamSlug) の配線と、 当該チームに最低 1 問が deploy 済みであることを確認。 | 全員空ならプラットフォーム障害。 [インシデント対応](./incident-response.ja.md) へ。 |
| 参加者がサポートチャネル外 (DM / 廊下) で質問する | 「ログを残すため」 と説明しサポートチャネルへ誘導。 | パターン化したら、 サポートチャネルリンクを再 pin。 |
| Kickoff 中に facilitator role が曖昧 | Kickoff 前に MC とオペレータを 1 名ずつ確定する。 1 人で兼務しない。 | やむを得ない場合は、 次回イベント用に 2 人目の facilitator を準備。 |

## 関連 runbook / ADR

- 前: [事前チェックリスト](./pre-event-checklist.ja.md) / [Dry run](./dry-run.ja.md)。
- 次: [live monitoring](./live-monitoring.ja.md)。
- 背景: [ADR-006: Notifications](../architecture/adr-006-notifications.html) — 主催者から参加者への通知セマンティクス。
