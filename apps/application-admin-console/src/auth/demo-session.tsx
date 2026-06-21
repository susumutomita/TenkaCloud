import type { TokenSet } from "@tenkacloud/auth-client";
import { useEffect } from "react";
import type { AppConfig } from "../config";
import { useAuth } from "./AuthProvider";

/**
 * Issue #1954 — no-AWS demo mode の mock session。
 *
 * demo mode では Cognito Hosted UI を回さず、 固定の擬似 session を注入して運営画面を
 * そのまま開けるようにする。 idToken は {@link import("./claims").decodeIdToken} が読める
 * 3-part 構造の擬似 JWT (署名検証は API 側の責務であり frontend では行わない)。
 */

function base64Url(value: object): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const DEMO_CLAIMS = {
  email: "demo-operator@tenkacloud.example",
  "custom:userRole": "TenantAdmin",
  "custom:tenantId": "demo-tenant",
  "custom:tenantName": "Demo Tenant",
} as const;

export const DEMO_ID_TOKEN = `${base64Url({ alg: "none", typ: "JWT" })}.${base64Url(DEMO_CLAIMS)}.demo-signature`;

export const DEMO_TOKENS: TokenSet = {
  idToken: DEMO_ID_TOKEN,
  accessToken: "demo-access-token",
  // 2100-01-01: demo session は失効させない (= 固定値で決定的)。
  expiresAt: 4102444800000,
};

/**
 * demo mode のとき、 auth が ready かつ未ログインなら mock session を 1 度注入する。
 * AuthProvider 配下で render する `DemoSessionBootstrap` から呼ぶ。
 */
export function useDemoSession(config: AppConfig): void {
  const auth = useAuth();
  const ready = auth.ready;
  const hasTokens = Boolean(auth.tokens);
  const setTokens = auth.setTokens;
  useEffect(() => {
    if (config.mode !== "demo") return;
    if (!ready || hasTokens) return;
    setTokens(DEMO_TOKENS);
  }, [config.mode, ready, hasTokens, setTokens]);
}

/** AuthProvider 配下に置く副作用専用コンポーネント (描画なし)。 */
export function DemoSessionBootstrap({ config }: { config: AppConfig }): null {
  useDemoSession(config);
  return null;
}
