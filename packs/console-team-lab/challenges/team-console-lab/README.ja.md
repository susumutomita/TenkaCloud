# チーム専用攻撃ラボ

このカタログはデフォルトでは選択されません。レビュー済みの完全な Git commit を指定し、`packs/console-team-lab` を subdir として通常のカタログ取得手順で明示選択してください。

各チームに attack、Web、非公開 SQLite、採点用の兄弟コンテナを用意します。Terminal は自チームの participant build target にだけ接続します。curl、nmap、netcat、Python、sqlmap を固定ツールイメージに含めます。nmap は追加 capability を使わない TCP connect scan を使用します。

ベースイメージの digest と署名付き Debian snapshot の日付を固定しています。配置前にビルド結果の OCI digest と `/usr/local/share/tenkacloud-tool-versions.txt` を記録してください。ビルド時のパッケージ取得と、競技中の通信制限は別です。競技中は Internet を必要としません。

Kali／ARM64 の実機動作、実パケットの隔離、Tailscale と TLS の接続確認は、この参照カタログだけでは実証されません。対応する native Linux runner で別途確認してください。
