# machine (M2M) credential 運用 Runbook

Issue 2948 / 2952 / 2954、ADR-0005。CLI・CI・agent operator が Tenant API を叩くための machine credential を、発行・棚卸し・失効するための手順。

## 前提 (プラットフォームの設計)

- machine 経路は deploy 時 opt-in。`CDK_PARAM_FEATURES='{"machineTokenPath":true}'` を渡した tenant stack だけが capability resource server と machine 専用 API を持つ。
- OFF のとき capability resource server が存在しないため、Cognito は `tenkacloud/*` scope をそもそも発行できない。設定が空だから安全なのではなく、発行できないから安全である。
- machine principal の role は `TenantMachine` で、既存のどの `requireRole` allowlist にも含まれない。したがって破壊的操作は allowlist の外側であるだけでなく、role の上でも到達不能である。
- access token の TTL は 15 分。**失効は即時ではない**。どの失効操作も、発行済み token が最大 15 分だけ生き残る。
- 到達できる operation は 7 本だけで、正本は `infrastructure/lib/problem-deploy/handlers/shared/machine-scopes.ts` の `MACHINE_ROUTE_SCOPES` である。

## credential を発行する

```bash
scripts/issue-machine-client.sh create \
  --user-pool-id <tenant UserPool ID> \
  --tenant <tenantId> \
  --preset read|deploy \
  --region ap-northeast-1
```

- `read` preset は `tenkacloud/ops.read` のみ。`deploy` preset は read に加えて `tenkacloud/ops.deploy` を持つ。
- client secret は **1 回だけ標準出力に出る**。ファイルにも SSM にも保存されない。受け取った側が secret manager へ入れる。
- 出力を取りこぼしたら、その client は捨てて発行し直す。secret を後から読む経路は無い。
- tenant 向けの self-service 表示は無い。secret を `tenantConfig` 経由で SPA に載せてはならない。
- machine API の base URL は tenant stack の CfnOutput `MachineApiUrl` にある。要求できる scope は `MachineOAuthScopes` にある。

### resource server quota

`create` は per-tenant の bind resource server を作る前に、UserPool の resource server 数を数える。デフォルトの quota は 25 で、20 を超えると警告し、25 に達すると失敗する。上限を引き上げている場合は `--quota-limit` で実際の値を渡す。

> quota の実際の上限値は Service Quotas コンソールで確認すること。ドキュメント上の記述はリージョンと時期で食い違うことがある。

## 棚卸しする

```bash
scripts/issue-machine-client.sh list --user-pool-id <id> --tenant <tenantId>
```

client id、client name、許可 scope をタブ区切りで出す。**secret は出さない**。

## 失効する

失効には粒度が 2 つある。どちらを使うかは「1 本を殺す」のか「その tenant の machine 経路そのものを殺す」のかで決まる。

### 1. credential 1 本を殺す

```bash
scripts/issue-machine-client.sh revoke --user-pool-id <id> --client-id <clientId>
```

app client を削除する。その client からは以後 token を取得できない。**既に発行済みの access token は最大 15 分間まだ通る**。

### 2. tenant の machine 経路を殺す (kill switch)

```bash
scripts/issue-machine-client.sh revoke-tenant --user-pool-id <id> --tenant <tenantId>
```

その tenant の `tc-m2m-<tenantId>*` app client を全部消し、`tc-tenant-<tenantId>` bind resource server も消す。bind resource server が無くなると Cognito は `tc-tenant-<tenantId>/bind` scope を発行できなくなり、新しい token は machine principal として解決されなくなる。

**deploy は不要**。bind resource server が CloudFormation 管理外なのは、この kill switch を成立させるためである (ADR-0005 §5)。

ここでも **既に発行済みの access token は最大 15 分間まだ通る**。それより速く止める必要がある場合は、`features.machineTokenPath` を落として tenant stack を deploy し、machine API 自体を消す。

### 3. tenant を削除する場合

`scripts/deprovision-tenant.sh` が silo / pooled どちらの経路でも上記 2 と同じ回収をする。pooled tier は UserPool を tenant 間で共有するため、この回収が無いと **削除済み tenant の credential が共有 pool 上に有効なまま残る**。

## machine の操作を追跡する

追跡先は操作の種類で分かれる。

| 操作 | 記録先 | 引き方 |
| --- | --- | --- |
| deploy (mutation) | admin audit log | `action=deploy_problem`、`actor=m2m:<clientId>` |
| guard による拒否 | admin audit log | `outcome=forbidden`、`target` に拒否理由 |
| read (GET 7 本のうち 6 本) | machine API の access log | CloudWatch Logs の該当 LogGroup |

admin console の Audit Log 画面と CSV export では、`principal` に末尾 `*` を付けると prefix 一致になる。`m2m:*` と入れると machine principal の行だけが残る。client id は発行のたびに変わるため、完全一致だけでは machine 全体を引けない。

```text
principal: m2m:*
```

### read を access log から追う

machine API の stage には JSON 形式の access log が付いている。CloudWatch Logs Insights で次のように引く。

```text
fields @timestamp, httpMethod, resourcePath, status, ip, caller
| filter status >= 200
| sort @timestamp desc
```

**machine の read は admin audit log に残りません**。このリポジトリには read を audit 行にする前例が 1 つも無く、read ごとに DynamoDB へ 1 write するのは `DynamoDbLowCapacity` で 1 WCU に固定された table に対して割に合わないためです。Issue 2911 が求める「完全な監査」は現時点で **部分達成** であり、read については access log が正本になります。

### 追跡できないこと

- **tenant suspension は machine principal に効かない**。suspension はプラットフォーム全体で現状 inert であり、machine が gate されていると読んではならない。
- access log は `client_id` を直接持たない。read を特定の credential に紐づける必要がある場合は、`caller` フィールドと発行時刻から突き合わせる。

## 検証済みでないこと

以下は live AWS でしか確認できず、まだ実行していない。運用に入れる前に非本番 stage で一度実演し、その結果をこの節に追記すること。

- `/oauth2/token` が `client_credentials` で token を返すこと (MFA 必須の UserPool 上で)。
- read preset の client が `tenkacloud/ops.deploy` を要求したときに `invalid_scope` で拒否されること。
- read token で `POST /problems/{id}/deploy` を叩いたときに gateway が 401 を返すこと。
- tenant A の client が `tc-tenant-B/bind` を要求したときに `invalid_scope` で拒否されること。
- `delete-resource-server` 後に新規 token が bind scope を持たないこと。
- 実際の M2M 課金額。
