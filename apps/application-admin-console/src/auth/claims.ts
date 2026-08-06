/**
 * Cognito JWT (id_token) の payload を読む util。署名検証は API gateway authorizer 側で
 * 行うので frontend ではデコードのみ。秘匿情報は出さない (mask 画面表示用)。
 *
 * provision-tenant.sh が admin-create-user で設定する custom 属性:
 *   - custom:tenantId  (常時)
 *   - custom:userRole  (常時 = "TenantAdmin")
 *   - custom:tenantTier (常時 = "BASIC" / "ADVANCED" / "PLATINUM")
 *   - custom:tenantName (将来追加予定。現状は無いので undefined になる)
 */
export interface IdTokenClaims {
  sub?: string;
  email?: string;
  /** `https://cognito-idp.<region>.amazonaws.com/<userPoolId>` — used to derive the SP Entity ID. */
  iss?: string;
  "cognito:groups"?: string | string[];
  "custom:tenantId"?: string;
  "custom:tenantName"?: string;
  "custom:userRole"?: string;
  "custom:tenantTier"?: string;
}

export type TenantConsoleRole = "editor" | "viewer";

export interface TenantConsoleAccess {
  readonly role: TenantConsoleRole;
  readonly canMutateTenant: boolean;
}

const EDITOR_ROLE_ALIASES = new Set([
  "admin",
  "editor",
  "operator",
  "tenantadmin",
  "tenanteditor",
  "tenantoperator",
]);
const VIEWER_ROLE_ALIASES = new Set(["readonly", "tenantviewer", "viewer"]);

function normalizeRoleToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function normalizeTenantConsoleRole(value: string): TenantConsoleRole | null {
  const normalized = normalizeRoleToken(value);
  if (EDITOR_ROLE_ALIASES.has(normalized)) return "editor";
  if (VIEWER_ROLE_ALIASES.has(normalized)) return "viewer";
  return null;
}

function roleClaimValues(claims: IdTokenClaims | null): readonly string[] {
  if (!claims) return [];
  const values: string[] = [];
  const customRole = claims["custom:userRole"];
  if (typeof customRole === "string") values.push(customRole);
  const groups = claims["cognito:groups"];
  if (Array.isArray(groups)) {
    values.push(...groups.filter((group) => typeof group === "string"));
  } else if (typeof groups === "string") {
    values.push(...groups.split(/[,\s]+/).filter((group) => group.length > 0));
  }
  return values;
}

export function resolveTenantConsoleAccess(claims: IdTokenClaims | null): TenantConsoleAccess {
  const roles = roleClaimValues(claims)
    .map((value) => normalizeTenantConsoleRole(value))
    .filter((role): role is TenantConsoleRole => role !== null);
  if (roles.includes("editor")) {
    return { role: "editor", canMutateTenant: true };
  }
  return { role: "viewer", canMutateTenant: false };
}

export function decodeIdToken(idToken: string): IdTokenClaims | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    // atob は binary string を返すので、日本語等の multi-byte 文字を正しく
    // 復号するため UTF-8 でデコードする (Cognito JWT は UTF-8 / base64url)。
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as IdTokenClaims;
  } catch {
    return null;
  }
}
