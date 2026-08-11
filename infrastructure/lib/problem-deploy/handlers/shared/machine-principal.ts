import type { Context, MiddlewareHandler } from "hono";
import { extractClaims, type JwtClaims } from "./jwt-claims.js";
import {
  BIND_RESOURCE_SERVER_PREFIX,
  BIND_SCOPE_NAME,
  CAPABILITY_RESOURCE_SERVER_ID,
  CAPABILITY_SCOPE_NAMES,
  findMachineRoute,
  MACHINE_ACTOR_PREFIX,
  MACHINE_CAPABILITIES,
  type MachineCapability,
} from "./machine-scopes.js";

/**
 * Issue #2948: machine (M2M) principal の解決と route guard。
 *
 * ## 発火条件が「machine marker の存在」ではない
 *
 * 素朴な実装は 「machine marker が **在る** とき」 に発火する presence-gate になり、marker が
 * 欠落した token は素通りする (= fail-open)。本 guard は逆で、**human と確認できないこと** を
 * 起点にする。認可済み request のうち human でないものは、machine principal として正しく
 * 解決できない限り allowlist 外で deny される。
 *
 * human の判定は `custom:tenantId` claim の有無で行う。この claim は UserPool の
 * `writeAttributes` に含まれない (`tenant-template/identity-provider.ts`) ため利用者が自分で
 * 立てられず、偽装不能である。
 *
 * ## authorizer が無い経路
 *
 * `c.env.event.requestContext.authorizer` が丸ごと無い request (= unit test の
 * `app.request()`、Function URL の ops 経路、local) は claims が `undefined` になる。ここは
 * 従来どおり素通しし、下流の `resolveTenantId` / `requireRole` の env fallback に委ねる。
 * production では API Gateway の Cognito authorizer を通らない request が Lambda に届かない
 * ため、この分岐は production では到達しない (= 到達しても `DEFAULT_TENANT_ID` 未設定で
 * `MissingTenantClaimError` → 401 の fail-closed)。
 *
 * ## guard は 2 枚目の防壁である
 *
 * machine principal の role は `TenantMachine` であり、既存のどの `requireRole` allowlist にも
 * 含まれない。destructive route は本 middleware を丸ごと削除しても到達不能である。本 guard は
 * 「より早く・監査付きで落とす」ための 2 枚目であり、唯一の防壁ではない。
 */

export interface MachinePrincipal {
  /** bind scope (`tc-tenant-<tenantId>/bind`) から復元した tenant。 */
  readonly tenantId: string;
  /** Cognito access token の `client_id` claim。audit の actor になる。 */
  readonly clientId: string;
  /** token が持つ capability 集合 (`tenkacloud/ops.*`)。 */
  readonly capabilities: ReadonlySet<MachineCapability>;
}

declare module "hono" {
  interface ContextVariableMap {
    /**
     * #2948: `createMachineGuardMiddleware` だけが書き込む machine principal。
     * `resolveTenantId` / `resolveUserRole` は claims を直接 parse せず **この値だけ** を読む。
     */
    machinePrincipal?: MachinePrincipal;
  }
}

/** guard が machine request を拒否した理由。audit / log にそのまま載る。 */
export type MachineDenialReason =
  | "not_a_machine_principal"
  | "route_not_allowlisted"
  | "capability_missing"
  | "team_login_keys_forbidden";

export class MachineRouteDeniedError extends Error {
  constructor(
    public readonly reason: MachineDenialReason,
    public readonly method: string,
    public readonly path: string,
    public readonly principal?: MachinePrincipal,
  ) {
    super(`machine principal is not allowed to call ${method} ${path} (${reason})`);
    this.name = "MachineRouteDeniedError";
  }
}

/**
 * `tc-tenant-<tenantId>/bind` から tenantId を切り出す。tenantId に `/` は許さない
 * (= scope 文字列の区切りと衝突させない)。prefix / scope 名は英小文字と `-` のみで、
 * 正規表現内でも literal として振る舞うため escape は不要。
 */
const BIND_SCOPE_RE = new RegExp(`^${BIND_RESOURCE_SERVER_PREFIX}([^/]+)/${BIND_SCOPE_NAME}$`);

const CAPABILITY_SCOPE_PREFIX = `${CAPABILITY_RESOURCE_SERVER_ID}/`;

const SCOPE_TO_CAPABILITY: ReadonlyMap<string, MachineCapability> = new Map(
  MACHINE_CAPABILITIES.map((capability) => [
    `${CAPABILITY_SCOPE_PREFIX}${CAPABILITY_SCOPE_NAMES[capability]}`,
    capability,
  ]),
);

function readStringClaim(claims: JwtClaims, name: string): string | undefined {
  const raw = claims[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * human 判定。`custom:tenantId` を持つ token は human の ID token であり、machine 経路は
 * 一切触らない (= human 経路は byte-identical)。
 */
export function isHumanClaims(claims: JwtClaims | undefined): boolean {
  return claims !== undefined && readStringClaim(claims, "custom:tenantId") !== undefined;
}

/**
 * claims から machine principal を復元する。fail-closed: 少しでも曖昧なら `undefined`。
 *
 * `undefined` を返す条件 (全て意図的):
 *  - claims が無い / human の ID token である
 *  - `token_use` が `"access"` でない (= ID token を machine として解釈しない)
 *  - `scope` claim が無い / 空
 *  - bind scope が 0 件 (tenant 不明) または 2 件以上 (ambiguous — どちらの tenant か決められない)
 *  - 認識できる capability scope が 0 件 (= bind scope だけの token を全 route で拒否する。
 *    これが無いと bind-only token が blanket read に届く)
 *  - `client_id` claim が無い
 */
export function parseMachinePrincipal(claims: JwtClaims | undefined): MachinePrincipal | undefined {
  if (!claims) return undefined;
  if (isHumanClaims(claims)) return undefined;
  if (readStringClaim(claims, "token_use") !== "access") return undefined;

  const scope = readStringClaim(claims, "scope");
  if (!scope) return undefined;
  const entries = scope.split(/\s+/).filter((value) => value.length > 0);

  const tenantIds: string[] = [];
  const capabilities = new Set<MachineCapability>();
  for (const entry of entries) {
    const bind = BIND_SCOPE_RE.exec(entry);
    if (bind?.[1]) {
      tenantIds.push(bind[1]);
      continue;
    }
    const capability = SCOPE_TO_CAPABILITY.get(entry);
    if (capability) capabilities.add(capability);
  }
  if (tenantIds.length !== 1) return undefined;
  if (capabilities.size === 0) return undefined;

  const clientId = readStringClaim(claims, "client_id");
  if (!clientId) return undefined;

  return { tenantId: tenantIds[0] as string, clientId, capabilities };
}

/**
 * guard が publish した principal を読む。middleware が動いていなければ `undefined`。
 *
 * `c.get` の存在を確認してから呼ぶ理由は、`resolveTenantId` / `resolveUserRole` が Hono の
 * 完全な `Context` ではなく `{ env }` だけを持つ duck-typed object でも呼べる契約になっている
 * ためである (`extractClaims` が `c.env` の不在を許容しているのと同じ層の話)。variable map が
 * 無い object には guard が principal を publish しようもないので、`undefined` は
 * 「machine ではない」という正しい答えであって failure の握り潰しではない。
 */
export function getMachinePrincipal(c: Context): MachinePrincipal | undefined {
  const get = (c as Partial<Pick<Context, "get">>).get;
  if (typeof get !== "function") return undefined;
  return get.call(c, "machinePrincipal");
}

/** audit log / log 行に載せる actor 文字列。 */
export function machineActor(principal: MachinePrincipal): string {
  return `${MACHINE_ACTOR_PREFIX}${principal.clientId}`;
}

/**
 * 全 tenant-facing Hono Lambda の **先頭** に mount する guard。処理順は security-critical。
 *
 *  1. authorizer 無し → 素通し (上記「authorizer が無い経路」)
 *  2. human (`custom:tenantId` あり) → 素通し (human 経路 byte-identical)
 *  3. machine principal を復元できない human でない token → allowlist 外なら即 deny
 *  4. allowlist 外の route → deny (role 解決より前)
 *  5. capability 不足 → deny
 *  6. `?withTeamLoginKeys=true` → 無条件 deny (role により既に構造的に不可だが明示する)
 *  7. ここで初めて principal を context へ publish する
 */
export function createMachineGuardMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path.endsWith("/healthz")) return next();
    const claims = extractClaims(c);
    if (!claims) return next();
    if (isHumanClaims(claims)) return next();

    const method = c.req.method;
    const path = c.req.path;
    const principal = parseMachinePrincipal(claims);
    const route = findMachineRoute(method, path);

    if (!principal) {
      // human でも machine でもない token。allowlist 外は監査付きで即 deny、allowlist 内は
      // 下流の blanket `requireRole` が role 不在で 403 に倒す (どちらでも 403、より早く落とす)。
      if (!route) throw new MachineRouteDeniedError("not_a_machine_principal", method, path);
      return next();
    }
    if (!route) {
      throw new MachineRouteDeniedError("route_not_allowlisted", method, path, principal);
    }
    if (!principal.capabilities.has(route.capability)) {
      throw new MachineRouteDeniedError("capability_missing", method, path, principal);
    }
    if (c.req.query("withTeamLoginKeys") === "true") {
      throw new MachineRouteDeniedError("team_login_keys_forbidden", method, path, principal);
    }

    c.set("machinePrincipal", principal);
    return next();
  };
}
