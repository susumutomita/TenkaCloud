<!-- markdownlint-disable MD033 -->
<div align="center">

[English](./README.md) | **日本語**

# TenkaCloud

**本物のクラウドドリルを実行し、再利用できる AWS 問題カタログを育てる。**

TenkaCloud は、ハンズオン形式の AWS 競技会を運営するための、セルフホスト可能な Apache-2.0 ライセンスのプラットフォームです。運営者は 1 つのアプリケーションから、イベント・チーム・デプロイ・採点・ヒント・チームごとの AWS コンソール連携をまとめて管理でき、参加者は隔離されたアカウントの中で本物の AWS シナリオを解きます。

<table>
<tr>
<td width="50%" align="center" valign="top">

**A. まず遊ぶ** <sub>(推奨・AWS 不要・約 5 分)</sub>

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/susumutomita/TenkaCloud)

</td>
<td width="50%" align="center" valign="top">

**B. 自分のイベントを開く** <sub>(AWS アカウント・課金あり・約 30 分)</sub>

[**AWS にデプロイする →**](#aws-にデプロイする)

</td>
</tr>
</table>

<a href="./landing/videos/lp/tenkacloud-30s.mp4">
  <img src="./docs/assets/lp-30s/tenkacloud-30s-preview.gif" alt="30 秒でわかる TenkaCloud: ブラウザで遊ぶ → 得点する → AWS で自分のイベントを開く" width="800">
</a>
<br>
<sub>30 秒でわかる TenkaCloud (音声なし・日英字幕): ブラウザで遊ぶ → 得点 → AWS で自分のイベントを開く。<a href="./landing/videos/lp/tenkacloud-30s.mp4">16:9 MP4</a> · <a href="./landing/videos/lp/tenkacloud-30s-vertical.mp4">9:16 MP4</a></sub>

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

イベントへ招待された方は、**開催者から受け取った参加者画面の URL とチームキー**を使ってください。自分でデプロイしたり、ローカル環境を入れたりする必要はありません。

### ブラウザで試す(GitHub Codespaces、インストール不要)

<div align="center">
  <a href="./docs/assets/codespaces-local-mode/codespaces-local-mode-readme-1280x720.mp4">
    <img src="./docs/assets/codespaces-local-mode/codespaces-local-mode-readme-preview.gif" alt="GitHub Codespaces のローカルモードを日英 2 言語で 15 秒で紹介する動画" width="800">
  </a>
  <br>
  <sub>日英 2 言語で 15 秒: Codespaces → <code>make local</code> → ドリル起動 → ローカル採点。</sub>
</div>

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/susumutomita/TenkaCloud)

1. [main から Codespace を作成](https://codespaces.new/susumutomita/TenkaCloud)する。
2. 準備が終わるまで待つ。**Participant Portal も自動でプレビュータブに開く**。
3. ローカル用の問題を選び、**開始**を押す。画面が開かない場合は **PORTS → 5175 → プレビュー**を使う。

ここで遊べるのは Docker で動くローカル演習です。AWS が必要な問題は、下のデプロイ経路を使います。問題へのリンクは Codespaces のプレビュー内で開いてください。

> **任意の手動再実行:** 自動起動に失敗した場合は、コマンドパレットから **▷ ローカルプレイ開始**を実行します。

### ローカルで試す(AWS 不要)

必要なのは **Git、Make、Docker Engine、Docker Compose v2** です。Bun・Node・`node_modules` はホストに不要です。macOS・Linux・WSL2 に対応し、ネイティブ Windows では Codespaces を使えます。

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make local
```

表示された URL を開き、問題を選んで**開始**します。**最初のゴールは、その問題が求める答えを送信して結果を確認することです。**

- Docker Desktop: **Settings → Resources → Network → Enable host networking** を有効にする(4.34 以降)。
- 起動できない: `make doctor` で診断する。[必要な環境と対処方法](./docs/local-play-requirements.md)。
- 終了する: `make local-down` で停止する。**ローカルの進捗も消去される。**

<details>
<summary>開発者向け: 画面を編集しながら動かす</summary>

```bash
make local-onboard
make local-dev
```

Bun と Vite を使う開発用の経路です。[詳しい準備とコマンド](./docs/local-play.md)。

</details>

### AWS にデプロイする

1 つの運営グループで使うなら **Lite モード**を選びます。AWS アカウントと管理者用メールアドレスを用意し、[データベース](#運用コスト)と、次の構築方法を選びます。

| 構築方法 | 選ぶ場面 | ビルド費用 |
| --- | --- | --- |
| **手元から `make deploy`** | ツールを入れて、構築費用を抑えたい | 手元でビルドするため CodeBuild を使わない |
| **AWS コンソールからパイプライン** | 手元にツールを入れたくない | CodeBuild の実行時間に応じた料金がかかる |

どちらも同じ Lite 環境を構築し、作成した AWS リソースには利用料がかかります。[CodeBuild の料金・無料枠](https://aws.amazon.com/codebuild/pricing/)も確認してください。

#### A. 手元からデプロイする

Git・Make・Bash・zip・AWS CLI v2 と、[mise.toml](./mise.toml) の Bun・Node.js を用意します。AWS CLI のプロファイルまたは SSO で、デプロイ先のアカウントにログインしてください。

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make install
aws sts get-caller-identity
make env-init
```

作成された `infrastructure/environments/development/.env` の `AWS_ACCOUNT_ID`・`AWS_REGION`・`TENANT_ADMIN_EMAIL` を確認します。DB 費用を抑えるなら、この時点で [Turso の接続設定](./docs/running-costs.md)も追加してください。

```bash
make deploy
```

画面のビルド、CDK の初期準備、AWS リソースの作成、管理者への招待まで進み、最後に画面の URL が表示されます。[端末の準備・権限・詳しい手順](./DEPLOYMENT_GUIDE.md#lite-mode--local-terminal)。

#### B. AWS コンソールからデプロイする

1. [lite-pipeline.yaml](./infrastructure/templates/lite-pipeline.yaml) をダウンロードする。
2. [CloudFormation](https://console.aws.amazon.com/cloudformation/home?region=ap-northeast-1#/stacks/create/template) で **Upload a template file** を選び、スタック名を `tenkacloud-lite-launcher` にする。
3. **TenantAdminEmail** を入力する。DB 費用を抑えるなら **ControlDataBackend=turso** を選び、[Turso の接続設定](./docs/running-costs.md)も入力する。設定と IAM 権限を確認し、スタックを作成する。
4. 出力の **StartBuildConsoleUrl** を開き、**Start build** を押す。ここでデプロイが始まる。launcher の作成だけでは始まらない。
5. ビルド成功後、ログの末尾にある **Application Admin Console** を開く。[開催者マニュアル](./apps/developer-portal/src/app/developers/docs/manual/organizer/page.ja.mdx)に沿ってイベントとチームを作り、問題を選ぶ。

**最初のゴールは、テストチームで問題を開き、回答の得点が反映されることです。** 参加者を招待する前に確認してください。

パイプラインは初期設定の固定リリース、手元の `make deploy` は現在のチェックアウトを使います。[リリースの確認状況](./release/tenkacloud-release.md)([manifest](./release/tenkacloud-release.json))で、使う版を確認してください。[パイプラインの設定項目](./infrastructure/templates/README.md#cloudformation-console-lite-mode-deployment-pipeline)。

#### 必要な AWS 権限

- **構築担当:** CloudFormation の作成・更新、CDK のロールを引き受ける `sts:AssumeRole`、IAM ロールの作成・受け渡し(`iam:PassRole`)、S3 へのアップロード、Cognito の初期ユーザー作成などが必要。読み取り専用権限では構築できない。
- **初回の CDK 準備:** `make deploy` が `CDKToolkit` の作成・更新も行う。実行ロールの権限を AWS 管理者と確認する。[操作ごとの権限と対象リソース](./DEPLOYMENT_GUIDE.md#aws-permissions)。
- **イベント参加者:** 本体の構築権限は不要。AWS 問題を使うチームのアカウント連携は、別の[競技者用 bootstrap](./infrastructure/templates/README.md#competitor-bootstrapyaml)で設定する。

**イベント終了後:** 手元からは `make destroy`、パイプラインからは[撤去手順](./infrastructure/templates/README.md#撤去-teardown)を使います。launcher だけ消しても利用料は止まりません。

- **DynamoDB:** テーブルはデフォルトで削除される。保持する場合はデプロイ時に `CDK_PARAM_RETAIN_DATA_TABLES=true`(パイプラインは `RetainDataTables=true`)を設定する。
- **Turso:** `make destroy` ではデータの行が残る。管理データも消すなら、代わりに `make destroy-all` を使うか、SSM のトークンが使える撤去前に `make turso-reset` を実行する。どちらも DB 本体とスキーマは残るため、不要なら外部 DB も別途削除する。

## 運用コスト

| データベース | 選ぶ場面 | 費用への影響 |
| --- | --- | --- |
| **DynamoDB**(デフォルト) | 管理データを AWS 内で完結させたい | テーブルと索引の確保容量に継続的な費用がかかる |
| **Turso**(`ControlDataBackend=turso`) | データベースの費用を抑えたい | 管理データを Turso/libSQL に保存し、Lite は DynamoDB のテーブルと索引を作らない |

**Turso で抑えられるのは DB コストです。AWS 全体が無料になるわけではありません。** Turso の利用枠と、本体・選んだ問題の AWS 費用を確認してください。既存 DB の切り替えでは、データは自動移行されません。

[Turso の設定手順とコスト比較](./docs/running-costs.md)。手元のリポジトリでは `make turso-live ENV=development`(CLI は `tenkacloud turso-live`)で準備を進め、デプロイ前に確認できます。Turso 経路はユニットテスト・構成検査済みですが、実 Turso への一連のデプロイと請求確認は未記録です。

## 自分の問題を追加する

本体と問題は別々に管理します。問題を追加するために TenkaCloud 本体を fork する必要はありません。

| やりたいこと | 入口 |
| --- | --- |
| 問題を公開して共有する | [TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge)で作問・検証し、デプロイ時の `ProblemsRepoUrl` に自分の fork を指定する |
| 問題を非公開で使う | [Problem Pack のチュートリアル](./apps/developer-portal/src/app/developers/docs/tutorials/first-pack/page.ja.mdx)に沿って、自分のテナントへ追加する |

<details>
<summary>非公開 pack: 作成・検証・インストール・有効化</summary>

```bash
make pack-init ARGS="./my-pack --runtime aws/cloudformation"
make pack-validate ARGS="./my-pack"
make pack-install ARGS="./my-pack"
make pack-activate ARGS="com.example.starter@0.1.0 --tenant local"
```

`local` は Lite のテナント ID です。有効化後にデプロイすると pack が含まれます。pack の有効化は Lite 向けで、SaaS では有効な pack があると構成検査が停止します。

</details>

## ドキュメント

| やりたいこと | 読むもの |
| --- | --- |
| イベントを運営する | [準備から当日の運営まで](./apps/developer-portal/src/app/developers/docs/operate/run-an-event/page.ja.mdx) |
| LLM に構築や調査を手伝ってもらう | [LLM 用の入口](./landing/llms.txt) → [目的別ガイドとコードの見取り図](./landing/llms-full.txt) |
| 本体のコードを変える | [開発手順](./CONTRIBUTING.md) · [エージェント向け指示](./AGENTS.md) |
| 構成を理解する | [アーキテクチャの読み方](./docs/architecture/README.md) · [オンラインマニュアル](./apps/developer-portal/src/app/developers/docs/concepts/architecture/page.ja.mdx) · [システム構成図](./docs/architecture/diagrams/system-architecture.drawio) |
| 質問・相談する | [GitHub Discussions](https://github.com/susumutomita/TenkaCloud/discussions) · [お問い合わせ](https://forms.gle/djVprYmq3hFgJA7P9) |

## ビジョン

自分で練習し、仲間と競う。講座や研修サービスは今後の方向性です。まずは上の経路から、現在動く問題を試せます。

## 書籍

[『自分で作るクラウド競技』](https://zenn.dev/bull/books/cloud-competition) · [Build Your Own Cloud Competition](https://leanpub.com/build-your-own-cloud-competition)。
書籍は設計の理由を解説します。現行挙動の正本はこのリポジトリです。

## コントリビューション

[CONTRIBUTING.md](./CONTRIBUTING.md)で準備、変更のまとめ方、PR 前の確認を案内しています。

## ライセンス

[Apache License 2.0](./LICENSE)。TenkaCloud は独立したオープンソースで、Amazon Web Services, Inc. の提携・公認・スポンサー提供を受けたものではありません。
