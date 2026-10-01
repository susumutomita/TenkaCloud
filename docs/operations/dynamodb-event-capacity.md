# 旧 DynamoDB キャパシティ運用

このページは旧リンクのために残しています。現行 candidate の操作手順ではありません。
元の手順は[固定した旧版](https://github.com/susumutomita/TenkaCloud/blob/825415fcda5075ad723daf9e4514eac47d7b8bb9/docs/operations/dynamodb-event-capacity.md)を参照してください。
既存環境には、その環境を作成した正確な revision の手順を使います。

現行ローカル基盤は大会・チームを 1 つの Bun プロセスと SQLite で管理します。
Cognito や DynamoDB を構築せず、データの自動移行も行いません。

- [現在の起動と運用](../local-hosting.md)
- [現在のイベント Runbook](event-runbook.md)
- [任意の host SAML 設定](../host-saml.md)

`make local` が起動、`make down` がデータを保持する停止です。
クラウドの `make deploy` / `make destroy` は現行 CLI に接続しますが、この旧版手順の機能をすべて復旧したものではありません。現行の対応範囲と権限設定は [infrastructure/README.md](../../infrastructure/README.md) を参照してください。
