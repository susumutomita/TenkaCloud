import { z } from "zod";

/**
 * Issue #795 / ADR-017 Phase 1: CloudActionIntent schema。
 *
 * 「クレデンシャルを越境させず、 署名された意図 (intent) を越境させ、
 * 検証側で短命 provider-native authority に交換する」 protocol の
 * 入口データ構造。 TenkaCloud の domain (tenant / event / team / problem
 * / deployment / target) を first-class claim として持ち込み、
 * generic credential broker と差別化する。
 *
 * Phase 1 では schema + canonical serialization + JWS sign/verify までを
 * 出荷する。 Phase 2 で AWS AssumeRole adapter を hook の先に繋ぐ。
 *
 * 設計判断:
 *   - canonical serialization は key の lexicographic sort で実現する
 *     (= JCS RFC 8785 の subset、 number は Number.prototype.toString 任せ)。
 *     確定的 byte 表現が JWS payload に入る → 検証側でも同じ payload を
 *     再現できる。
 *   - validate() は zod を使う (= TenkaCloud 内既存 dep、 追加 supply chain
 *     負担なし)。 `.brand<>` で型を nominal にし、 unvalidated 値が
 *     intent として混入する事故を防ぐ。
 *   - version field は literal 固定 (`tenkacloud.cloud-action-intent.v1`)。
 *     将来 v2 を出すときに oneOf で discriminate する余地を残す。
 */

export const INTENT_VERSION = "tenkacloud.cloud-action-intent.v1" as const;

const ProviderEnum = z.enum(["aws", "azure", "gcp", "cloudflare"]);
const ActionTypeEnum = z.enum(["deploy", "destroy", "inspect", "collectOutputs", "verifyTrust"]);
const EngineEnum = z.enum(["cloudformation", "terraform", "bicep", "pulumi", "script"]);

const SourceSchema = z
  .object({
    system: z.literal("tenkacloud"),
    tenantId: z.string().min(1),
    eventId: z.string().min(1).optional(),
    teamId: z.string().min(1).optional(),
    problemId: z.string().min(1).optional(),
    deploymentId: z.string().min(1).optional(),
    targetId: z.string().min(1).optional(),
    workloadId: z.string().min(1),
  })
  .strict();

const TargetSchema = z
  .object({
    provider: ProviderEnum,
    providerAccountRef: z.string().min(1),
    region: z.string().min(1).optional(),
    resourceScope: z.string().min(1).optional(),
  })
  .strict();

const ActionSchema = z
  .object({
    type: ActionTypeEnum,
    engine: EngineEnum,
    entry: z.string().min(1).optional(),
    requestedScopes: z.array(z.string().min(1)).readonly(),
  })
  .strict();

const ConstraintsSchema = z
  .object({
    ttlSeconds: z.number().int().min(1).max(3600),
    notBefore: z.string().datetime().optional(),
    expiresAt: z.string().datetime(),
    maxEstimatedCostUsd: z.number().nonnegative().optional(),
    allowPrivilegeEscalation: z.boolean(),
  })
  .strict();

export const CloudActionIntentSchema = z
  .object({
    version: z.literal(INTENT_VERSION),
    requestId: z.string().min(1),
    nonce: z.string().min(1),
    source: SourceSchema,
    target: TargetSchema,
    action: ActionSchema,
    constraints: ConstraintsSchema,
  })
  .strict();

export type CloudActionIntent = z.infer<typeof CloudActionIntentSchema>;

/**
 * Issue #795 / ADR-017: 検証済み intent を nominal type で表現。 unvalidated
 * 入力が intent として通る事故 (= confused deputy の入口) を型で防ぐ。
 */
export type VerifiedCloudActionIntent = CloudActionIntent & { readonly __verified: true };

export function brandVerified(intent: CloudActionIntent): VerifiedCloudActionIntent {
  return intent as VerifiedCloudActionIntent;
}

/**
 * Issue #795 / ADR-017 Phase 1: canonical JSON serialization。
 *
 * 確定的 byte 表現を作るため key を lexicographic sort し、 array は順序を
 * 保ったまま recurse する。 number / string / boolean / null は
 * JSON.stringify と同じ表現を使う (= JCS の subset、 1.0 / 1e0 等の number
 * 表記差は TS が Number.prototype.toString に統一済みなので問題なし)。
 *
 * 用途: JWS payload の決定的 bytes を作って sign / verify を通すこと、
 * audit log の hashing を再現可能にすること。
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const body = entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",");
  return `{${body}}`;
}

/**
 * Phase 1: parse + validate。 安全な entry point。 zod が refine しない field は
 * SafeParseError として戻る (= 詳細 path 付き)。
 */
export function parseCloudActionIntent(
  raw: unknown,
):
  | { readonly ok: true; readonly intent: CloudActionIntent }
  | { readonly ok: false; readonly issues: readonly string[] } {
  const parsed = CloudActionIntentSchema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, intent: parsed.data };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
  };
}
