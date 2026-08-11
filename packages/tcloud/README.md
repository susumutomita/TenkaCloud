# tcloud

TenkaCloud の machine API を叩く operator CLI です。Issue 2951。

人間が GUI にログインしなくても、CI や手元から問題をデプロイして完了まで見届けられるようにします。

## できること

```bash
tcloud auth login --client-id <id> --client-secret <secret>
tcloud auth status
tcloud auth logout

tcloud deploy <problemId> --account <awsAccountId> --region <region> --team <teamName>
tcloud deployments list
tcloud deployments get <jobId>
```

到達できる operation は machine API の 7 本だけです。障害注入、削除、チームログインキーの取得、管理系の操作は machine credential の role では到達できません。これは CLI の制限ではなくプラットフォーム側の設計です。

## 設定

secret 以外の設定は `~/.config/tcloud/config.json` に保存します。`XDG_CONFIG_HOME` を設定していればそちらに従います。

| 環境変数 | 内容 |
| --- | --- |
| `TCLOUD_MACHINE_API_URL` | tenant stack の CfnOutput `MachineApiUrl` |
| `TCLOUD_TOKEN_URL` | Cognito の `<domain>/oauth2/token` |
| `TCLOUD_CLIENT_ID` | machine client id |
| `TCLOUD_SCOPES` | 空白区切りの scope。`tc-tenant-<tenantId>/bind` を必ず含める |
| `TCLOUD_CLIENT_SECRET` | client secret。CI 用。ディスクには書きません |

環境変数が揃っていれば設定ファイルは不要です。

## credential の扱い

- **client secret は保存しない**。引数か環境変数で受け取り、その場で token に交換して捨てる。設定ファイルに secret らしき key を書こうとすると `assertNoSecrets` が失敗する。
- **access token は OS の keychain に cache する**。macOS は `security`、Linux は `secret-tool` を使う。token の TTL は 15 分で、その間は token endpoint を叩かない。M2M の実効コストはここで決まる。
- **keychain が無い環境では cache しない**。平文ファイルへ落とすことはせず、毎回 token を取得する旨を表示する。

## 終了コード

| コード | 意味 |
| --- | --- |
| 0 | 成功 |
| 1 | 引数または設定の誤り |
| 2 | API または認証のエラー |
| 3 | deployment が失敗状態で終了した |
| 4 | 待機がタイムアウトした (deployment は継続中) |

タイムアウトを成功に丸めません。CI が緑のままデプロイが失敗している状態を作らないためです。

## 依存関係

runtime 依存は 0 本です。引数パーサも HTTP client も標準機能だけで組んでいます。`npx` と `bunx` は使いません。
