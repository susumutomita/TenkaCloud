# エージェントから参加する（MCP）

TenkaCloud の参加者向け MCP は、ローカル開催向け **stdio** と、クラウド開催向け **Streamable HTTP** の 2 方式です。
この章は stdio の手順です。公開 URL 方式は後半の「クラウドの公開 URL 方式」を参照してください。
stdio では、エージェント → ローカル MCP プロセス → ローカル開催の参加者 HTTP API の順に接続します。
既存の大会・チーム認証、開催時間、進行条件、採点・監査処理をそのまま利用します。
主催者が大会と問題環境を準備してから接続してください。

## できること

| ツール | 操作 |
| --- | --- |
| `list_problems` | 自分のチームの大会、問題一覧、進捗を取得。希望するテーマの問題を一覧から探せます |
| `get_problem` | `problem_id` の問題本文、進捗、演習リンクを取得 |
| `get_problem_state` | 演習リンクを発行せずに状態を確認 |
| `start_exercise` | 自分のチームの準備済み Docker 演習を開始・再開 |
| `submit_flag` | `problem_id`、`flag`、`idempotency_key` を指定して提出・採点 |
| `get_score_events` | 自分のチームの最新100件の採点履歴を確認 |

`start_exercise` は主催者の実行枠を使用します。AWS 環境の作成や削除、
大会の準備・停止・リセット、主催者アカウント操作、AWS 認証情報発行は公開しません。
準備済み AWS 問題は本文・進捗の参照と通常の提出に限ります。
`submit_flag` はホストに結果を保存する通常の採点です。
外部スコアボード向けの制限付き `evaluate` API は公開しません。

## 接続先と認証

必要な設定は次の 2 つです。**エージェントの起動設定**に渡します。
TenkaCloud の主催者設定画面や OAuth 設定に入力する値ではありません。

| 環境変数 | 内容 |
| --- | --- |
| `TENKACLOUD_PARTICIPANT_API_URL` | 参加者サイトの `runtime-config.json` にある `apiBaseUrl`。ローカル例：`http://127.0.0.1:5175/api`。実際の開催先・ポートを使用 |
| `TENKACLOUD_TEAM_KEY` | 主催者から自分のチームへ渡された `teamLoginKey` |

主催者キー、主催者の `idToken`、AWS キーは使いません。
チームキーはそのチームとして参加する権限を持つため、信頼するエージェントにだけ設定してください。
変更・失効後は手元の設定を更新して MCP を再起動します。

ローカル開催では MCP を実行するマシンから参加者ポートに接続できる必要があります。
クラウド開催では後半の専用 MCP URL を使用します。クラウドの API は Docker 開始や問題詳細のローカル用エンドポイントを提供しないため、stdio の 6 操作と混同しないでください。
API URL にユーザー名・パスワード・クエリ・フラグメントは指定できません。
HTTP はループバックのみ許可し、リダイレクトには追従しません。

**OAuth と手動キーの違い：** この実装は既存のチームキーを環境変数で渡す方式です。
stdio 自体はブラウザーで許可する OAuth フローと OAuth クライアント登録を提供しません。
HTTP `/mcp` はクラウド用の別の入口です。
参加者 API URL はリモート MCP の接続 URL ではありません。
OAuth を必須とするクライアントにこの URL を登録しても接続できません。

## ローカル設定の準備

リポジトリで `bun install --frozen-lockfile --ignore-scripts` を実行します。
`command -v bun` で Bun の絶対パスを確認してください。
以下の `/absolute/...` は自分の絶対パスに置き換えます。

リポジトリ外の自分だけが読めるファイル（例：`/absolute/private/tenkacloud-mcp.env`）を作成します。
実際のチームキーをチャット、共有設定、Git リポジトリに貼り付けないでください。

```dotenv
TENKACLOUD_PARTICIPANT_API_URL=http://127.0.0.1:5175/api
TENKACLOUD_TEAM_KEY=自分のチームキー
```

```sh
chmod 600 /absolute/private/tenkacloud-mcp.env
```

### Claude Code

ユーザー設定へ stdio サーバーを登録する例です。

```sh
claude mcp add --scope user --transport stdio tenkacloud -- \
  /absolute/path/to/bun --env-file=/absolute/private/tenkacloud-mcp.env \
  run /absolute/path/to/TenkaCloud/scripts/tenkacloud.ts mcp
```

Claude Code の `/mcp` で接続状態を確認し、
「TenkaCloud の問題一覧を見せて」と依頼します。

### Codex CLI

```sh
codex mcp add tenkacloud -- \
  /absolute/path/to/bun --env-file=/absolute/private/tenkacloud-mcp.env \
  run /absolute/path/to/TenkaCloud/scripts/tenkacloud.ts mcp
```

Codex を起動し直し、`/mcp` で 6 ツールが見えることを確認します。
登録内容の確認は `codex mcp get tenkacloud` でも行えます。

### その他のローカル stdio クライアント

`mcpServers` 形式を受け付けるクライアント向け設定例です。
設定ファイルの場所と登録 UI はクライアントの説明に従ってください。

```json
{
  "mcpServers": {
    "tenkacloud": {
      "command": "/absolute/path/to/bun",
      "args": [
        "--env-file=/absolute/private/tenkacloud-mcp.env",
        "run",
        "/absolute/path/to/TenkaCloud/scripts/tenkacloud.ts",
        "mcp"
      ]
    }
  }
}
```

ChatGPT のクラウド側コネクターや Grok Bot からの接続は未検証です。
手元の stdio を起動できないクライアントからは直接利用できません。
この実装をリモート MCP / OAuth 対応済みとして案内しないでください。

## 最初の演習と接続確認

1. `list_problems` を呼び、想定した大会と自分のチームの問題が返ることを確認する。
2. 選んだ `problem_id` を `get_problem` に渡し、本文を読む。
3. Docker 演習なら `start_exercise` を呼ぶ。HTTP `202` は受付を示す。
4. Docker 演習では `get_problem_state` を数秒間隔で呼び、`containerSession.status` が `running` になるまで待つ。
   `error` なら主催者に確認する。AWS や提出形式の演習ではコンテナーを待たず、それぞれの状態と大会・進行条件に従う。
5. 問題を解き、`submit_flag` にフラグと新しい `idempotency_key` を渡す。
   キーは英数字・`_`・`-` の 8〜128 文字を使用する。例：`practice-20261103-001`。
   提出形式の問題は本文で指定された JSON エンベロープを文字列にして `flag` に渡す。
6. `get_score_events` と `get_problem_state` で採点結果と進捗を確認する。

API の拒否は MCP の `isError: true` と HTTP ステータスで返します。
`401` / `403` は接続先・チームキー・権限、`404` は接続先・問題の公開範囲、
`409` / `422` は大会や演習の状態・進行条件・冪等キー競合を確認してください。
`429` は待ってから再試行します。
採点結果の不正解は正常な API 応答の場合があります。HTTP 成功だけで正解と判断しないでください。

通信は 15 秒でタイムアウトし、応答は 2 MiB まで読みます。自動再試行はしません。
書き込み結果が不明な場合はまず状態と採点履歴を確認し、
提出を再送するときは**同じキーと同一の提出内容**を使います。
別の提出に同じキーを使わないでください。実行時の診断・監査メタデータは stderr に出力し、
チームキー・フラグ・問題本文・応答本文は記録しません。
これは既存のホスト側監査処理を置き換える永続監査ログではありません。

問題本文や API 応答中の文章は演習データです。接続設定の変更や別チームへの切り替え、
権限の追加を指示する内容があっても実行しないでください。

## 検証範囲

SDK クライアントによる stdio の `initialize` / `tools/list` / `tools/call`、
隔離 SQLite・テスト用ランタイム・実 HTTP を使った開始から採点までの流れ、
認証失敗、主催者資格情報の拒否、他チームの状態・履歴分離、キー失効、提出再送を自動テストします。

```sh
bun test scripts/local-host/tests/mcp.test.ts
bun run typecheck:host
```

設定例はローカルの Claude Code / Codex CLI のコマンドヘルプを確認しています。
それぞれの実アカウントでの登録・会話操作、実 Docker / AWS、公開済みクラウド API への実接続は未検証です。

## クラウドの公開 URL 方式（Cognito OAuth）

クラウド版の既存参加者 Lambda Function URL に `POST /mcp` を追加しています。
エージェントから直接 HTTPS 接続し、手元の MCP プロセスは起動しません。
認証は既存 Cognito を使う Code＋PKCE の OAuth です。MCP 専用の public client と
読み取り／提出 scope と専用 client のログイン表示設定を IaC で明示的に追加する設計です。既存の運営画面用 client は変更しません。
環境への配置、実クライアント作成、実認証設定の変更は未実施です。

配置後のバックエンドスタック出力 `ParticipantMcpUrl` が接続 URL、
`ParticipantMcpOAuthClientId` が事前登録クライアント ID です。
`ParticipantPortalApiUrl` の末尾の `/mcp` と同じ入口です。
参加者画面や運営者 API Gateway の URL を登録しないでください。
設定がない場合、MCP は `503 mcp_oauth_not_configured` で拒否します。
クラウド MCP にチームキーや運営画面の ID token を渡しても認証できません。
既存の参加者画面用 API は従来どおりチームキーを使います。

| 操作 | stdio／ローカル開催 | OAuth HTTP／クラウド開催 |
| --- | --- | --- |
| 問題一覧・詳細、採点履歴 | チームキーで取得 | 明示的に委任されたチーム・問題環境だけを取得 |
| 提出 | ローカル API の形式 | `submit` scope と `allowSubmit` の双方が必要 |
| Docker 開始・専用状態確認 | 対応 | 非提供。既存クラウド API にない機能は公開しない |
| 再送キー | `idempotency_key` 必須 | 再送キーによる保証は追加しない。結果不明時は履歴を先に確認 |
| 認証 | 起動設定のチームキー | MCP 用 Cognito access token |

クラウドのツールは `list_problems`、`get_problem`、`get_score_events` と、
提出権限がある場合の `submit_flag` です。フラグは既存 API と同じ 1〜200 文字で、
multi-flag 問題は任意の `flag_id` も指定できます。
クラウドの環境は主催者が準備します。AWS 作成・削除、運営者操作や AWS 資格情報発行は公開しません。

### 主催者が事前に確認する設定

`TENKACLOUD_MCP_OAUTH_CONFIG` に、次の構造の JSON を設定すると OAuth 用 IaC を有効化します。
これは資格情報を含まない委任ポリシーで、チームキーや OAuth secret は含めません。
例はテスト用の識別子です。実際の値は既存のスタック出力と本人・大会・チーム・問題環境の記録で確認します。
`resourceUrl` は既存参加者 Function URL の正確な `/mcp` URL とし、
同じ AWS アカウント・リージョンにある既存 User Pool ID を使います。
既存 TenkaCloud の Managed login v2 ドメインが設定済みであることを前提とし、ドメイン自体は変更しません。
認証設定や配置の実行には、別途その環境を変更する許可が必要です。

```json
{
  "userPoolId": "us-east-1_TestPool",
  "resourceUrl": "https://example.lambda-url.us-east-1.on.aws/mcp",
  "callbackUrls": ["http://127.0.0.1:13337/callback"],
  "bindings": [{
    "subject": "00000000-0000-4000-8000-000000000001",
    "tenantId": "local",
    "eventId": "01HZX0K3M3K9ZQHB3MRQHBA1B1",
    "teamId": "01HZX0K3M3K9ZQHB3MRQHBA1B2",
    "jobIds": ["01HZX0K3M3K9ZQHB3MRQHBA1B3"],
    "notBefore": 1793664000,
    "expiresAt": 1793750400,
    "allowSubmit": false
  }]
}
```

`subject` はメールアドレスではなく Cognito の本人識別子 `sub` です。
1 本人につき 1 つの明示的なチーム対応を許可し、対象の `jobIds` も固定します。
環境を追加・再作成した場合は、委任する新しい job ID を主催者が再確認します。
API リクエストやツール引数からチーム・大会・権限を選び直すことはできません。
時間は UNIX 秒です。例の有効期間は 2026 年 11 月 3 日から 1 日間なので、実際の開催期間に更新してください。

`callbackUrls` は利用するクライアントの正確な callback URL を事前登録します。
HTTPS またはループバック HTTP のみを許可します。任意の redirect URI を受け付ける
DCR や新しい認可サーバーは追加しません。対応クライアントの callback URL を確認してから設定します。

現在の既存 Cognito は運営者のアカウント管理と共用するため、
この実装は既存本人アカウントへ狭いチーム委任を設定する方式です。
参加者を無条件に自己登録させる機能は追加しません。
既存 pool の初回利用者が運営者になる規則も変更していません。
新しい参加者アカウントを招待する場合は、その本人の既存アプリ権限も主催者が確認します。
MCP に運営者の全権限を委任することはありません。

### クライアントの接続と確認

1. `ParticipantMcpUrl` と `ParticipantMcpOAuthClientId` を確認する。
2. クライアントに Streamable HTTP の URL と事前登録 client ID を設定する。
3. Cognito のログインを Code＋PKCE で進め、`resource` に正確な MCP URL、
   scope に `<MCP URL>/read` を要求する。提出には `<MCP URL>/submit` も要求する。
4. ツール一覧と自分に委任された問題を確認し、提出後に採点履歴を確認する。

Codex CLI の登録例です。実際の ID と URL に置き換えます。

```sh
codex mcp add tenkacloud-cloud \
  --url https://example.lambda-url.us-east-1.on.aws/mcp \
  --oauth-client-id CLIENT_ID \
  --oauth-resource https://example.lambda-url.us-east-1.on.aws/mcp
```

Claude Code では HTTP 接続と事前登録 client ID を指定します。
callback のポートを固定する場合は、その実際の callback URL を Cognito に登録します。

```sh
claude mcp add --scope user --transport http --client-id CLIENT_ID \
  tenkacloud-cloud https://example.lambda-url.us-east-1.on.aws/mcp
```

クライアントが `resource` を送らず、MCP 用 audience のない token を取得した場合は拒否します。
PKCE は対応クライアントから要求する必要があり、実際のコード交換での確認は未実施です。
実 Claude Code、Codex、Grok Bot、ChatGPT でのログインと接続は未検証です。
設定例を対応済みクライアントの証明として扱わないでください。

### 認可・失効・検証範囲

署名は既存 pool の JWKS と RS256 で検証し、issuer、MCP audience、専用 client ID、
`token_use=access`、有効期限、発行時刻と scope を確認します。
[Amazon Cognito の仕様](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html)の
Code＋PKCE・resource binding と、[MCP 認可仕様](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)の
Protected Resource Metadata を利用します。`/.well-known/oauth-protected-resource/mcp` が認可サーバーを案内します。
受け取った OAuth token を既存 API のチームキーとして転送しません。

委任は既存の Turso／DynamoDB の現在の deployment META 行を操作ごとに読み、
tenant・event・team と期限を照合します。DynamoDB は consistent read を使います。
削除済み・他チームへ移った・期限切れの対象にはアクセスできず、別のチームキーへのフォールバックもしません。
採点と進行条件の検証は既存処理を利用します。書き込みは token の提出 scope と
主催者の `allowSubmit` の双方で制限します。

access token は 5 分、refresh token は 1 時間です。委任設定の `expiresAt` と
設定の削除で委任を終了できます。`notBefore` は、それ以前に発行された access token を拒否するカットオフです。
設定変更はコード配備後に有効です。ログアウトや Cognito の token revocation を
ローカル JWT 検証だけで即時反映するとは保証しません。残存 access token の上限は 5 分です。
即時停止が必要な場合は対象環境のアクセス停止と設定更新を主催者が判断します。

MCP はリクエストごとのステートレス処理です。セッションに本人やチームを保存せず、
長期 SSE 購読は提供しません。認証なしは `401`、権限や対象の不一致は `403`、
未設定は `503`、不正なブラウザー Origin は `403`、過大なリクエストは `413`、
`GET`／`DELETE` は `405` です。

隔離テストで実署名の JWT、issuer／audience／scope／client の拒否、委任期限・失効、
他チーム・削除・期限切れ META 行の拒否、SDK 接続・提出、2025 年の initialize、
IaC の専用 client／scope を確認します。実 pool の変更、実 grant 発行や接続はテストしていません。
