<!-- markdownlint-disable MD033 -->
<div align="center">

[English](./README.md) | **日本語**

# TenkaCloud

**クラウド競技を開き、再利用できる問題カタログを育てる。**

TenkaCloud は、ハンズオン形式のクラウド競技会を開くための、セルフホスト可能な Apache-2.0 ライセンスのプラットフォームです。開催者は 1 つのコンソールで大会・チーム・問題環境・採点・ヒントを管理し、参加者はチームキーを使ってローカルの演習や AWS の問題に挑戦します。

<table>
<tr>
<td width="50%" align="center" valign="top">

**A. ローカルで試す** <sub>(AWS アカウント不要)</sub>

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/susumutomita/TenkaCloud)

</td>
<td width="50%" align="center" valign="top">

**B. AWS で大会を開く** <sub>(AWS アカウント・利用料金あり)</sub>

[**AWS にデプロイする →**](#aws-にデプロイする)

</td>
</tr>
</table>

<a href="./landing/videos/lp/tenkacloud-30s.mp4">
  <img src="./docs/assets/lp-30s/tenkacloud-30s-preview.gif" alt="30 秒でわかる TenkaCloud: ブラウザで遊ぶ → 得点する → AWS で自分のイベントを開く" width="800">
</a>
<br>
<sub>30 秒でわかる TenkaCloud (音声なし・日英字幕)。現在の起動手順は以下を参照してください。<a href="./landing/videos/lp/tenkacloud-30s.mp4">16:9 MP4</a> · <a href="./landing/videos/lp/tenkacloud-30s-vertical.mp4">9:16 MP4</a></sub>

[ランディングページ](https://tenkacloud.com) · [役割別マニュアル](https://tenkacloud.com/docs/manual/) · [デモポータル](https://tenkacloud.com/portal-demo/?demo=1) · [クイックスタート](#クイックスタート) · [自分の問題を追加する](#自分の問題を追加する)

[![CI](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml/badge.svg)](https://github.com/susumutomita/TenkaCloud/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/susumutomita/TenkaCloud/graph/badge.svg?token=WfleGvJor9)](https://codecov.io/gh/susumutomita/TenkaCloud)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

<a href="https://www.producthunt.com/products/tenkacloud?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-tenkacloud" target="_blank" rel="noopener noreferrer"><img alt="TenkaCloud - Open-source cloud competitions on real AWS accounts | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1209524&amp;theme=light&amp;t=1785406694086"></a>

</div>

> TenkaCloud は独立したオープンソースプロジェクトであり、Amazon Web Services, Inc. と提携・承認・後援を受けたものではありません。AWS および関連する商標は Amazon.com, Inc. またはその関連会社の商標です。

英語版が正本であり、この日本語版は追従して更新されます。内容に差異がある場合は [README.md](./README.md) を優先してください。

---

## クイックスタート

大会へ招待された方は、**開催者から受け取った参加者ポータルの URL とチームキー**を使ってください。自分でインストールやデプロイをする必要はありません。

### ローカルで試す (AWS 不要)

macOS、Linux または WSL2 に Git、Make、**Bun 1.3.11** を用意します。Docker 問題には Docker Engine と Compose v2 が必要です。組み込みの Cryptography Battle は Docker も AWS も使いません。開発ツールのバージョンは [mise.toml](./mise.toml) にあります。

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make install
make local
```

1. 表示された開催者 URL を開き、ターミナルに一度だけ表示される**主催者キー**でログインする。ユーザー名やパスワードは不要である。
2. 大会・チーム・問題を選び、問題環境を準備して大会を開始する。
3. 各チームへ参加者 URL とそのチームのキーを配る。Docker 問題は参加者が必要なときに **Start / resume** で起動する。
4. 問題を解いて指定された解答を送信し、得点を確認する。

**主催者キーを紛失したら:** `make local-reset` で再発行できます。主催者のログインは失効しますが、大会・得点・参加者キー・問題環境を保持します。

**いったん停止するには:** 別のターミナルで `make down` を実行します。このコントローラーと所有する Docker 環境を停止し、DB・キー・コンテナーの書き込み領域・ボリュームを保持します。次の `make local` の後、オンデマンドの問題は参加者がポータルから再開します。プロセスのメモリーは保持せず、大会の時計もリセットしません。問題環境を削除するときは、大会の **Teardown** を使います。

[起動・運用・復旧](./docs/local-hosting.md) · [必要な環境と容量](./docs/local-play-requirements.md) · [開催者マニュアル](./apps/developer-portal/src/app/developers/docs/manual/organizer/page.ja.mdx)

### Codespaces で開発環境を開く

<div align="center">
  <a href="./docs/assets/codespaces-local-mode/codespaces-local-mode-readme-1280x720.mp4">
    <img src="./docs/assets/codespaces-local-mode/codespaces-local-mode-readme-preview.gif" alt="GitHub Codespaces のローカルモードを日英 2 言語で 15 秒で紹介する動画" width="800">
  </a>
  <br>
  <sub>日英 2 言語で 15 秒の Codespaces 紹介。現在は以下の手順で開催者コンソールと参加者ポータルを起動します。</sub>
</div>

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/susumutomita/TenkaCloud)

Codespace を作成し、依存関係の準備が終わったらターミナルで `make local` を実行します。開催者と参加者のポートは 5174 と 5175 です。動画は以前のローカル体験を収録しています。現在の競技 host では、転送 origin と問題への接続経路の検証が残っています。大会には上記のローカル手順を使って確認してください。

### AWS にデプロイする

クラウド開催は SBT を使わない旧 Lite の処理を再利用し、Lambda・Cognito と選択した Turso / DynamoDB で、汎用 CloudFormation 配置、flag / multi-flag・定期採点、参加者の Console / CLI アクセス、Cryptography Battle などの組み込み coordination を実行します。Docker / Compose 問題はローカルで実行します。この checkout は**統合検証中の候補版**です。実 AWS での大会全体のリハーサルと、Battle の一斉アクセス性能には検証が残っています。環境ファイルの `CDK_PARAM_CONTROL_DATA_BACKEND` で `turso` または `dynamodb` を選択します。Turso には DB URL と既存の SSM トークンパラメーターが必要です。[DB 設定](./infrastructure/README.md#database-selection)を参照してください。

物理 stack 名は旧 `tenkacloud-lite` 系を維持し、CLI が Lite / cloud の既存環境を検出します。両方ある場合は `TENKACLOUD_STACK_LAYOUT=lite` または `cloud` を明示します。公開 cloud-v1 の DB・resource 構成は自動移行しません。両 DB とも 99 チーム、SQL coordination は 4 MiB 上限です。現行の 9 template は `TemplateBody` 上限を超えるため、全 AWS 問題の配置を保証しません。[互換性と制限](./infrastructure/README.md#existing-installations-and-resource-identity)を確認してください。

AWS CLI のプロファイル、アカウント、リージョン、開催者のメールアドレスを用意します。`infrastructure/environments/{development,staging,production}/.env.example` を、同じディレクトリの `.env` がなければコピーして編集します。

```bash
aws sts get-caller-identity
make deploy ENV=development
```

`make deploy` は標準の `CDKToolkit` を検証して再利用し、存在しない場合だけ固定版の公式 CDK bootstrap で作成します。続けて `--require-approval never` で配置します。新規環境と復旧済み環境では CI でも追加のフラグや承認入力は不要です。catalog pin のない旧 Lite の初回更新は、大会が進行中でないことの明示確認が必要です。コマンドは配置先・権限・費用の注意事項を表示します。[bootstrap と呼び出し元の権限](./infrastructure/BOOTSTRAP-IAM.md)を確認してください。標準の CloudFormation 実行 role はデフォルトで `AdministratorAccess` を使います。アプリケーションの実行 role には付与しません。配置時には CodeBuild 用の非公開 source ZIP を毎回別 key に upload し、正確な S3 version を保存します。source bucket は基盤の destroy 後も残り、別途確認して清掃するまで保存料金が発生します。保存した大会・配置は catalog 更新後も元の snapshot を使います。[catalog の固定と旧データの回復](./infrastructure/README.md#update-the-problem-catalog)を参照してください。

AWS コンソールから配置する場合は、[クラウド pipeline](./infrastructure/README.md#cloud-deployment-pipeline)のソース設定と、CodeBuild role の配置権限を確認します。launcher の作成と build の開始は別の操作です。build の開始権限は、配置先を管理できる担当者に限定してください。

参加者を招く前に、テスト用の大会とチームで問題を開き、解答を送信して得点まで確認します。

**大会が終わったら:** `make destroy ENV=development` でアカウント・リージョン・所有する対象を確認し、基盤とデフォルトの所有データを削除します。問題環境は基盤を削除する前に大会の Teardown 操作で撤収します。DynamoDB テーブルはデフォルトで削除し、明示的に retain を設定した場合だけ保持します。通常の destroy は外部 Turso の行を残します。`make destroy-all` はその行のリセットと、スタックが所有していた保持データの削除を明示的に実行します。残したストレージや AWS リソースには料金が発生する場合があります。現行の処理と復旧手順は[配置と撤収](./infrastructure/README.md#current-checkouts-setup-and-teardown-boundary)を参照してください。

destroy は承認後、CloudFormation の所有情報を検証した S3 バケットのうち、配置済みの削除ポリシーが `Delete` のものだけを空にします。オブジェクトのバージョンと削除マーカーも削除してから、スタックを撤収します。通常の destroy は `Retain` ポリシーのバケットと内容を残します。明示した `destroy-all` は保持対象の内容も空にしますが、`Retain` ポリシーのバケット本体は残ります。呼び出し元には、CloudFormation の実行権限とは別に[直接 S3 を清掃する権限](./infrastructure/BOOTSTRAP-IAM.md#direct-deployment-and-cleanup-permissions)が必要です。

AWS 資源を使う問題には、開催基盤とは別の検証済み競技者アカウントが必要です。hosting account は資源変更前に拒否します。同じ競技者アカウントの別 region に複数チームを配置できますが、global IAM は共有され、問題ごとの権限確認が必要です。Cryptography Battle は得点を奪う機能を無効にした native 版なら競技者アカウント不要で、有効にすると AWS 版を維持します。

catalog pin のない旧 Lite 環境は、resource / schema の検査後、bootstrap・source upload・配置の前に、進行中の大会がないことを初回だけ明示確認します。開催中の大会は完了まで配置済みの版で継続してください。大会が残っていないことを運用者が確認してから対話で承認し、非対話の更新には `CLOUD_ARGS="--confirm-no-active-events"` を使います。通常の `--yes` ではこの確認を省略できません。legacy catalog key だけでは安全な更新を証明できず、過去のデータも自動移行しません。新規環境と復旧済み環境は通常の `make deploy` で自動配置します。

AWS に接続せずヘルプを見るには、`make deploy CLOUD_ARGS="--help"` または `make destroy CLOUD_ARGS="--help"` を使います。

## 運用費用

| 開催方法 | 確認する費用・容量 |
| --- | --- |
| ローカル | 手元の PC・ディスク・Docker の容量。Cryptography Battle は Bun と SQLite で動作 |
| AWS | 基盤サービス・選択した DB・問題のリソース・保持データ。コンソール pipeline は CodeBuild も使用 |

利用料金がゼロになることは保証しません。大会の前後に[費用と保持リソース](./docs/running-costs.md)を確認してください。

## 自分の問題を追加する

問題の正本は [TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge) です。カタログへの追加には、そのリポジトリの作問・検証手順を使います。作問のためにプラットフォームを fork する必要はありません。

`make submodule-latest` で問題ソースを最新版へ更新して stage し、`make validate-problems` で選択した pin を検証します。どちらも稼働中のカタログへは反映しません。大会の合間に差分を確認し、ローカルは `make local` で[再ビルド・再起動](./docs/local-hosting.md#update-the-problem-catalog)、クラウドは `make deploy` で[既存環境を更新](./infrastructure/README.md#update-the-problem-catalog)します。`make build` は手元の成果物を作るだけです。再開予定のローカル大会には元の checkout を残してください。既存大会の問題定義やクラウドの実行内容は自動移行しません。

更新コマンドは追跡する branch を取得し、古い commit または分岐した commit であれば checkout や stage の前に停止します。問題ソースに未完了の編集がある場合も停止し、本体側の無関係な作業は保持します。検証用の pin は、その commit を失わずに追跡先へ前進できるまで維持してください。

再利用する問題や非公開コンテンツには、公開 SDK とオフラインの Problem Pack ツールで作成・検証・不変な revision の保存ができます。

```bash
bun run pack init ./my-pack
bun run pack validate ./my-pack
bun run pack install ./my-pack
bun run pack list
```

pack の install や activation の記録だけでは、現在の大会の実行カタログへ追加されません。[pack チュートリアル](./apps/developer-portal/src/app/developers/docs/tutorials/first-pack/page.ja.mdx) · [外部 Git pack の手順](./scripts/problem-pack/README-external-git-pack.md) · [作問例とテスト fixture](./packs/README.md)

## ドキュメント

| やりたいこと | 参照先 |
| --- | --- |
| 大会を開く | [計画と運用](./apps/developer-portal/src/app/developers/docs/operate/run-an-event/page.ja.mdx) |
| ローカル開催・アクセスの復旧 | [ローカル競技の運用](./docs/local-hosting.md) |
| AWS 基盤の配置・撤収 | [配置ガイド](./DEPLOYMENT_GUIDE.md) |
| 競技者アカウントの準備 | [アカウント導入手順](./docs/competitor-account-onboarding.md) |
| LLM に作業を依頼する | [LLM の入口](./landing/llms.txt) · [タスク別ガイドとコードマップ](./landing/llms-full.txt) |
| 設計を理解する | [アーキテクチャ](./docs/architecture/README.md) · [編集可能な AWS 構成図](./docs/architecture/diagrams/system-architecture.drawio) |
| 質問する | [GitHub Discussions](https://github.com/susumutomita/TenkaCloud/discussions) (公開) |

[機能の対応状況と検証範囲](./docs/host-retirement.md)に runtime の対応を記載しています。任意のコンテナー image は[build・再起動確認](./docs/host-build-verification.md)を参照してください。この変更で host image は公開していません。

## 開発

[CONTRIBUTING.md](./CONTRIBUTING.md)、[AGENTS.md](./AGENTS.md)、[開発者マニュアル](./apps/developer-portal/src/app/developers/docs/manual/developer/page.ja.mdx)を参照してください。

```bash
make install
make test
make lint
make before-commit
```

開発中は変更に対応する検証を実施し、commit 前に `make before-commit` を通します。実 AWS・外部 IdP の確認は[大会リハーサル](./docs/host-rehearsal.md)に分けて記録します。

## ビジョン

自分で練習し、チームで競う。再利用できる問題をコミュニティーで共有し、開催者が自分たちの大会を組み立てられるようにします。

## 設計の書籍

[自分で作るクラウド競技](https://zenn.dev/bull/books/cloud-competition) · [Build Your Own Cloud Competition](https://leanpub.com/build-your-own-cloud-competition).
書籍は設計の背景を説明します。現行挙動の正本はこのリポジトリです。

## ライセンス

[Apache License 2.0](./LICENSE)。TenkaCloud は独立したオープンソースプロジェクトで、AWS との提携はありません。
