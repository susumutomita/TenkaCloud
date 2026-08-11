/**
 * Issue #2948: machine (M2M) token 経路の **単一の正** となる純データ。
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
 * tenkacloud/ops.write      capability: write   (CFn 管理の resource server、#2955)
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
 * ## route allowlist
 *
 * Phase 1 が 7 route、#2955 (Phase 2) が `POST /deployments/retry` を足して 8 route。destructive 操作 (`DELETE /deployments/{jobId}` / `disruptions/fire` /
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
 * capability。`disruptions.fire` / `audit.read` は名前を予約するが宣言しない (= Cognito が
 * そもそも発行できない)。
 *
 * `write` は #2955 (Phase 2) で追加した。deploy pipeline を **再投入** する操作専用で、
 * `deploy` とは別の scope にしてある。read 用 credential が誤って再投入できないことと、
 * 「新規に作る」と「失敗したものをやり直す」を別々に配れることが理由である。
 */
export const MACHINE_CAPABILITIES = ["read", "deploy", "write"] as const;
export type MachineCapability = (typeof MACHINE_CAPABILITIES)[number];

/** capability → resource server 内の scope 名。 */
export const CAPABILITY_SCOPE_NAMES: Readonly<Record<MachineCapability, string>> = {
  read: "ops.read",
  deploy: "ops.deploy",
  write: "ops.write",
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

/**
 * #2955 の証拠ゲート: route を machine に開くとき、その route が **どの非同期経路に届くか** を
 * データとして宣言させる。
 *
 * 設計 C が `PATCH /events/{id}/schedule` で踏んだ罠がこれである。同期的には「値を 1 つ書く
 * だけ」に見える route が、scheduler を経由して競技の進行そのものを動かしていた。宣言を必須の
 * field にしておけば、route を足す人は必ずこの問いに答えることになり、レビュアーは diff の
 * 1 行として見ることになる。
 *
 * - `none`             — 同期的な read / write だけで終わり、event も job も発生しない。
 * - `deploy-pipeline`  — `DeployCreateRequested` を publish し、deploy worker が動く。
 *                        machine に許してよい唯一の非同期経路 (Phase 1 の deploy と同型)。
 * - `scheduler`        — 競技進行 / 定期実行 / reconciler に届く。**machine には開かない。**
 */
export type MachineRouteReachability = "none" | "deploy-pipeline" | "scheduler";

/** machine に開いてよい reachability。`scheduler` はここに無い。 */
export const ALLOWED_MACHINE_REACHABILITY: readonly MachineRouteReachability[] = [
  "none",
  "deploy-pipeline",
];

export interface MachineRouteScope {
  /** HTTP method (大文字)。 */
  readonly method: "GET" | "POST";
  /** API Gateway の path 表記 (`/deployments/{jobId}`)。CDK 側が resource tree を組むのに使う。 */
  readonly apigwPath: string;
  /** Hono の path 表記 (`/deployments/:jobId`)。handler 側 matcher が使う。 */
  readonly honoPath: string;
  /** この route を呼ぶのに必要な capability。 */
  readonly capability: MachineCapability;
  /** この route が届く非同期経路。`scheduler` は test が拒否する。 */
  readonly reachability: MachineRouteReachability;
  /** 上記の判断根拠 (repo 内の file:line)。レビュー時に確認できる形で残す。 */
  readonly reachabilityEvidence: string;
}

/**
 * route allowlist。CDK の method 生成と handler の guard が **同じ配列** を読むため、片方だけ
 * 増える drift が構造的に起きない。route を足すときは `reachability` の宣言が必須である。
 */
export const MACHINE_ROUTE_SCOPES: readonly MachineRouteScope[] = [
  {
    method: "GET",
    apigwPath: "/deployments",
    honoPath: "/deployments",
    capability: "read",
    reachability: "none",
    reachabilityEvidence: "deploy-handler/list.ts — repository query only, publishes nothing",
  },
  {
    method: "GET",
    apigwPath: "/deployments/{jobId}",
    honoPath: "/deployments/:jobId",
    capability: "read",
    reachability: "none",
    reachabilityEvidence: "deploy-handler/list.ts — repository query only, publishes nothing",
  },
  {
    method: "GET",
    apigwPath: "/deployments/{jobId}/stack-progress",
    honoPath: "/deployments/:jobId/stack-progress",
    capability: "read",
    reachability: "none",
    reachabilityEvidence:
      "deploy-handler/stack-progress.ts — CloudFormation Describe* reads only, no mutation",
  },
  {
    method: "GET",
    apigwPath: "/problems/{problemId}/deployments",
    honoPath: "/problems/:problemId/deployments",
    capability: "read",
    reachability: "none",
    reachabilityEvidence: "deploy-handler/list.ts — repository query only, publishes nothing",
  },
  {
    method: "GET",
    apigwPath: "/events",
    honoPath: "/events",
    capability: "read",
    reachability: "none",
    reachabilityEvidence: "event-handler/list.ts — repository query only, publishes nothing",
  },
  {
    method: "GET",
    apigwPath: "/events/{eventId}",
    honoPath: "/events/:eventId",
    capability: "read",
    reachability: "none",
    reachabilityEvidence: "event-handler/list.ts — repository query only, publishes nothing",
  },
  {
    method: "POST",
    apigwPath: "/problems/{problemId}/deploy",
    honoPath: "/problems/:problemId/deploy",
    capability: "deploy",
    reachability: "deploy-pipeline",
    reachabilityEvidence:
      "deploy-handler/deploy.ts — publishes DeployCreateRequested; no scheduler or event-progression path",
  },
  {
    // #2955 Phase 2. Re-queues FAILED rows onto the same deploy pipeline the route above uses.
    method: "POST",
    apigwPath: "/deployments/retry",
    honoPath: "/deployments/retry",
    capability: "write",
    reachability: "deploy-pipeline",
    reachabilityEvidence:
      "deploy-handler/retry.ts — publishes EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED only; FAILED rows only, cross-tenant rows skipped",
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
