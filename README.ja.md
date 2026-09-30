# TenkaCloud

[English](README.md)

TenkaCloud は、Bun の単一プロセスと永続 SQLite でクラウド競技を開催します。
開催者コンソールと参加者ポータルを host が配信します。
AWS の問題リソースは競技者アカウントに配置し、Docker 問題は手元の Docker で動かします。
参加者は開催者から受け取った URL とチームキーを使います。

このブランチは **未公開の host 専用 candidate** です。
SaaS、Lite、CDK/Lambda による基盤配置と `make local` は廃止します。
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
make host HOST_ARGS="--no-build"
```

プロセスが表示する開催者 URL を開きます。非公開の host キーを初回だけ使い、
最初のローカル Admin を作成します。次回からはそのアカウントのパスワードでログインします。
大会とチームを作成し、問題環境を配置してチームキーを配り、大会を開始します。
サーバーを停止しても DB と問題環境は残ります。
問題環境の削除は、開催者が大会の Teardown 操作で実行します。

実行できる問題は host のカタログに表示されるものだけです。
作者向けカタログの全問題には対応していません。
Cryptography Battle は AWS や Docker daemon を必要としません。
AWS・Docker 問題には、それぞれの実行環境が必要です。

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
