# 5 分で「clone から動くイベント」まで quickstart

> English: [quickstart-5min.md](./quickstart-5min.md)

**ワンライナー** : TenkaCloud は実 AWS 上で動くオープンソースのクラウド競技プラットフォームです。 リポジトリを clone して `make deploy` するだけで、 10 分以内に admin console / デプロイ済みの問題 / 参加者ポータルが揃い、 1 チームが実 AWS タスクを解いてスコアが動く様子まで見せられます。

このウォークスルーは **トーク時間は約 5 分**、 背後で deploy が走るスタイルです。 1 度練習しておけば、 LT / セールス商談 / 録画のいずれでも同じ流れで再現できます。

## 前提

| 項目          | 用途                                                                 |
| ------------- | -------------------------------------------------------------------- |
| AWS アカウント | Lite mode は 1 アカウントへ deploy。 Free Tier に収まる設計です。     |
| `bun` 1.3.11+ | モノレポは Bun workspaces を使用。 `npm` / `npx` は不要です。         |
| `git` 2.40+   | 問題カタログは `problems/` サブモジュールとして提供されます。         |
| AWS CLI v2    | CDK 実行前の `aws sso login` / 認証情報に利用します。                 |

このウォークスルーには Cognito / SBT / 事前テナント作成は **不要** です。 Lite mode が `tenantId="local"` を自動配線します。

## ステップ 1 — clone & install (約 30 秒)

**操作**。

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make install
```

**何が起きたか**。 Bun が workspaces (infrastructure と 3 つの SPA) を install し、 `problems/` サブモジュールが展開され、 ライフサイクルスクリプトは `CLAUDE.md` の supply chain ガードに従ってデフォルトで skip されます。

**フォールバック**。 サブモジュールが空に見える場合は `git submodule update --init --recursive problems` を実行。 commit 系コマンドで `--no-verify` は使いません。

## ステップ 2 — Lite mode を deploy する (トーク 30 秒、 背後 10 分)

**操作**。 別ターミナルで次を起動します。

```bash
make deploy
```

走っている間、 トークは続けます。 Lite mode (#955) は 2 つの stack だけを立てます : `AppPlaneCore` (`tenantId="local"`) と `ProblemDeployBackend` (参加者ポータル)。

**何が起きたか**。 CDK synth + deploy で次が出来ます。

- 主催者用の single-tenant Cognito UserPool
- `DynamoDbLowCapacity` Aspect で 1 RCU / 1 WCU に固定された DynamoDB テーブル (Free Tier 内)
- S3 + CloudFront でホストされた Application Admin Console
- S3 + CloudFront でホストされた Participant Portal
- 4 plane が共有する EventBridge バス

**フォールバック**。 トーク前に事前 deploy 済みにしておき、 失敗したら事前 deploy の Console URL に切り替えます。

## ステップ 3 — Application Admin Console を開き、 「Demo 5min」イベントを作る (約 1 分)

**操作**。 `make deploy` が出力する `application-admin-console` 用 CloudFront URL を開き、 主催者 Cognito ユーザーでログイン。

1. **New event** をクリック
2. 名前 : `Demo 5min`
3. 保存

**何が起きたか**。 Application Plane が `(tenantId="local", eventId)` を key とする `Event` 行を書き込みました。 ここでは CFn stack はまだ走りません — event は単なるメタデータです。

**フォールバック**。 画面が真っ白な場合は 1 度ハードリフレッシュ。 `runtime-config.json` は boot 時に fetch されるので、 古いキャッシュが原因です。

## ステップ 4 — `hello-world` 問題を追加する (約 1 分)

**操作**。 作成したイベント内で次を実行する。

1. **Add problem** をクリック
2. `hello-world` (Challenge、 難易度 1 / 5、 想定 1 分) を選ぶ
3. 確定

**何が起きたか**。 サブモジュールからカタログ (`problems/index.json`) が読み込まれました。 `hello-world` は最小の `flag` 採点問題で、 `AWS::SSM::Parameter` を 1 つと、 自分の SSM prefix だけ読める `ParticipantViewerRole` を作ります (詳細は `problems/challenges/hello-world/README.ja.md` 参照)。 EC2 / VPC / 公開エンドポイントは作らず、 実コストはほぼゼロです。

**フォールバック**。 カタログ一覧が空ならサブモジュールが展開されていません。 `git submodule update --init --recursive problems` を再実行してリフレッシュ。

## ステップ 5 — bulk deploy をチームに撃つ (トーク 1 分、 背後 2 分)

**操作**。 デモ用のチームを選択 (または placeholder チームを作成) して、 **Deploy to all teams** をクリック。

**何が起きたか**。 Application Plane が `DeployRequested` イベントを EventBridge bus に発火。 `ProblemDeployBackend` Worker Lambda がそれを拾い、 テナントの `ExternalId` で competitor アカウントへ AssumeRole し (`CLAUDE.md` の通り必須)、 `problems/challenges/hello-world/template.yaml` を CFn `CreateStack`。 デプロイテーブルが `IN_PROGRESS` → `READY` と推移します。

**フォールバック**。 stack 生成中は `problems/challenges/hello-world/template.yaml` を画面で見せながら歩きます。 1 ページの CFn — それがデモの本体です。

## ステップ 6 — Participant Portal を開き、 flag を提出してスコアが動くのを見る (約 1 分)

**操作**。 `make deploy` が出力した participant portal URL を開き、 チームでログイン。

1. 問題説明を読む :「AWS Console → SSM Parameter Store → `/<NamePrefix>/hello` の値をコピー」
2. 参加者は **Open AWS Console** をクリック (フェデレーション → 読み取り専用 `ParticipantViewerRole` への AssumeRole で 1 click SSO)
3. `Hello from <NamePrefix>` をコピーしてポータルの flag 入力欄に貼り付け
4. スコアボードが **+100 pt** 加算される

**何が起きたか**。 ポータルが採点 Lambda (ADR-012 の generic dispatcher) を呼び出しました。 Lambda は `kind: "flag"` を判別し、 提出文字列と正解を照合、 `ScoreEvent` を書き込み、 EventBridge bus に `ScoreUpdated` を再発火。 スコアボードがそれを購読してリフレッシュします。

**フォールバック**。 フェデレーションがデモアカウントで未設定なら、 flag の値を直接貼り付けます。 flag 経路には Console アクセスは不要 — Console SSO は「見栄え」要素で、 必須ではありません。

## トータル実行時間

| 区間                                          | トーク | 背後              |
| --------------------------------------------- | ------ | ----------------- |
| ステップ 1 — clone & install                  | 30 秒  | -                 |
| ステップ 2 — `make deploy`                    | 30 秒  | 約 10 分 (live)   |
| ステップ 3 — create event                     | 1 分   | -                 |
| ステップ 4 — 問題を追加                       | 1 分   | -                 |
| ステップ 5 — bulk deploy                      | 1 分   | 約 2 分           |
| ステップ 6 — 解いてスコア反映                 | 1 分   | -                 |
| **合計トーク**                                | 約 5 分|                   |

背後の処理はトーク中に走らせます。 最も長い live 待ちはステップ 5 の約 2 分で、 ここは 1 ページの CFn テンプレートを音読して埋めます。

## トラブルシュートのワンライナー

| 症状                                            | 対処                                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| `make install` が遅い                           | 初回だけ。 2 回目以降は Bun キャッシュが効きます。                                |
| `make deploy` が「credentials」エラー           | `aws sso login` の後にリトライ。 CDK は default profile chain を使います。        |
| 管理コンソールに問題カタログが出ない            | `git submodule update --init --recursive problems` を実行してブラウザを更新。     |
| CFn stack が `CREATE_IN_PROGRESS` のまま動かない | service quota 待ちの可能性。 CloudTrail を確認。                                  |
| flag 提出で 401                                 | ポータルの Cognito セッション切れ。 一度サインアウトしてから再提出。              |
| スコアボードが更新されない                      | 5 秒待つ。 ポータルは polling (SSE は意図的に使わない — AGENTS.md 参照)。         |
| 全部消したい                                    | `make destroy` (= `make lite-down`)。 partial-failure 状態でも冪等。              |

## 締めのトーク例

- 「これは **single-tenant** 経路。 SBT control-plane でマルチテナントにしたければ `make deploy-saas` — 3 フェーズ / 15 〜 20 分、 BASIC / STANDARD / PREMIUM の pooled tier と PLATINUM の silo tier を提供」
- 「問題は `metadata.json` + 1 ページの `template.yaml` + 任意の `portal/` プラグインで配布。 プラットフォームコードに触れずに誰でも問題を作れる (ADR-012)」
- 「ライセンスは Apache 2.0。 プラットフォームが host、 問題が plugin。 ご自身の問題を持ち込んでほしい」

## 次に読むもの

- [`docs/demos/sales-pitch-15min.ja.md`](./sales-pitch-15min.ja.md) — 同じ流れにペイン軸のトークポイントを添えた版
- [`docs/demos/architecture-tour-30min.ja.md`](./architecture-tour-30min.ja.md) — 内部実装の歩き方
- [`problems/README.ja.md`](../../problems/README.ja.md) — 自分の問題を書く
- [`docs/architecture/OVERVIEW.md`](../architecture/OVERVIEW.md) — 10 分のアーキテクチャ overview
