---
name: tenkacloud-setup
description: TenkaCloud の make local を、利用者と対話しながらセットアップする。環境を調べ、開催の目的を聞き、make install を実行し、起動コマンドを組み立て、起動や演習の失敗を出力から診断する。「セットアップして」「make local が起動しない」「ローカルで大会を開きたい」や、"set up TenkaCloud" "make local fails" と頼まれたときに使う。
---

# TenkaCloud のセットアップ

利用者がこのリポジトリで `make local` を起動し、主催者コンソールに入るところまでを、対話しながら進める。利用者が書いた言語 (日本語か英語) で答える。1 から順に進め、各段の結果を短く伝えてから次へ進む。

## 守ること

- ホストを起動する `make local` と、主催者キーを再発行する `make local-reset` を、Bash ツールで実行しない。コマンドを組み立てて示し、利用者に自分の端末で実行してもらう。主催者キーは stdin と stdout がどちらも TTY のときだけ表示され (`scripts/local-host/organizer-key-output.ts`)、Bash ツールは TTY ではない。`make local` を Bash ツールで実行してよいのは、フラグを確かめる `make local LOCAL_ARGS="--help"` のときだけである。
- 主催者キーを取り出さない。`script` などで疑似端末を作ってコマンドを実行しない。出力をファイルへ書き出してキーを探さない。
- 主催者キーとチームキーを会話に貼るよう求めない。主催者キーが貼られたら、漏れたキーとして扱う。利用者が自分の端末で `make local-reset` を実行して差し替えるよう勧める。`make local-reset` が差し替えるのは主催者キーだけで、チームキーは変わらない。チームキーが貼られたら、主催者コンソールの該当大会のチーム一覧で、そのチームの「キーを再発行」を実行してもらう。現在のキーは直ちに使えなくなる。新しいキーは、そのチームに配り直す。
- プロンプトの先頭に `!` を付けて起動コマンドを実行する方法は案内しない。
- 次の操作は、何が消えるかを示し、利用者が明示的に了承したときだけ行う。`make local-clear`、`make destroy`、`make destroy-all`、大会データの削除、Docker 環境の削除 (主催者コンソールの Teardown を含む)、`docker system prune`、`docker network prune`。`make local-clear` は確認を求めるので、利用者が自分の端末で実行する。確認を省くフラグは付けない。
- 利用者が `--data <dir>` を付けて起動している、または付けたい場合は、1 で `<data-dir>` として記録する。`make down`、`make local-reset`、`make local-clear` には、起動と同じ `--data` を必ず付ける (`make down LOCAL_ARGS="--data <data-dir>"`)。このスキルが示す `make local` の起動コマンドと再起動コマンドにも、すべて `--data <data-dir>` を足す。付けないと、既定のデータディレクトリを操作して、動いているホストに届かない。
- `.env` と秘密情報を読まない。`.claude/settings.json` も読み取りを禁止している。
- `npx` と `bunx` を使わない。
- firewall と、Tailscale の ACL や共有の設定を変更しない。手順を示すだけにする。
- ツール (mise、Bun、Docker、Tailscale) の導入や起動は、コマンドを示し、利用者の了承を得てから行う。

## 1. 環境を調べる

読み取りだけのコマンドで次を調べ、結果を表にして利用者に見せる。足りないものがあれば、入れ方を示す。

- OS。macOS、Linux、WSL2 のどれか。
- `git` と `make` があるか。
- Bun の版。`mise.toml` の `bun` と同じ版が要る。mise があれば、利用者に `mise.toml` を確かめてもらってから、`mise trust`、`mise install` の順に進める (`CONTRIBUTING.md`)。
- Docker。Docker 演習を使うときだけ要る。暗号バトルのように Docker を使わない問題は、Docker なしで動く。種類 (colima、Docker Desktop、Linux の Docker Engine)、`docker info --format '{{.ServerVersion}}'` の版、`docker compose version --short` の版を調べる。
- ポート。5174 (主催者コンソール)、5175 (参加者ポータル)、5200-5239 (演習の gateway) を待ち受けているプロセスがないか。macOS では `lsof -nP -iTCP:5174-5175 -sTCP:LISTEN` と `lsof -nP -iTCP:5200-5239 -sTCP:LISTEN` を使う。
- 既存の `make local` が `--data <dir>` 付きで動いているか、利用者に聞く。付いていれば `<data-dir>` として覚える。
- 環境変数 `CODESPACES` が `true` なら Codespaces である。`parseOptions` は `--lan` などを付けない起動で、Codespaces の公開 origin を自動で選ぶ (`scripts/local-host/options.ts`)。2 と 4 と 5 は使わず、3 の後、`LOCAL_ARGS` なしの `make local` を 6 で示す。LAN と分離ありの選択肢は出さない。README の Codespaces の節を案内する。

## 2. 目的を聞く

AskUserQuestion で、次の 4 つから選んでもらう。1 で Codespaces と分かったときは聞かず、3 へ進む。

| 選択肢 | 進め方 |
| --- | --- |
| この PC で 1 人で試す | 3 の後、6 で `make local` を示す。`<data-dir>` があれば `LOCAL_ARGS="--data <data-dir>"` を付ける |
| 信頼できる仲間と LAN か Tailscale で開催する | 3 の後、4 へ進む |
| チーム間の分離ありで開催する (native Linux) | 3 の後、4 の 1 だけで待受 IP を決め、5 へ進む。4 の 2 から 7 は使わない |
| クラウドで開催する | このスキルの対象外。README の「Deploy on AWS」(日本語版は「AWS にデプロイする」) の節と `make deploy` を案内して終える |

## 3. 依存を入れる

リポジトリのルートで、Bash ツールから `make install` を実行する。mise で Bun を入れた場合は `mise exec -- make install` を使う。失敗したら、出力から原因を伝える。

## 4. LAN か Tailscale で開催する

1. 待受 IP を決める。Tailscale なら `tailscale ip -4` の値を使う。LAN なら、この PC のプライベート IPv4 を利用者と確かめる。`--lan` が受け付けるのは 10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、100.64.0.0/10 の IPv4 で、`0.0.0.0` は受け付けない。
2. `--unsafe-lan` の意味を伝える。通信は暗号化しない HTTP になる。信頼できる隔離されたネットワークでだけ使い、インターネットへポートを転送しない。
3. 開けるポートを伝える。参加者向けの TCP 5175 を開ける。Docker 演習を使うときだけ、TCP 5200-5239 (`--gateway-ports` の既定値) も開ける。5174 は開けない。主催者コンソールは `127.0.0.1` だけで待ち受け、主催者はこの PC で `http://127.0.0.1:5174/` を開く。
4. firewall と Tailscale の ACL・共有は、手順を示すだけにする。Tailscale の手順は、`apps/developer-portal/src/app/developers/docs/getting-started/page.ja.mdx` の「Tailscale 未接続の端末から参加する」節にある。英語版は `apps/developer-portal/src/app/developers/docs/getting-started/page.mdx` である。
5. Mac や分離を使えない環境で `--lan` を付けて起動すると、Docker 演習は `network_isolation_required` で拒否される。参加者全員を信頼できるときだけ、`--unsafe-docker-lan` を選択肢として示す。示すときは次を伝える。
   - チーム間のネットワーク分離がなくなる。各チームの演習から、ほかのチームの演習、この PC、LAN に届く。
   - `--competition-network`、`--vpn-peers`、公開 origin とは組み合わせられない。
   - 分離ありで準備した大会は、このフラグを付けても開始できない。新しい大会を作る。
6. 起動コマンドを組み立てる。`<host-ip>` は 1 で決めた IP に置き換える。

   ```sh
   make local LOCAL_ARGS="--lan <host-ip> --unsafe-lan"
   ```

   信頼できる仲間と Docker 演習を使うときは、次のコマンドにする。

   ```sh
   make local LOCAL_ARGS="--lan <host-ip> --unsafe-lan --unsafe-docker-lan"
   ```

7. 参加者には、起動時に表示される `http://<host-ip>:5175/` と、そのチームのキーだけを渡すよう伝える。

## 5. チーム間の分離ありで開催する

native Linux だけが対象である。起動時に `scripts/local-host/linux-network-guard.ts` が前提を確かめ、満たさなければ起動を拒否する。起動の前に、次を利用者と確かめる。設定は変更しない。

- `docker info --format '{{json .}}'` で、`ServerVersion` が 28.4.x、`OperatingSystem` が Docker Desktop でない、`SecurityOptions` に rootless がない。
- `docker context inspect --format '{{.Endpoints.docker.Host}}'` が `unix:///var/run/docker.sock` である。
- 環境変数 `DOCKER_HOST` が未設定か、ちょうど `unix:///var/run/docker.sock` である (`echo "${DOCKER_HOST-}"`)。ガードは `DOCKER_CONTEXT` を見ず、`DOCKER_HOST` の値を直接読む。別の値なら、利用者が `unset DOCKER_HOST` してから起動する。
- `/proc/sys/net/bridge/bridge-nf-call-iptables` と `/proc/sys/net/bridge/bridge-nf-call-ip6tables` が `1` である。
- 起動したプロセスが、`iptables`、`ip6tables`、`nsenter` を root の権限で実行できる。権限の与え方は利用者が決める。

`--docker-network-pool` の値を、利用者と一緒に決める。

- 境界のそろったプライベート IPv4 の /16 から /24 で、10.0.0.0/8、172.16.0.0/12、192.168.0.0/16 のどれかに入る。
- `ip -j route show table all` と `ip -j -6 route show table all` に出る経路と重ならない。LAN と VPN の経路も同じ表に出る。`dst` が `default` の経路は比べない。ガードも `default` を飛ばす。すべての IPv4 の範囲が `default` と重なるので、含めると選べる値がなくなる。

起動コマンドは次のとおり。`<data-dir>` を記録していれば `--data <data-dir>` も足す。`<host-ip>` は 4 の 1 で決めた IP、`<pool-cidr>` は決めた値に置き換える。`<host-ip>` が決まっていなければ、先に 4 の 1 を済ませる。

```sh
make local LOCAL_ARGS="--lan <host-ip> --unsafe-lan --competition-network --docker-network-pool <pool-cidr>"
```

## 6. 起動してもらう

1. 組み立てたコマンドを示し、利用者に自分の端末で、リポジトリのルートから実行してもらう。迷ったら `make local LOCAL_ARGS="--help"` でフラグを確かめる。
2. `make local` は起動の前に、`catalog-sources.json` の取得元から問題を取得して build する。取得にはネットワーク接続が要る。
3. 起動すると、端末に `Host console:` と `Participant portal:` の URL が出る。主催者キーは `Organizer key (shown once):` の行に一度だけ出る。利用者はこのキーで主催者コンソールにログインする。キーは会話に貼らないよう伝える。Codespaces では、起動してもキーは表示されない。利用者が非公開の対話端末で、同じデータディレクトリを指定して `make local-reset` を実行し、キーを表示する。このとき古い主催者セッションは失効する。主催者のポート 5174 は Private のままにする。
4. 起動を確かめるときは、Bash ツールで `curl --fail http://127.0.0.1:5174/healthz` を実行する。LAN では `curl --fail http://<host-ip>:5175/healthz` も実行する。
5. この後の大会・チーム・問題の作成とキーの配布は、README のクイックスタートの手順に従う。
6. ホストを止めるときは、利用者が別の端末で `make down` を実行する。`--data` 付きで起動したなら、同じ `--data` を付ける。大会データは残る。

## 7. 失敗を診断する

起動や演習の開始に失敗したら、利用者に、エラーの行だけを見せてもらう。端末の出力全体は求めない。主催者キーとチームキーは、見せる前に伏せてもらう (`Organizer key (shown once):` の行は特に注意する)。キーが見えたら、漏れたキーとして扱い、「守ること」の手順で差し替えを勧める。次の表で原因を答える。表にない出力は、その文を `git grep -F` でリポジトリから探し、出している箇所のコードを読んでから答える。推測で答えない。

| 出力に含まれる文 | 原因 | 直し方 |
| --- | --- | --- |
| `Another catalog operation is active.` (`Catalog import failed; startup/build stopped.` に続く) | 中断した実行が `.tenkacloud/catalog-store/mutation.lock` を残した | `ps` で `make local`、`make deploy`、問題の取得が動いていないことを確かめる。動いていなければ、利用者の了承を得て `rmdir .tenkacloud/catalog-store/mutation.lock` で消し、起動し直してもらう |
| `Catalog import failed; startup/build stopped.` に `Check catalog source configuration, access and validation.` が続く | 問題の取得元に届かないか、取得した内容が検証を通らない | ネットワーク接続と `catalog-sources.json` の取得元を確かめる。`catalog-sources.json` は利用者の了承なしに変えない |
| `Retained unisolated Docker environments prevent remote hosting:` | 分離なしで作った Docker 環境が残っている | 参加者全員を信頼できるなら `--unsafe-docker-lan` を付けて起動する。そうでなければ、`--lan` なしで起動し、主催者コンソールの Teardown で消してから起動し直す。Teardown は了承を得てから案内する |
| `Remote Docker exercises require --competition-network` (`network_isolation_required`) | Mac や分離を使えない環境で、`--lan` を付けて起動した | native Linux で 5 の前提を満たせるなら、5 の起動コマンド (`--competition-network` と `--docker-network-pool` 付き) で起動し直してもらう。満たせないホストだけ、2 の目的を見直す。信頼できる仲間だけなら、4 の説明を添えて `--unsafe-docker-lan` を示す |
| `This event was prepared with network isolation` | 分離ありで準備した大会を、分離の指定がない、または分離できないホストで開始しようとした | 先に、5 の起動コマンドで起動し直してもらう。native Linux で 5 の前提を満たせるなら、これで大会を作り直さずに済む。前提を満たせないホストだけ、新しい大会を作る |
| `Docker daemon is unavailable.`、`The Docker daemon looks unreachable`、`Docker exercises are unavailable:` | Docker CLI か Compose が入っていない、または Docker daemon が止まっている (`Docker exercises are unavailable:` はどれでも出る) | `docker compose version` と `docker info` を別々に実行してもらう。`docker compose version` が失敗したら、Docker (CLI と Compose プラグイン) を入れる。`docker info` が失敗したら、daemon を起動する。colima なら `colima start`、Docker Desktop ならアプリを起動、Linux なら `sudo systemctl start docker`。その後、ホストを起動し直す。大会中なら、止める時間を参加者と決めてから行う |
| `Docker has no free network address pool.`、`The configured Docker network pool has no free compact subnets.` | Docker のネットワークアドレスが足りない | `docker network ls` で一覧を見せる。消すかどうかは利用者が決める。分離ありなら、経路と重ならない広い `--docker-network-pool` を選ぶ |
| 起動し直したのに画面が古い | ブラウザが古い JS を使っている | Cmd+Shift+R (Linux と Windows は Ctrl+Shift+R) で再読み込みする |
| `This local host already has a live owner. Use make down first.`、`Cannot acquire the local controller lock; another process may own it.` | 同じデータディレクトリで、別の `make local` が動いている | 止めてよいかを利用者に確かめ、`make down` を実行してもらう。`--data` 付きで起動しているなら、同じ `--data` を付ける。大会データは残る |
| Bun が出す "Failed to start server. Is port 5174 in use?" (ポート番号は変わる)、`Exercise gateway port` で始まる文 | ほかのプロセスがそのポートを使っている | `lsof -nP -iTCP:<port> -sTCP:LISTEN` で持ち主を見せる。止めるかは利用者が決める。gateway の範囲は `--gateway-ports` で変えられる |
| `LAN mode uses HTTP, not TLS.` | `--lan` に `--unsafe-lan` を付けていない | 4 の 2 を説明してから `--unsafe-lan` を足す |
| `--lan requires an explicit private IPv4 address of this host` | `--lan` の値が、受け付ける範囲のプライベート IPv4 でない | 4 の 1 で IP を決め直す |
| `Run make local-reset in an interactive terminal to obtain a new key` (Organizer key initialized か retained に続く) | 対話できない端末で起動した (出力のリダイレクトや Bash ツール) | 利用者が自分の端末で `make local-reset` を実行して、新しいキーを表示する。`--data` 付きで起動しているなら、同じ `--data` を付ける |
| `Competition networking currently supports native, rootful Linux Docker Engine 28.4.x only.`、`Both bridge netfilter families must already be enabled`、`--docker-network-pool must be an aligned private IPv4 /16 through /24 network` | 5 の前提を満たしていない | 5 に戻り、満たしていない前提を利用者と確かめる。設定は利用者が変える |
