# ADR-013: SBT Control Plane Onboarding Wire Format

- **Status**: Accepted
- **Date**: 2026-04-23
- **Deciders**: susumutomita

## Context

ADR-011 で SBT (`@cdklabs/sbt-aws`) を Control Plane の正本に決めた。実装としては Admin UI から `lib/api/sbt-api-adapter.ts` 経由で SBT が払い出す API Gateway を叩く構成が組まれていたが、本物の SBT に対して実テナントを払い出してみると一切動かなかった。

並行して進めていた PoC リポジトリ `ProtoShip/apps/admin-console` で SBT v0.3.9 に対する onboarding を完成させ、以下が判明した。

- アダプタが期待していたエンドポイント `/tenant-registrations` は SBT v0.3.9 には存在しない。実際は `/tenants` 一系統である。
- POST 時の payload は `{ tenantData: {...}, tenantRegistrationData: {...} }` のネスト型ではなく、`{ tenantName, email, tier, tenantStatus }` のフラット型である。
- `tenantStatus` の取りうる値は `"In progress" | "Complete" | "Deleted"` で、`"created"` というステータスは存在しない。
- `tier` は `basic | standard | premium | platinum` の 4 値で（SBT 公式 reference と `infrastructure/cdk/bin/cdk.ts` の `apiKeySSMParameterNames` に一致）、UI 側の `FREE | PRO | ENTERPRISE` から双方向にマッピングする必要がある。
- list と get の両方で、サーバは `{ data: [...] }` で包んで返すケースと配列・単体オブジェクトを直接返すケースがあり、両対応が必要。

これらは ProtoShip 側の `apps/admin-console/test/tenants.test.ts` で SBT 互換性として固定した仕様であり、TenkaCloud に持ち込む。

## Decision

### 1. SBT エンドポイントは `/tenants` 一系統

| Operation | Method | Path |
| --- | --- | --- |
| 一覧 | `GET` | `/tenants` |
| 詳細 | `GET` | `/tenants/{id}` |
| 作成 | `POST` | `/tenants` |
| 更新 | `PUT` | `/tenants/{id}` |
| 削除 | `DELETE` | `/tenants/{id}` |

`/tenant-registrations` は使わない。

### 2. 作成 payload はフラット形

```json
{
  "tenantName": "品質管理部",
  "email": "admin@example.com",
  "tier": "basic",
  "tenantStatus": "In progress"
}
```

`tenantStatus` の初期値は常に `"In progress"` で送る。SBT 側の Lambda が DynamoDB に書き込み、EventBridge に onboarding event を流すまでを一気通貫で行う。

### 3. レスポンスは data ラップ・直返しの両対応

```ts
// 単体: { data: Tenant } | Tenant
// 一覧: { data: Tenant[] } | Tenant[]
```

アダプタは Zod の `union` で両方を受け、内部では unwrap してから UI 型に変換する。

### 4. tenantStatus と provisioningStatus のマッピング

| SBT `tenantStatus` | UI `provisioningStatus` |
| --- | --- |
| `"In progress"` | `IN_PROGRESS` |
| `"Complete"` | `COMPLETED` |
| `"Deleted"` | `FAILED` |
| その他 | `PENDING` |

### 5. tier 双方向マッピング

| UI `TenantTier` | SBT `tier` |
| --- | --- |
| `FREE` | `basic` |
| `PRO` | `standard` |
| `ENTERPRISE` | `premium` |

SBT の `platinum` は `ENTERPRISE` に丸める（UI に platinum 区別の概念がないため）。tier 名は `infrastructure/cdk/bin/cdk.ts` の `apiKeySSMParameterNames` と一致させること。

### 6. delete は soft delete

SBT v0.3.9 の `DELETE /tenants/{id}` は `isActive` を `false` にするだけで、CloudFormation スタックを実際に destroy しない。スタック destroy は別の deprovisioning フローで扱う（インフラ側の責務）。アダプタは 204/200 を成功、404 を `false` 返却、それ以外は `TenantApiError` で扱う。

### 7. 認証は NextAuth セッションの idToken

`createSbtTenantApi(baseUrl, getAccessToken)` の `getAccessToken` は NextAuth v5 セッションの `idToken` を返す。Cognito Hosted UI の PKCE フローはサーバ側 NextAuth provider が担う。アダプタは Bearer ヘッダにセットするだけで、PKCE を直接扱わない。

## Consequences

- **Good**: SBT 公式参照実装と整合し、SBT のバージョンアップに追随しやすい。ProtoShip で動作確認済の wire format を持ち込むので、空打ちのデバッグが不要。
- **Good**: ADR-011 で宣言した Control Plane 構成が実際に動くようになり、`ONE_PASS_AWS` の手順 1-2 (tenant 作成 → `provisioningStatus=COMPLETED` 確認) が通せる。
- **Bad**: SBT v0.3.9 の wire format は SBT 側の breaking change で動かなくなる可能性がある。SBT バージョンを上げる際はアダプタ層と本 ADR を同時に更新する必要がある。
- **Tradeoff**: list/single レスポンスの両対応 (`data` 包み・直返し) は冗長だが、SBT の後方互換に振った設計のため許容する。

## References

- [ADR-011: SBT Control Plane と二層 Application Plane 構成](./011-sbt-control-plane-and-two-layer-application-plane.md)
- [client/AdminWeb/lib/api/sbt-api-adapter.ts](../../client/AdminWeb/lib/api/sbt-api-adapter.ts)
- [SBT v0.3.9 README](https://github.com/awslabs/sbt-aws/tree/v0.3.9)
