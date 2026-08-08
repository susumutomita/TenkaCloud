/**
 * Issue #2948 / ADR-0005 Phase 1: machine (M2M) token 経路の **単一の正** となる純データ。
 *
 * この module は handler bundle (esbuild) と CDK synth の **両方** から import される。
 * よって `aws-cdk-lib` を含む一切の CDK 依存を持ってはならない (= handler bundle が
 * CDK 本体を巻き込んで肥大化する / bundle が壊れる)。test `machine-scopes-purity` が
 * source-level でこれを pin する。
 *
 * ## scope 文字列
 *
 * ```text
 * tenkacloud/ops.read       capability: read    (CFn 管理の resource server)
 * tenkacloud/ops.deploy     capability: deploy  (CFn 管理の resource server)
 * tc-tenant-<tenantId>/bind tenant binding      (runtime 作成、CFn 管理外)
 * ```
 *
 * tenant binding を **scope 文字列そのもの** で表現するのが本設計の中核である。lookup table も
 * side table も per-request I/O も不要で、token の中身だけで tenant が決まる。bind resource
 * server を CFn 管理にしない理由は 2 つある。
 *
 * 1. CFn 管理にすると次回 `cdk deploy` が scope list を空へ reconcile し、発行済み token を
 *    全滅させる。
 * 2. 逆に言えば `delete-resource-server` が **deploy 不要の kill switch** になる。
 *
 * ## Phase 1 で凍結した route allowlist
 *
 * 7 route。destructive 操作 (`DELETE /deployments/{jobId}` / `disruptions/fire` /
 * `rotate-login-key` / `/admin/*` ほか) は allowlist に**無い**うえに、`TenantMachine` role
 * がどの `requireRole` allowlist にも含まれないため **構造的にも** 到達不能である。この
 * middleware は唯一の防壁ではなく 2 枚目の防壁である。
 */

/** CFn 管理の capability resource server identifier。 */
export const CAPABILITY_RESOURCE_SERVER_ID = "tenkacloud";

/** runtime 作成される per-tenant bind resource server の identifier prefix。 */
export const BIND_RESOURCE_SERVER_PREFIX = "tc-tenant-";

/** bind resource server が持つ唯一の scope 名。 */
export const BIND_SCOPE_NAME = "bind";

/** audit log の `actor` に付ける machine principal prefix (= `m2m:<clientId>`)。 */
export const MACHINE_ACTOR_PREFIX = "m2m:";

/** machine client を発行するときの Cognito app client name prefix。 */
export const MACHINE_CLIENT_NAME_PREFIX = "tc-m2m-";

/** access token TTL (分)。#2939 §5 の owner 判断で 15 分に確定。 */
export const MACHINE_ACCESS_TOKEN_VALIDITY_MINUTES = 15;

/**
 * Phase 1 の capability。`ops.write` / `disruptions.fire` / `audit.read` は名前を予約するが
 * Phase 1 では resource server に宣言しない (= Cognito がそもそも発行できない)。
 */
export const MACHINE_CAPABILITIES = ["read", "deploy"] as const;
export type MachineCapability = (typeof MACHINE_CAPABILITIES)[number];

/** capability → resource server 内の scope 名。 */
export const CAPABILITY_SCOPE_NAMES: Readonly<Record<MachineCapability, string>> = {
  read: "ops.read",
  deploy: "ops.deploy",
};

/** capability → 完全修飾 scope 文字列 (`tenkacloud/ops.read`)。 */
export function capabilityScope(capability: MachineCapability): string {
  return `${CAPABILITY_RESOURCE_SERVER_ID}/${CAPABILITY_SCOPE_NAMES[capability]}`;
}

/** tenantId → bind resource server identifier (`tc-tenant-<tenantId>`)。 */
export function bindResourceServerId(tenantId: string): string {
  return `${BIND_RESOURCE_SERVER_PREFIX}${tenantId}`;
}

/** tenantId → 完全修飾 bind scope 文字列 (`tc-tenant-<tenantId>/bind`)。 */
export function bindScope(tenantId: string): string {
  return `${bindResourceServerId(tenantId)}/${BIND_SCOPE_NAME}`;
}

export interface MachineRouteScope {
  /** HTTP method (大文字)。 */
  readonly method: "GET" | "POST";
  /** API Gateway の path 表記 (`/deployments/{jobId}`)。CDK 側が resource tree を組むのに使う。 */
  readonly apigwPath: string;
  /** Hono の path 表記 (`/deployments/:jobId`)。handler 側 matcher が使う。 */
  readonly honoPath: string;
  /** この route を呼ぶのに必要な capability。 */
  readonly capability: MachineCapability;
}

/**
 * Phase 1 の route allowlist (7 本、凍結)。CDK の method 生成と handler の guard が
 * **同じ配列** を読むため、片方だけ増える drift が構造的に起きない。
 */
export const MACHINE_ROUTE_SCOPES: readonly MachineRouteScope[] = [
  {
    method: "GET",
    apigwPath: "/deployments",
    honoPath: "/deployments",
    capability: "read",
  },
  {
    method: "GET",
    apigwPath: "/deployments/{jobId}",
    honoPath: "/deployments/:jobId",
    capability: "read",
  },
  {
    method: "GET",
    apigwPath: "/deployments/{jobId}/stack-progress",
    honoPath: "/deployments/:jobId/stack-progress",
    capability: "read",
  },
  {
    method: "GET",
    apigwPath: "/problems/{problemId}/deployments",
    honoPath: "/problems/:problemId/deployments",
    capability: "read",
  },
  {
    method: "GET",
    apigwPath: "/events",
    honoPath: "/events",
    capability: "read",
  },
  {
    method: "GET",
    apigwPath: "/events/{eventId}",
    honoPath: "/events/:eventId",
    capability: "read",
  },
  {
    method: "POST",
    apigwPath: "/problems/{problemId}/deploy",
    honoPath: "/problems/:problemId/deploy",
    capability: "deploy",
  },
] as const;

/**
 * `honoPath` と実 request path を segment 単位で厳密比較する。
 *
 * Hono の `use("*")` middleware 内では `c.req.routePath` が middleware 自身の登録 path を
 * 返すため、guard は自前 matcher を持つしかない。prefix match は禁止 (`/deployments/x/y` が
 * `/deployments/:jobId` に化けない)、末尾 `/` も非許容 (= 別 path として落とす)。
 */
export function matchesHonoPath(honoPath: string, requestPath: string): boolean {
  const expected = honoPath.split("/");
  const actual = requestPath.split("/");
  if (expected.length !== actual.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    const segment = expected[i] as string;
    const value = actual[i] as string;
    if (segment.startsWith(":")) {
      // param segment は 1 segment ちょうど、かつ非空でなければならない。
      if (value.length === 0) return false;
      continue;
    }
    if (segment !== value) return false;
  }
  return true;
}

/**
 * method + path が allowlist のどの route に当たるかを返す。当たらなければ undefined
 * (= caller は 403 に倒す)。
 */
export function findMachineRoute(
  method: string,
  requestPath: string,
): MachineRouteScope | undefined {
  const upper = method.toUpperCase();
  return MACHINE_ROUTE_SCOPES.find(
    (route) => route.method === upper && matchesHonoPath(route.honoPath, requestPath),
  );
}
