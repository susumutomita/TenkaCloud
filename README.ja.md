# TenkaCloud

[English](README.md)

TenkaCloud は、開催者コンソールと参加者ポータルで競技を開催します。
ローカル開催は Bun の単一プロセスと永続 SQLite を使います。
クラウド開催は AWS Lambda と DynamoDB で復旧を進めています。
SaaS/SBT によるテナント構築は、この構成に含めません。

このブランチは **統合検証中の Draft** です。
`make local` は非 AWS 問題を競技できるローカルコンソールを開きます。
AWS サービスを使う問題はクラウド開催の対象で、配置から撤収まで検証中です。
参加者は開催者から受け取った URL とチームキーを使います。

既存環境には[固定した旧版の手順](docs/legacy-operations.md)を使ってください。
自動移行や既存リソースの撤収は行いません。
[互換性と対応状況](docs/host-retirement.md)に、実装済みのローカル機能、
クラウドの未結線部分、廃止した入口を記載しています。

[![Historical overview](docs/assets/lp-30s/tenkacloud-30s-preview.gif)](landing/videos/lp/tenkacloud-30s.mp4)

旧 local/Lite 経路を収録した紹介映像です。統合候補の検証記録ではありません。 [Vertical video](landing/videos/lp/tenkacloud-30s-vertical.mp4).

## 起動

Bun 1.3.11 と固定した `problems/` カタログを使います。
開発ツールのバージョンは `mise.toml` にあります。

```sh
git clone --recurse-submodules --branch integration/host-only-20261001 https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
bun install --frozen-lockfile --ignore-scripts
bun run build:host
make local LOCAL_ARGS="--no-build"
```

プロセスが表示する開催者 URL を開き、主催者キーだけでログインします。ユーザー名・パスワードは不要です。
初回のキーは対話ターミナルに一度だけ表示します。紛失時は `make local-reset` で再発行できます。
主催者のログインは失効しますが、大会・得点・参加者キー・問題環境は保持します。
大会とチームを作成し、問題環境を準備してチームキーを配り、大会を開始します。
Docker 問題は一斉起動せず、参加者が必要な問題をポータルから起動・再開します。
`make down` を別のターミナルで実行すると、このコンソールと所有する Docker 環境を停止します。
大会データ、鍵、コンテナーの書き込み領域とボリュームは保持します。
次の `make local` の後、オンデマンドの問題は参加者がポータルから再開します。
従来の一斉配置で作成した大会は、既存の再起動動作を維持します。
問題プロセスのメモリー内だけにある状態の保持は保証しません。
問題環境の削除は、開催者が大会の Teardown 操作で実行します。
通常の停止では SQLite、問題の seed と Compose 設定を保持します。
明示的な Teardown の成功後に、所有を確認できる生成ファイルだけを削除します。
古い一時ファイルや所有不明のファイルは自動削除しません。
詳しくは[生成ファイルと保持データ](docs/local-hosting.md#generated-files-and-retained-data)を参照してください。

クラウドのコマンドは `make deploy` と `make destroy` です。
標準の `CDKToolkit` があれば検証してそのまま再利用します。存在しない場合だけ、
同じコマンド内で初回 bootstrap を確認し、承認後に固定版の公式 `cdk bootstrap` を実行して配置を続けます。
標準 CDK の CloudFormation 実行 role はデフォルトで `AdministratorAccess` を使います。
この権限と呼び出し元の必要な権限を確認してください。呼び出し元へ権限を自動付与しません。
詳しくは[必要な AWS 権限の準備](infrastructure/README.md#current-checkouts-setup-and-teardown-boundary)を参照してください。
現在のクラウド問題は、限定した CLI アクセスを使う hello-world と、
DynamoDB に状態を保存する Cryptography Battle です。Docker / Compose 問題はローカル開催専用で、クラウドのカタログには表示しません。
Battle の一斉アクセス時の処理時間は、5 秒の更新間隔を超えています。撤収時はアカウント、リージョン、所有する対象を表示して確認し、
記録済みの問題環境を撤収します。大会データは保持します。保持ストレージや AWS の利用には料金が発生する場合があります。
`CLOUD_ARGS="--help"` を付けると、AWS に接続せずヘルプを表示します。
環境設定は `infrastructure/environments/{development,staging,production}/.env.example` を
同じディレクトリの `.env` にコピーして、開催者のメールアドレス、AWS アカウント ID、リージョンを編集します。
既存の `.env` は上書きしません。`make deploy ENV=development` で選んだ環境のファイルを読み込みます。
詳しくは[環境設定と初回セットアップ](infrastructure/README.md#current-checkouts-setup-and-teardown-boundary)を参照してください。
[クラウド pipeline](infrastructure/README.md#cloud-deployment-pipeline)は現行の配置経路を使います。
作成する CodeBuild role は広い配置権限を持つため、launcher の作成・build 開始前に
[bootstrap と呼び出し元の権限](infrastructure/BOOTSTRAP-IAM.md#first-account-setup)を確認してください。
旧版を使う詳細設定では元の完全な処理を維持します。
任意の `make -s deploy CLOUD_ARGS="--show-setup"` で標準 bootstrap をオフライン確認できます。
`--setup` は標準 Toolkit がない場合だけ作成します。無人での初回配置は内容の確認後に
`CLOUD_ARGS="--setup-if-needed --yes"` を明示してください。`--yes` だけではアプリケーション配置の権限変更を承認しますが、初回 bootstrap は承認しません。

106 件の Compose 問題を Challenge として表示し、エディターと明示的に許可された
15 件の参加者ターミナルに接続します。カタログと模擬ライフサイクルの検証は、
106 件すべての実 Docker 動作確認が完了したという意味ではありません。
ローカルの Docker 問題には Docker が必要です。
Cryptography Battle は AWS や Docker daemon を必要としません。
`make local` では AWS サービスの問題を実行しません。
Docker / Compose 問題はローカル開催専用です。組み込みの Cryptography Battle はローカルとクラウドの両方に対応します。

デフォルトの同時起動上限はチームあたり 3 環境、host 全体で 12 環境です。
コンテナーのメモリー上限の合計も 4096 MiB 以内に制限します。停止で保存済みデータを残し、
他チームの環境を自動停止しません。実機の Docker 容量は大会前に確認してください。
`make local LOCAL_ARGS="--help"` に設定項目を表示します。

公開 URL、TLS proxy、永続データは[host の運用手順](docs/local-hosting.md)を参照してください。
コンテナでは uid 1000 と専用の `/data` volume を使います。
[clean checkout と再起動の確認手順](docs/host-build-verification.md)を用意しています。
この変更で image や tag は公開していません。

## 問題を作る

問題の正本は [TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge) です。
公開 SDK と、ローカルで問題パックを作成・検証・保存する機能は継続します。

```sh
bun run pack init ./my-pack
bun run pack validate ./my-pack
bun run pack install ./my-pack
bun run pack list
```

pack の install / activate は、host の実行カタログへの追加を意味しません。
[pack の説明](scripts/problem-pack/README-external-git-pack.md)と
[対応表](docs/host-retirement.md)を確認してください。

開発は [CONTRIBUTING.md](CONTRIBUTING.md) と [AGENTS.md](AGENTS.md) を参照してください。
commit 前には `make before-commit` を実行します。
実 AWS・外部 IdP の確認は[任意の大会リハーサル](docs/host-rehearsal.md)として記録します。

## 設計の書籍

[自分で作るクラウド競技](https://zenn.dev/bull/books/cloud-competition) ·
[Build Your Own Cloud Competition](https://leanpub.com/build-your-own-cloud-competition).
書籍は設計の背景を説明します。現行挙動の正本はこのリポジトリです。
