import { z } from "zod";

/**
 * Issue #839 follow-up Phase B: Tenant 管理者が画面/API から自社 SAML IdP を設定するための
 * request / response shape。
 *
 * 設計原則:
 *  - `metadataUrl` は HTTPS のみ受け付ける (= 暗号化されてない metadata 経路を作らない)
 *  - `providerName` は Cognito の制約 (= URL 安全な英数字 + `-_`、 3-32 字) に厳密にマッチ
 *  - `enforceSamlOnly` を `true` に flip するときは UI 側で 2-step 確認モーダルを要求する想定
 *    (= API 層は per-request validation のみ、 確認 UX は別経路で担保)
 */

const PROVIDER_NAME_RE = /^[A-Za-z0-9_-]{3,32}$/;

export const TenantSamlConfigInputSchema = z.object({
  metadataUrl: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), {
      message: "metadataUrl は HTTPS 必須です (= IdP の federation metadata XML URL)",
    })
    .refine((u) => u.length <= 2048, {
      message: "metadataUrl が長すぎます (max 2048 文字)",
    }),
  providerName: z
    .string()
    .regex(PROVIDER_NAME_RE, {
      message: "providerName は英数字 + - _ の 3-32 文字 (Cognito 制約)",
    })
    .optional(),
  attributeMapping: z
    .record(z.string().min(1), z.string().min(1).max(2048))
    .optional()
    .refine((m) => !m || Object.keys(m).length <= 32, {
      message: "attributeMapping のエントリ数が多すぎます (max 32)",
    }),
  enforceSamlOnly: z.boolean().optional(),
});

export type TenantSamlConfigInput = z.infer<typeof TenantSamlConfigInputSchema>;

/**
 * GET / PUT response。 DDB に persist されている current config を返す。 secret は無いので
 * 全 field をそのまま expose する (= metadata URL は IdP 側で公開済の URL なので漏れても無害)。
 */
export interface TenantSamlConfigView {
  readonly enabled: boolean;
  readonly metadataUrl?: string;
  readonly providerName?: string;
  readonly attributeMapping?: Readonly<Record<string, string>>;
  readonly enforceSamlOnly?: boolean;
  /** ISO 8601、 最終更新時刻。 未設定なら undefined。 */
  readonly updatedAt?: string;
  /** Cognito sub (= 監査用、 UI は表示せずログのみ)。 */
  readonly updatedBy?: string;
}

/** Cognito IdP の default 表示名 (= caller が providerName を指定しなかったとき)。 */
export const DEFAULT_SAML_PROVIDER_NAME = "CompanySAML";

/** SAML emailaddress claim の標準 namespace (= attributeMapping default)。 */
export const DEFAULT_SAML_EMAIL_CLAIM =
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress";

/**
 * caller の `attributeMapping` に email key が無ければ default を埋める。 既に指定されていれば
 * caller の値が優先される (= Entra ID 等の非標準 claim 対応)。
 */
export function normalizeAttributeMapping(
  input: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const base: Record<string, string> = { email: DEFAULT_SAML_EMAIL_CLAIM };
  if (!input) return base;
  return { ...base, ...input };
}
