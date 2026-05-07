# TenkaCloud API リファレンス

TenkaCloud の HTTP API 仕様。3 つの API サーフェスを **plane (= オーディエンス) ごとに
分離した OpenAPI 3.1 spec** で持つ。本書はその俯瞰 narrative。

| サーフェス | 仕様ファイル | 配信先 SPA / Stack |
| --- | --- | --- |
| Control Plane API | [`control-plane.openapi.yaml`](./control-plane.openapi.yaml) | `apps/admin-console` / `ControlPlaneStack` |
| Tenant API | [`tenant.openapi.yaml`](./tenant.openapi.yaml) | `apps/application-admin-console` / `TenantTemplateStack` |
| Participant API | [`participant.openapi.yaml`](./participant.openapi.yaml) | `apps/participant-portal` / `ProblemDeployBackendStack` |
| 共通スキーマ | [`_components.yaml`](./_components.yaml) | (paths を持たない、`$ref` 専用) |

3 ファイルに分割した理由は **Plane 分離 (Control Plane vs Application Plane) が SBT
由来の architectural invariant** だから。1 サーフェス multi-tenant SaaS (Slack, Stripe)
は 1 ファイルが多数派だが、TenkaCloud のような multi-plane / multi-audience SaaS は
Auth0 (Management API + Authentication API) や Atlassian (Admin API + Product API) など
分割が定石。

## サーフェス概要

| サーフェス | 用途 | 認証 | 提供元 |
| --- | --- | --- | --- |
| **Control Plane API** | テナント (= 主催者組織) の CRUD | Cognito JWT (System Admin) | SBT `ControlPlane` (`@cdklabs/sbt-aws` 0.3.9) |
| **Tenant API** | 問題の deploy / 一覧 / 詳細 / 削除 | Cognito JWT (Tenant Admin) | `TenantTemplateStack` 内 `ApiGateway` |
| **Participant API** | 競技者がチームの問題状態を取得 / flag を提出 | `teamLoginKey` を bearer | `ProblemDeployBackendStack` の Lambda Function URL |

3 つの URL は **`runtime-config.json` 経由で SPA に注入** される (CloudFront 配下)。
URL を build 成果物に焼かない (= dist は tenant 共有可) — `docs/architecture/harness.md`
の `INVARIANT_APP_CODE_IS_UNMODIFIED` に従う。

## 認証

### Cognito JWT (Control Plane / Tenant API)

```
Authorization: Bearer <cognito_id_token>
```

- Hosted UI + OAuth Code + PKCE で取得
- ID Token (`access_token` ではない) を渡す。`custom:tenantId` claim から tenantId を解決する
- 期限切れは 401 (refresh は SPA 側で `aws-amplify` が自動実行)

### teamLoginKey (Participant API)

```
Authorization: Bearer <teamLoginKey>
```

- Tenant Admin が `POST /problems/:id/deploy` を呼んだときに **1 度だけ** レスポンスに含まれる
- 競技者に hand-off (口頭 / 安全な手段で) する短命キー
- DDB の TTL (`expiresAt`) で自動失効
- key 自体を bearer にしているため、leak すると **そのチームの状態が外部から閲覧されるだけでなく、
  `POST /portal/me/submit-flag` で不正に flag を提出され勝手に加点される** リスクがある

## API ごとの実行権限 (最小権限の早見表)

クライアント側の認証 (誰が呼べるか) と、実体 Lambda が AWS 上で持つ IAM の両方を、
3 サーフェスごとに分離しています。

| サーフェス | クライアント認証 | 公開 URL | 実体 Lambda | Lambda の IAM (= 触れる AWS リソース) |
| --- | --- | --- | --- | --- |
| Control Plane API | Cognito JWT (`SystemAdmin` group) | API GW + Cognito Authorizer | SBT 内蔵 (TenantDetails CRUD) | DDB `TenantDetails` のみ + EventBridge `onboardingRequest` publish |
| Tenant API | Cognito JWT (`TenantAdmin` custom claim) | per-tenant API GW + Cognito Authorizer | `DeployApi` Lambda | DDB `Deployments` (RW) + EventBridge bus (PutEvents) のみ。**CFn 権限は持たない** |
| Participant API | `teamLoginKey` を bearer (Lambda 内検証) | Lambda Function URL (`AuthType=NONE`) | `ParticipantPortal` Lambda | DDB `Deployments` Query (GSI2 経由) + UpdateItem のみ。**CFn / EventBridge / 他テーブル権限なし** |
| Health Check (内部) | EventBridge `rate(1 minute)` で起動 | (公開なし) | `HealthCheck` Lambda | DDB `Deployments` (RW) + 競技者エンドポイントへの outbound HTTP のみ |
| Deploy 実体 (内部) | Step Functions Task | (公開なし) | `DeployCodeBuildProject` (CodeBuild) | CFn (Create/Update/Delete/Describe) + EC2/IAM/SSM/Logs/S3/Events/Lambda の `*` (= 問題テンプレが必要なリソースを作成するため) |

### 設計原則

1. **API Lambda 自身は CFn を直接触らない**
   - `DeployApi` は EventBridge publish するだけ。実 deploy / delete は CodeBuild Project が
     行う。これにより API Lambda の権限を「DDB + EventBridge」に閉じ込めて、もし API Lambda
     が乗っ取られても CFn を勝手に発火できないようにしている。
2. **Participant Lambda は read 寄り + 自分の行の Update だけ**
   - `dynamodb:UpdateItem` は table 全体に向けて grant されているが、Lambda コード側で
     teamLoginKey の所有者の行 (GSI2 で引いた 1 行) しか触らない実装になっている。
3. **削除権限は CodeBuild Project に集約**
   - `cloudformation:DeleteStack` を持つのは CodeBuild Project Role のみ。
     DeployApi Lambda には付与しない (= 削除のトリガーは EventBridge 経由のみ)。
4. **Participant Portal の Function URL は AuthType=NONE**
   - Cognito を per-team 払い出すと運営コストが大きいため、`teamLoginKey` をそのまま
     bearer として Lambda 内で検証する。Function URL の AuthType は NONE。
5. **クロステナント漏洩防止**
   - `tenantId` mismatch は 404 (存在を漏らさない)。read 経路すべてで `where tenantId = caller`
     を強制する。

## エラー方針

```jsonc
// 4xx
{ "error": "<machine_readable_code>" }

// validation error (Zod)
{ "error": "validation failed", "issues": [...] }

// 5xx
{ "error": "internal_error" }
```

### クロステナント漏洩防止

read 経路で `tenantId` mismatch を見つけた場合は **`404 not_found` を返す**
(403 / "wrong tenant" を返さない)。存在を漏らさないため。

## デプロイ / 削除のライフサイクル

Tenant API の `/problems/:id/deploy` と `/deployments/:jobId` (DELETE) は、
**SBT の `ScriptJob` 同型** な構造で動きます。

```
[Tenant API Lambda]
   │ ① validation + DDB Put + EventBridge PutEvents
   ▼
[EventBridge bus] ── DeployCreateRequested / DeployDeleteRequested
   │
   ▼
[Step Functions State Machine]
   │ ② CodeBuildStartBuild .sync (RUN_JOB integration)
   ▼
[CodeBuild Project]
   │ ③ scripts/deploy-battles.sh (create) または scripts/delete-battles.sh (delete)
   ▼
[CloudFormation]
   │ ④ CreateStack / DeleteStack
   ▼
[State Machine 完了] → DDB row の status を COMPLETE / DELETED / FAILED に書き戻す
```

### Status 遷移

```
PENDING ─→ IN_PROGRESS ─→ COMPLETE ─→ DELETING ─→ DELETED
                       └→ FAILED   ─→ DELETING ─→ DELETED
```

- `PENDING / IN_PROGRESS / COMPLETE / FAILED` から DELETE → `DELETING`
- `DELETING / DELETED` への DELETE は `200 already_deleted` (no-op)
- DELETING 中に CFn が失敗したら `FAILED` + `failureReason` (operator が再試行)

## Scoring

問題 metadata の `scoring.kind` で 2 系統に分かれる。

- `flag` (Challenge): 競技者が `POST /portal/me/submit-flag` で flag を提出 → Lambda が
  CFn Outputs と照合して採点する。
- `uptime` (Battle): `HealthCheck` Lambda が 1 分間隔で endpoint を probe し、
  防御側が止まっていたら点数を伸ばさない (攻撃側のスコア優位)。

詳細は [`docs/requirements/`](../requirements/) を参照。

## 仕様の更新フロー

1. Hono handler の zod スキーマを変える
2. 該当サーフェスの `*.openapi.yaml` を手で同期する。共通スキーマは
   `_components.yaml` 側を直す。現状は手書きで、Phase 2 で `@hono/zod-openapi`
   自動生成へ移行する
3. `make before-commit` で lint + typecheck + test を通す

将来: zod スキーマ → OpenAPI 自動生成 (`@hono/zod-openapi`) で 2 重管理を解消する。

## レンダリング

ローカルプレビューは任意のレンダラで行う。3 サーフェスを別々に build する
(plane 分離思想と整合)。

```bash
# Redoc CLI で各 plane の HTML を吐く
nlx @redocly/cli build-docs docs/api/control-plane.openapi.yaml -o docs/api/control-plane.html
nlx @redocly/cli build-docs docs/api/tenant.openapi.yaml        -o docs/api/tenant.html
nlx @redocly/cli build-docs docs/api/participant.openapi.yaml   -o docs/api/participant.html

# Swagger UI を docker で起動 (例: tenant API)
docker run --rm -p 8080:8080 \
  -e SWAGGER_JSON=/spec/tenant.openapi.yaml \
  -v "$(pwd)/docs/api:/spec" \
  swaggerapi/swagger-ui
```

CI では `nlx @redocly/cli lint docs/api/*.openapi.yaml` を回して破綻を検知する想定。
