# ADR-004: Event / Team モデルを正本にして、Deployment を (Event, Team, Problem) の派生にする

- **Status**: Proposed (2026-05-07)
- **Related ADR**: [ADR-001](./adr-001-problem-deploy-crud.md) (FR-1 / FR-6 を本 ADR で具体化)、[ADR-003](./adr-003-problem-catalog-ddb.md) (Problems の正本)
- **Related issues**: #471 (problem-detail から deploy/削除)、Participant Portal 削除 UX 不在

## Context

現状実装は **「1 deployment = 1 (problem, team, account, region) の組み合わせ」** で、`teamLoginKey` も per-deployment に発行している。これは要件文書 [`docs/requirements/problem-deploy.md`](../requirements/problem-deploy.md) の FR-1 / FR-6 と整合しない。

要件側の前提は次のとおり。

- **FR-1**: 1 batch = 25 チーム × 30 問 = **750 stacks**。チームと問題は **2 軸**
- **FR-6**: operator UI は「(1) 競技者アカウントの接続情報を登録 → (2) 25 × 30 の Challenge セットを選択して Deploy」(= **Event 単位の操作**)
- ユーザ要望 (2026-05-07):「イベント作成時にやることは参加するチーム数を指定する。次にどの問題をデプロイするのか選ぶ (複数選べる、かつどのアカウント、どのリージョンにデプロイするのか問題ごとに指定できる)」

つまり実体としては次のような階層がある。

```
Event (1)                              ← 1 競技イベント (例: "JAWS-UG 春の陣 2026")
 ├─ Teams [N]                          ← 参加チーム
 │   ├─ teamLoginKey (team scope)      ← 1 team = 1 key (event 中の M 問題で共有)
 │   └─ displayTeamName / 内部 slug
 └─ Deployments [N × M]
     └─ (team_i, problem_j, awsAccount, region)
         status / stackId / stackOutputs / score / ...
```

現状コードは Event / Team を概念として持たず、Deployment が単独で立っているため次の問題が出る。

1. **チームに loginKey が複数発生する**: `team-alpha` が 30 問 deploy されると 30 個の `teamLoginKey` が発行され、競技者は問題ごとに別の key で login しなおす羽目になる
2. **Operator が「イベント単位」で操作できない**: 750 stacks の create / status 把握 / cleanup を 1 ボタンで実行する経路がない (現状は ProblemDetail から 1 件ずつ deploy する手動運用)
3. **Participant Portal で「自チームの全問題」を見せられない**: GSI2 が `TEAMKEY#<key>` だが、key が deployment ごとに変わるので 1 key で複数 deployment を引けない

## Decision

### 1. 3 つの Aggregate を別 DDB Table に立てる (= TenkaCloud の流儀)

CLAUDE.md の方針「DynamoDB シングルテーブル設計はしない。stack ごとに専用テーブル」に従う。`ProblemDeployBackendStack` 内に **Events / Teams / Deployments の 3 Table を並列に持つ**。

```
[DDB] Events
  PK: EVENT#<eventId>
  SK: META
  attrs: { eventId, tenantId, name, status, problems[], createdAt, updatedAt, expiresAt }
  GSI1: TENANT#<tenantId> / createdAt        ← tenant の event 一覧 (新しい順)

[DDB] Teams
  PK: EVENT#<eventId>
  SK: TEAM#<teamId>
  attrs: { eventId, teamId, tenantId, displayName?, internalSlug, teamLoginKey, createdAt, expiresAt }
  GSI1: TENANT#<tenantId> / EVENT#<eventId>  ← tenant 全 event の team 横断
  GSI2: TEAMKEY#<teamLoginKey> / META        ← Participant Portal が key で引く

[DDB] Deployments  (既存テーブルを Event-aware に再設計)
  PK: EVENT#<eventId>
  SK: TEAM#<teamId>#PROBLEM#<problemId>
  attrs: { eventId, teamId, problemId, tenantId, awsAccountId, region,
           namePrefix, status, stackId, stackOutputs, failureReason,
           score, lastResult, endpointsHealth, flagSubmitted,
           createdAt, updatedAt, expiresAt }
  GSI1: TENANT#<tenantId> / createdAt        ← 既存の tenant 横断一覧 (互換維持)
  GSI2: TEAMKEY#<teamLoginKey> / PROBLEM#<problemId>  ← Portal が team の問題リスト取得
```

設計ポイントは次のとおり。

- **`teamLoginKey` は Teams に 1 つ**。Deployments には保存しない (重複の禁止)
- Deployments の GSI2 PK は **Team.teamLoginKey をコピー** (= denormalize)。Portal が `Bearer <teamLoginKey>` で来たら Teams をまず引かずに直接 Deployments を Query できる
- 旧 `(jobId, displayTeamName)` フィールドは削除。jobId 相当は `EVENT#<eventId>#TEAM#<teamId>#PROBLEM#<problemId>` の合成 ID で表現する

### 2. CRUD operations は EventTemplate API + Bulk Apply で揃える

Operations は次のとおり。

| 操作 | endpoint | 認可 | 副作用 |
|---|---|---|---|
| Event Create | `POST /events` | TenantAdmin | Events 1 行 + Teams N 行 + (空の) Deployments table state |
| Event Detail | `GET /events/{eventId}` | TenantAdmin | Event + Teams + Deployments の matrix |
| Event List | `GET /events` | TenantAdmin | tenant の event 一覧 |
| Bulk Deploy | `POST /events/{eventId}/deploy` | TenantAdmin | 選択された (team × problem × account/region) 組み合わせを **N × M 並列** で State Machine 起動 |
| Bulk Delete | `POST /events/{eventId}/teardown` | TenantAdmin | event 配下の COMPLETE / FAILED な Deployments を全 DELETE |
| Single Re-deploy | `POST /events/{eventId}/deployments/{teamId}/{problemId}/redeploy` | TenantAdmin | 失敗した 1 cell の retry |
| Single Delete | `DELETE /events/{eventId}/deployments/{teamId}/{problemId}` | TenantAdmin | 1 cell の手動 teardown |
| Event Delete | `DELETE /events/{eventId}` | TenantAdmin | Bulk Delete を発火 + 完了後に Event/Team 行を削除 |

Bulk operations は **Step Functions Distributed Map** で並列化する (= ADR-001 §1 の経路を本格運用)。

```
POST /events/{id}/deploy
  └ Lambda: Event/Teams を読んで (team × problem) を入力配列に組み立て
     └ EventBridge "BulkDeployRequested" publish
        └ State Machine (Distributed Map): 並列に既存 DeployCreate 経路を呼ぶ
           └ CodeBuild × N×M → CFn CreateStack
```

### 3. Event Create 時に Teams を一括発番 (= teamLoginKey を一度に N 個発行)

UI フローは次のとおり。

1. operator が「Event 作成」画面で次の情報を入力する。
   - Event 名 (例: "JAWS-UG 春の陣 2026")
   - **チーム数** (例: 25)
   - **問題セット** (チェックボックスで N 問選択)
   - 各問題ごとに **default account / region**
2. `POST /events` で次の処理が走る。
   - Events 1 行 + Teams 25 行 (teamLoginKey を 25 個生成) を **TransactWrite** で原子的に書く
   - 各 problem の deploy target (account/region) は Event.problems[]内に保存
3. UI が teamLoginKey × 25 を **1 度だけ** 表示 (`Event 作成完了` モーダル)。CSV ダウンロード可
4. operator が「Bulk Deploy」を押すと、25 × N の Deployments 行が PENDING で作成され、Distributed Map が並列起動

### 4. Participant Portal は team scope に切り替える

`GET /portal/me` のレスポンスを **「自チームに紐づく全問題のリスト」** に変える。

```jsonc
{
  "team": {
    "teamId": "...",
    "displayTeamName": "Team Alpha",
    "eventId": "...",
    "eventName": "JAWS-UG 春の陣 2026"
  },
  "problems": [
    {
      "problemId": "hello-world-battle",
      "status": "COMPLETE",
      "score": 240,
      "endpointsHealth": {...},
      "flagSubmitted": false
    },
    // ... event の他問題
  ]
}
```

Lambda は `Bearer <teamLoginKey>` から Teams GSI2 で 1 行引き、`teamId` で Deployments を Query する (GSI2 で `TEAMKEY#<key>` でも可、片方を選ぶ)。

### 5. 旧 deployment 経路は段階的に廃止

破壊的変更を一気に入れない。**Phase 化** で進める。

- **Phase 1 (✅完了)**: Events / Teams Table を追加 + `POST /events` / `GET /events` / `GET /events/{id}` を新設。既存 `POST /problems/{id}/deploy` 経路は残す
- **Phase 2a (✅完了)**: `POST /events/{id}/deploy` + `DELETE /events/{id}` を導入 (= bulk deploy / bulk teardown)。Distributed Map ではなく **EventBridge fan-out** で初期実装 (Lambda が teams × problems を展開して既存 `DeployCreateRequested` / `DeployDeleteRequested` を chunk publish、既存 DeployCreate / DeployDelete State Machine が個別に並列実行)。Phase 3+ で 1000 並列を超える scale が要求されたら Distributed Map に切り替える
- **Phase 2b (✅完了)**: application-admin-console UI に EventCreate / EventList / EventDetail を追加
- **Phase 2c (✅完了)**: Participant Portal を team scope に切り替え (`GET /portal/me` を `team + problems[]` に拡張)。`POST /portal/me/submit-flag` は `problemId` 必須に
- **Phase 3**: 既存 `POST /problems/{id}/deploy` を deprecate (UI からの呼び出し削除)
- **Phase 4**: 既存 routes と DDB の jobId-based 行を削除

各 Phase は 1〜2 PR に閉じる。Phase 間で動く SaaS が壊れないことを `ONE_PASS_LOCAL` / `ONE_PASS_AWS` invariant で保証する。

### 6. 既存 Deployments 行の扱い

旧 (jobId-based) 行は **migration せず捨てる**。理由は次のとおり。

- training / dev 用途のデータしか入っていない (本番運用前)
- migration script を書くコストが、新規 deploy し直すコストより高い
- Phase 4 で `make destroy` → 再 deploy で完全クリーンな状態にする

ユーザに「Phase 4 で旧データは消えます。本番投入は新モデルで」と明示する。

## Consequences

### Positive

- ✅ Operator が **Event 単位 1 ボタン** で 750 stacks を扱える (FR-1 達成)
- ✅ 競技者が **1 つの teamLoginKey** で event の全問題にアクセス可 (UX 単純化)
- ✅ Participant Portal で「自チームの全問題リスト + スコア合計」が出せる (Battle/Challenge UX 統一)
- ✅ 削除も Event 単位 / Team 単位 / 1 cell 単位の 3 階層で操作可
- ✅ ADR-001 が想定していた **Distributed Map** の本格運用に到達

### Negative

- ❌ 既存 Deployments の jobId 構造が破壊される。training データは捨てる
- ❌ DDB Table が 1 → 3 に増える (各 1 RCU/WCU PROVISIONED で約 +$0.5/月、Free Tier 25 内に収まる)
- ❌ Lambda + UI の同時改修が大きい (4 Phase に分けて mitigation)
- ❌ Step Functions Distributed Map の AWS quota (default 1000 並列) に注意。FR-1 750 stacks は OK だが、複数 event を同時に走らせると衝突する → operator UI で「同時 1 event のみ」制約を入れる

### Risks (= 失敗したら戻る経路)

- TransactWrite 上限 (100 items) の制約 — 1 event = 100 teams を超えるイベントには対応しない (要件は 25 teams なので余裕)
- Distributed Map の Step Functions cost — 750 stacks × $0.025 / 1000 transitions × 数 transitions = 数セント / event。許容
- Phase 3 の deprecation 後に既存 UI 経路を呼ぶ古い browser タブ → 410 Gone を返して reload 促す

## Open questions (本 ADR では決めず deferred)

1. **Event のスケジュール (start / end)** — 自動 teardown の起点を Event.endAt にするか、現行の TTL 8 時間を維持するか
2. **Team の動的追加 / 削除** — Event 開始後に team 追加 (= teamLoginKey 追加) は許すか
3. **採点 leaderboard** — Event scope で `Top N teams` を返す `GET /events/{id}/leaderboard` を Phase 5 で追加
4. **Cross-account の AssumeRole** — ADR-002 と組み合わせて Phase 5 で

## Phase 1 のスコープ (即着手分)

本 PR で行う作業は次のとおり。

1. ADR-004 起草 (本ファイル)
2. (CDK) `Events` / `Teams` Table を `ProblemDeployBackendStack` に追加
3. (Lambda) `POST /events` / `GET /events` / `GET /events/{id}` の handler 追加
4. (Tenant API) routes を api-gateway.ts に追加
5. テスト追加 (TransactWrite 原子性、TenantId mismatch 404、teamLoginKey 一意性)
6. `tenant.openapi.yaml` 更新

UI 追加 (EventCreate / EventList / EventDetail) は Phase 2 に回す。
