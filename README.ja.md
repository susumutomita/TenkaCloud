# TenkaCloud

[English](README.md)

TenkaCloud は、Bun の単一プロセスと永続 SQLite でクラウド競技を開催します。
開催者コンソールと参加者ポータルを host が配信します。
AWS の問題リソースは競技者アカウントに配置し、Docker 問題は手元の Docker で動かします。
参加者は開催者から受け取った URL とチームキーを使います。

このブランチは **未公開の host 専用 candidate** です。
SaaS、Lite、CDK/Lambda による基盤配置は廃止します。
`make local` は統合したローカル競技コンソールを開きます。
既存環境には[固定した旧版の手順](docs/legacy-operations.md)を使ってください。
自動移行や既存リソースの撤収は行いません。
[廃止と未対応の一覧](docs/host-retirement.md)には、未決の単体 deploy API も記載しています。

[![Historical overview](docs/assets/lp-30s/tenkacloud-30s-preview.gif)](landing/videos/lp/tenkacloud-30s.mp4)

旧 local/Lite 経路を収録した紹介映像です。host candidate の検証記録ではありません。 [Vertical video](landing/videos/lp/tenkacloud-30s-vertical.mp4).

## 起動

Bun 1.3.11 と固定した `problems/` カタログを使います。
開発ツールのバージョンは `mise.toml` にあります。

```sh
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
bun install --frozen-lockfile --ignore-scripts
bun run build:host
make local LOCAL_ARGS="--no-build"
```

プロセスが表示する開催者 URL を開きます。非公開の host キーを初回だけ使い、
最初のローカル Admin を作成します。次回からはそのアカウントのパスワードでログインします。
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
クラウド・Turso の配置方式は検証中のため、現在はリソースを作成・削除せずエラーで止まります。
旧 Lite の配置手順としては使えません。

106 件の Compose 問題を Challenge として表示し、エディターと明示的に許可された
15 件の参加者ターミナルに接続します。カタログと模擬ライフサイクルの検証は、
106 件すべての実 Docker 動作確認が完了したという意味ではありません。
それ以外の作者向けランタイムには対応していません。
Cryptography Battle は AWS や Docker daemon を必要としません。
AWS・Docker 問題には、それぞれの実行環境が必要です。

デフォルトの同時起動上限はチームあたり 3 環境、host 全体で 12 環境です。
コンテナーのメモリー上限の合計も 4096 MiB 以内に制限します。停止で保存済みデータを残し、
他チームの環境を自動停止しません。実機の Docker 容量は大会前に確認してください。
`make local LOCAL_ARGS="--help"` に設定項目を表示します。

公開 URL、TLS proxy、永続データと AWS 設定は[host の運用手順](docs/local-hosting.md)を参照してください。
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
