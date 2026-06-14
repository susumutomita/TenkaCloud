# 15 分のセールス / ファシリテーター向け pitch

> English: [sales-pitch-15min.md](./sales-pitch-15min.md)

これは quickstart の 15 分版です。 セールス商談やコミュニティ運営ピッチに使うファシリテーター向け。 流れは [`quickstart-5min.ja.md`](./quickstart-5min.ja.md) と同じで、 各ステップに **課題 → プロダクト適合のトークポイント** と **料金 tier への言及** を添えています。

## オープニング (約 1 分)

**課題**。 エンタープライズの社内クラウド研修は、 たいてい次の 2 つの失敗モードに陥ります。

- **スライドのみの研修** : 開発者はデッキを聞き流し、 コンソールに触れず、 1 週間で忘れる。
- **自由なサンドボックス** : 開発者に AWS アカウントを渡すが、 scope も採点も進捗可視化もなく、 プラットフォームチームが永続的に爆発半径を抱える羽目になる。

**プロダクト適合**。 TenkaCloud はその中間に位置します。 主催者は厳選された問題を隔離環境に deploy。 参加者は実 AWS で解きます。 採点と進捗は組み込み済み。 爆発半径は問題テンプレートと読み取り専用 `ParticipantViewerRole` で制限されます。

**ポジショニング**。

> TenkaCloud は実 AWS 上で動くオープンソースのクラウド競技プラットフォームです。 主催者はハンズオン問題を隔離環境に deploy し、 参加者はクラウドで解き、 問題パックは OSS のように再利用 / コントリビュート可能です。

## ステップ 1 — clone & install (約 1 分)

**操作**。 quickstart ステップ 1 と同じ。

**トークポイント**。「プラットフォーム本体は Apache 2.0。 商用フォークの裏に機能を隠しません。 顧客固有の拡張はプラットフォームではなく private 問題リポジトリに置きます — その境界は `ADR-008` と submodule レイアウトで強制されています」

**料金ヒント**。 セルフホストは無料。 マネージド tier の料金は SaaS レイヤーで設定し、 OSS プラットフォームには載せません。

## ステップ 2 — Lite mode を deploy する (約 2 分)

**操作**。 quickstart ステップ 2 と同じ。 `make deploy` を走らせながらコストの話をします。

**トークポイント**。「DynamoDB は CDK Aspect で 1 RCU / 1 WCU に強制されています。 CloudFront / S3 / Lambda はすべて Free Tier に収まります。 30 人規模のイベントを 1 杯のコーヒー代で運営した顧客がいます」

**料金ヒント**。 Starter / Hosted Event は 1 つの pooled `application-admin-console` を共有 (低コスト)。 コンプライアンスやデータ residency 要件で隔離が必要な Annual Arena 契約者には専用 silo stack を提供します。

## ステップ 3 — イベントを作る (約 1 分)

**操作**。 quickstart ステップ 3 と同じ。

**トークポイント**。「イベントは単なるメタデータです。 200 人規模の本番前に 1 チームでドレスリハできます。 プラットフォームはイベント規模で挙動を変えません — 同じ Lambda、 同じ DDB、 同じ EventBridge」

**料金ヒント**。 イベント単位のブランディング (ロゴ / カスタム文言) は Hosted Event tier 以上に含まれます。 Lite mode (無料) は OSS のデフォルトスキンです。

## ステップ 4 — `hello-world` 問題を追加する (約 2 分)

**操作**。 quickstart ステップ 4 と同じ。 別タブで `problems/challenges/hello-world/` を開き、 3 ファイルを見せます。

**トークポイント**。「これが問題です。 3 ファイル : `metadata.json` (カタログ + 採点設定)、 `template.yaml` (1 ページの CFn)、 任意の `portal/` プラグイン。 御社の SRE チームも含めて、 誰でもプラットフォームを fork せずに問題を作れます。 これが `ADR-012` 問題プラグインアーキテクチャです」

**料金ヒント**。 コミュニティ寄稿カタログは無料。 セキュリティ運用 / マルチリージョン failover / data mesh ドリルなどの enterprise 問題パックは別ライセンス。 [`problems/CATALOG.md`](../../problems/CATALOG.md) 参照。

## ステップ 5 — bulk deploy をチームに撃つ (約 3 分)

**操作**。 quickstart ステップ 5 と同じ。 deploy が走っている間、 画面で `template.yaml` を歩きます。

**トークポイント**。「問題は **チーム所有の別 AWS アカウント** に CFn `CreateStack` で deploy されます。 テナント固有の `ExternalId` で AssumeRole — `CLAUDE.md` でも譲れないと書いています。 プラットフォームチームはチームのランタイムを所有しません。 チームのアカウントが所有します」

**料金ヒント**。 クロスアカウント `AssumeRole` は全 tier に含まれます。 競技者側の 1 回きりブートストラップは `infrastructure/templates/competitor-bootstrap.yaml`、 `ExternalId` 付きで role を作る 1 ファイルの CFn です。

## ステップ 6 — 解いてスコア反映 (約 3 分)

**操作**。 quickstart ステップ 6 と同じ。 スコアが加算されたら admin console のスコアボードに戻ります。

**トークポイント**。「採点はビルトインの 6 種 — `flag` / `multi-flag` / `uptime-flat` / `uptime-multi` / `phased-polling` / `attack-detection` のいずれか。 各問題が 1 つを選びます。 プラットフォームには共通の generic 採点 Lambda が 1 本あり、 問題種別に応じて dispatch します — プラットフォーム側に問題固有コードはゼロ。 これで運用面の表面積を小さく保てます」

**料金ヒント**。 リアルタイムスコアボードリフレッシュ / マルチチームダッシュボード / disruption phase 可視化は Hosted Event tier 以上に含まれます。 Starter tier も同じ採点経路ですが、 ダッシュボードはシンプル版です。

## クロージング (約 2 分)

3 点を伝えます。

1. **現実の話**。 今日出荷しているもの : クロスアカウント分離 deploy、 6 種の採点、 EventBridge 駆動 state 再同期 (`ADR-014`)、 polling UI (SSE は使わない — `AGENTS.md` 参照)。 取り組み中 : 投票方式のコミュニティカタログ (`ADR-024`)、 AWS 以外向け provider-specific runtime (`ADR-023`)。「production-grade なマルチクラウド」や「フル SOC2」は今日は名乗らない。
2. **運用モデル**。 Lite mode = `make deploy`、 1 主催者 / 1 イベント、 10 分でセットアップ。 SaaS mode = `make deploy-saas`、 マルチテナント、 pooled + silo の組み合わせ、 control plane 起動に 15 〜 20 分。
3. **CTA**。 starter 問題 (`hello-world`、 `s3-public-bucket`、 `lambda-cold-start`) を選んで御社の SRE チームでドライランを 1 回。 最も長いコミットメントは `make deploy` 1 回分。

## 課題 → プロダクト適合まとめ

| 課題                                          | TenkaCloud の適合                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------- |
| 「研修がスライドのみで身につかない」          | 実 AWS のハンズオン問題、 決定論的な採点経路                                            |
| 「サンドボックスアカウントの爆発半径が広い」  | チーム別の隔離アカウント + `ExternalId` 付き AssumeRole + scope 制限 `ParticipantViewerRole` |
| 「イベントごとに採点ロジックが必要」          | 6 種の採点 (`flag` / `multi-flag` / `uptime-flat` / `uptime-multi` / `phased-polling` / `attack-detection`) |
| 「イベント当日の運用を穏やかにしたい」        | EventBridge 駆動の reconciliation (ADR-014)、 polling UI、 冪等な teardown              |
| 「自社 SRE が問題を書きたい」                 | 1 問 3 ファイル、 `ADR-012` 問題プラグインアーキテクチャ、 プラットフォーム fork 不要   |
| 「将来 AWS から離れる可能性がある」           | `ADR-023` provider-specific runtime ロードマップ。 今日は AWS のみ、 範囲は正直に伝える |

## 料金 tier の早見表

ランディングページに掲載している商用 tier です。 数字は `landing/index.html` (`#pricing`) と一致します。

| Tier         | 価格              | 規模                              | 用途                                                                |
| ------------ | ----------------- | --------------------------------- | ------------------------------------------------------------------- |
| Starter      | 50 万円 / 回      | 2 チームまで                      | お試し開催、 小規模で運営代行のフィットを確認                       |
| Hosted Event | 150 万円 / 回     | 5 チームまで (約 20 人)           | 単発イベント、 構築 / 当日 on-call / Red Team まで運営代行          |
| Annual Arena | 600 万円 / 年     | 年間複数イベント                  | 社内研修プログラムとして繰り返し開催、 ブランド付きポータル / カタログ |

内部的には SaaS mode (`make deploy-saas`) がさらに pooled vs silo の Application Plane に振り分けます (BASIC / STANDARD / PREMIUM は pooled の 1 stack を共有、 PLATINUM は専用 silo stack)。 購入者がこの内部 tier を意識する必要はなく、 選択した商用 tier に応じて自動配置されます。

Lite mode (`make deploy`) には tier がありません — OSS セルフホスト、 無料、 1 主催者 / 1 イベントの最短経路です。

## 次に読むもの

- [`docs/demos/architecture-tour-30min.ja.md`](./architecture-tour-30min.ja.md) — CCoE / プラットフォームチーム向け技術深掘り
- [`problems/README.ja.md`](../../problems/README.ja.md) — 自分の問題を書く
- [`docs/architecture/OVERVIEW.md`](../architecture/OVERVIEW.md) — 10 分のアーキテクチャ overview
- [`ROADMAP.md`](../../ROADMAP.md) — 出荷済み / 進行中の差分 (セールスの誠実カード)
