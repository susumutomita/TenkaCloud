# ADR-003: 問題カタログを filesystem 自動 discovery から DDB-backed catalog API に移行する

- **Status**: Proposed (2026-05-05)
- **Related ADR**: [ADR-001](./adr-001-problem-deploy-crud.md) (FR-5「問題カタログ」を本 ADR で具体化)
- **Related PR**: PR 465 (filesystem 自動 discovery を導入、本 ADR の前段)
- **Related issues**:「SaaS UI から問題を upload する経路」(本 ADR の deferred 項目で開く新 issue)

## Context

PR 465 で「frontend / backend / filesystem の 3 重管理」問題を解消するため、`problems/<category>/<id>/metadata.json` を **filesystem 正本** にし、frontend (Vite `import.meta.glob`) と backend CDK (`fs.readdirSync`) が build 時 / synth 時に自動取り込みする方式を採用した。

これは MVP-1 の暫定解で、次の 3 つの制約があり SaaS としては不完全。

1. **問題追加に repo merge が必要**: 競技作者が UI から自分の問題を upload できない (= operator が GitHub PR を出して merge → CDK redeploy するまで反映されない)
2. **可視範囲 (`public` / `org-shared` / `private`) が表現できない**: filesystem に置かれた problem は全 tenant で見える (実際は frontend で `import.meta.glob` するため build 時に全部 bundle される)
3. **多 tenant 用に「うちの tenant だけが使える private 問題」を持てない**: 1 zip / 1 source.zip しか走らないので tenant 別に問題セットを分けられない

要件文書 [`docs/requirements/problem-deploy.md`](../requirements/problem-deploy.md) の `FR-5: 問題カタログ` は次の 3 項目をひとつのまとまりで要求していた。

- S3 に CFn template
- DDB に metadata
- 可視範囲フィールド (`public` / `org-shared` / `private`)

PR 465 はこの 3 項目のうち「DDB metadata」と「可視範囲」を実装していない。本 ADR で完成形を確定する。

## Decision

### 1. データレイアウトは S3 (template) + DDB (metadata) + 可視範囲 (DDB attribute)

```
[S3 bucket] tenkacloud-problem-templates-{account}-{region}/
  ├ tpl/{problemId}/{version}/template.yaml      ← 不変 (version で履歴)
  └ tpl/{problemId}/{version}/checksum.sha256

[DDB table] Problems
  PK: PROBLEM#{problemId}
  SK: VERSION#{version}                          ← latest = MAX(version)
  attributes: {
    problemId, version,
    name, category, status, difficulty,
    estimatedDuration, shortDescription, description,
    tags, exposedPorts, learningGoals,
    cfnTemplateS3Uri, cfnTemplateChecksum,
    cfnParameters,                               ← 既存 schema の cfnParameters と互換
    visibility: "public" | "org-shared" | "private",
    ownerTenantId,                               ← visibility ≠ public のとき必須
    sharedWithTenantIds: string[],               ← visibility = org-shared のとき
    createdAt, updatedAt
  }

[DDB GSI] OwnerTenantIndex
  GSI1PK: TENANT#{ownerTenantId}
  GSI1SK: VERSION#{problemId}#{version}
  → owner tenant の private 問題を一覧する
```

### 2. visibility による fan-out 規則

問題リスト取得 API (`GET /problems`) は呼び出し元 tenant の JWT (`custom:tenantId`) を見て、次の union を返す。

- `visibility = "public"` の全件
- `visibility = "org-shared"` かつ `sharedWithTenantIds` に caller tenant が含まれる件
- `visibility = "private"` かつ `ownerTenantId = caller tenant` の件

3 query の結果を merge して dedupe (同 problemId が public / shared 両方に出るのは仕様上ない、念のため)。

### 3. CRUD API は tenant API + Cognito JWT 認可で統一する (= ADR-001 と同型)

Operations:

| 操作 | endpoint | 認可 |
|---|---|---|
| Create | `POST /problems` | 自 tenant TenantAdmin role |
| Read (1 件) | `GET /problems/{problemId}` | visibility filter (上記 §2) |
| Read (一覧) | `GET /problems` | visibility filter |
| Update (新 version) | `POST /problems/{problemId}/versions` | owner tenant のみ |
| Delete (deprecate) | `PATCH /problems/{problemId}` `{ status: "deprecated" }` | owner tenant のみ |
| Hard delete | (なし) | DDB 行は不変、status だけ deprecated に倒す |

Update は **新 version を作る** だけで、既存 version は保つ。deploy 中の job への影響を避ける (= deploy job は jobId に紐づく version を使い続ける)。

### 4. CFn template upload フロー

```text
[1] operator/作者が「Add problem」画面で metadata + template.yaml を選ぶ
[2] frontend → POST /problems
       backend が S3 に template Put (server-side hash 計算)、
       DDB Problems に row insert (version="v1")
[3] 画面に Created の確認、deploy 可能になる
```

template.yaml の syntax 検証 (cfn-lint) は backend Lambda で **行う**。MVP-1 の `make validate-problems` は Phase 2 で本 endpoint に置き換える (filesystem 経路は撤去するため)。

### 5. filesystem 経路の撤去戦略

PR 465 で導入した `import.meta.glob` (frontend) と `discoverProblemsCatalog` (backend) は **本 ADR 実装後に削除する**。

具体的な変更箇所は次のとおり。

- `apps/application-admin-console/src/data/problems.ts` を「DDB API client から fetch する hook」に書き換え (`PROBLEM_CATALOG` const → `useProblemCatalog()` hook)
- `infrastructure/bin/infrastructure.ts` の `discoverProblemsCatalog()` 呼び出しを撤去 (= DeployApiLambda の env `BATTLE_PROBLEMS_CATALOG` も廃止、Lambda が DDB を都度 query する形に)
- `problems/` ディレクトリ自体は **削除しない**: seed data として残し、初回 deploy 時に `make seed-problems` で DDB に流し込む one-shot script を用意する

## Migration

### Phase 2.1 (本 ADR を実装する PR-A)

1. `ProblemCatalogTable` (新 DDB) construct を追加
2. `ProblemTemplateBucket` (新 S3) construct を追加 (versioned bucket)
3. tenant API に CRUD endpoint 5 個を追加
4. cfn-lint Lambda layer (or container function) を追加
5. visibility filter 付き query helper

### Phase 2.2 (frontend / backend の filesystem 経路撤去 PR-B)

1. `apps/application-admin-console` で `useProblemCatalog()` hook + Cloudscape `<Cards>` で表示
2. `bin/infrastructure.ts` から `discoverProblemsCatalog()` 削除、`DeployApiLambda` の `BATTLE_PROBLEMS_CATALOG` env 削除
3. `DeployApiLambda` の `startDeployment` を `ProblemCatalogTable` query に書き換え (`UnknownProblemError` の発火経路は不変)
4. `make seed-problems` script を追加 (`problems/<category>/<id>/{metadata.json,template.yaml}` を読んで DDB + S3 に流し込む one-shot)
5. CI gate `make validate-problems` を `make seed-problems --dry-run` に置き換え
6. `apps/application-admin-console/src/data/problems.ts` を削除

### Phase 3 (作者 UI)

1. application-admin-console に「Problem Authoring」画面を追加 (template.yaml editor + metadata form + cfn-lint preview)
2. `POST /problems` の auth role を「TenantAdmin」から「ProblemAuthor」に絞る (custom Cognito group 追加)

## Consequences

### Positive

- 問題追加に repo merge が不要になる (SaaS の本来の姿)
- visibility (`public` / `org-shared` / `private`) が表現できる、tenant 別の問題セットが持てる
- version 履歴で「deploy 中の job が古い template を使い続ける」運用が安全
- 3 重管理が完全消滅 (filesystem 経路撤去)

### Negative

- DDB read/write が deploy 経路に追加される (Lambda cold start で +50ms 程度)
- S3 / DDB の Free Tier 枠を 1 RCU/WCU でやりくりするため、scan が増えると throttle 可能性 (`ProblemCatalogTable` は GSI で query 化、scan は禁止)
- 既存 PR 465 の filesystem 経路を **同じ PR で削除する** ことで legacy fallback を残さない (CLAUDE.md「fallback 禁止」原則)。代わりに `make seed-problems` で初回 migration を扱う

### Risk

- visibility filter 実装の不備で別 tenant の private 問題が漏れるバグは critical。実装時に **権限境界の unit test を必ず書く** (PK 漏洩 / GSI 漏洩 / cross-tenant 同 problemId の混線を網羅)

## 関連 invariant

- `INVARIANT_TENANT_ISOLATION_AT_INFRA_LAYER` — visibility filter は backend 層、frontend で見えなくしない
- `INVARIANT_PR_TESTS_COUPLED_WITH_CHANGE` — visibility 周りは権限 unit test を必須
- `DynamoDbLowCapacity` Aspect — `ProblemCatalogTable` も 1/1 PROVISIONED

## 関連リソース

- [`problems/SCHEMA.json`](../../problems/SCHEMA.json) — 既存 metadata.json schema、本 ADR で DDB attribute と互換に保つ
- [`apps/application-admin-console/src/data/problems.ts`](../../apps/application-admin-console/src/data/problems.ts) — Phase 2.2 で削除
- [`infrastructure/bin/infrastructure.ts`](../../infrastructure/bin/infrastructure.ts) — Phase 2.2 で `discoverProblemsCatalog` 撤去
- [ADR-001](./adr-001-problem-deploy-crud.md) — FR-5 を本 ADR で具体化
- PR 465 — 本 ADR の前段 (filesystem 自動 discovery 導入)
