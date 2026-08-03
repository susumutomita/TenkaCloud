import type { Context } from "hono";
import { type AuditOutcome, extractAuditContext, writeAuditEvent } from "../audit-log.js";
import { type AuditResourceType, diffSnapshots, type RedactedSnapshot } from "./redact.js";

/**
 * Issue #1292: mutating route の handler を 1 行で包み、 audit 行を fire-and-forget 書き込む
 * convenience wrapper。 既存 `writeAuditEvent` の explicit 呼び出し pattern を残しつつ、
 * `before` / `after` snapshot capture と redaction を 1 箇所に集約する。
 *
 * 設計判断: Hono の `app.use("*", middleware)` 形式の transparent middleware にはしない。
 * 理由は以下:
 * 1. 既存 handlers は意味のある `action` 名 (= `create_competitor_account` /
 *    `rotate_external_id` 等) を渡しており、 URL / method からは推定できない (= 同じ
 *    POST /admin/competitor-accounts でも create と verify は別 action)。
 * 2. `before` / `after` snapshot は handler 内部で domain object を引いてからでないと
 *    取れない (= route entry / exit interceptor では取れない)。
 * 3. middleware を間に挟むと「route が動いた / audit が書かれた」 の因果が見えづらくなる。
 *    Hono の error path とも干渉する。
 *
 * よって、 各 mutating route で 1 行 `withAudit({ ... }, async () => { ... })` で包む方針
 * を採用する。 これにより:
 * - `before` / `after` の redact を caller が忘れない (= 引数で要求する)
 * - throw 時に outcome="error" の audit 行が **必ず** 残る (= silent failure 検出)
 * - 既存 explicit pattern (= `void writeAuditEvent(...)`) との後方互換性
 *
 * fail-safe: audit write は `void` で fire-and-forget。 await しない (= response latency
 * を audit DDB に絡めない)。 unit test は emitter mock で発火を pin する。
 */

export interface AuditEnvelope {
  readonly tenantId: string;
  readonly action: string;
  readonly resource: AuditResourceType;
  readonly target?: string;
  /** redactForAudit 済の before snapshot (= 任意、 create では空)。 */
  readonly before?: RedactedSnapshot;
  /** redactForAudit 済の after snapshot (= 任意、 delete では空)。 */
  readonly after?: RedactedSnapshot;
  /** 任意の追加情報 (= primitive string map のみ、 PII 禁止)。 */
  readonly extra?: Readonly<Record<string, string>>;
}

export interface AuditWrapResult {
  readonly outcome: AuditOutcome;
  /** 任意で envelope を update して書く (= before/after を後から差し替えるケース)。 */
  readonly envelope?: Partial<AuditEnvelope>;
}

/**
 * `withAudit` を呼ぶと:
 * 1. body() を await で実行
 * 2. body() が `AuditWrapResult` を返したら outcome をその値に
 * 3. body() が throw したら outcome="error" の audit 行を 1 つ書いて throw を再投する
 *    (= caller の onError ハンドラを邪魔しない)
 *
 * audit write は `void` で fire-and-forget。 caller の Response を遅延させない。
 */
export async function withAudit<T>(
  c: Context,
  envelope: AuditEnvelope,
  body: () => Promise<{ result: T; audit: AuditWrapResult }>,
): Promise<T> {
  const auditCtx = extractAuditContext(c);
  const occurredAtMs = Date.now();
  try {
    const { result, audit } = await body();
    const merged = mergeEnvelope(envelope, audit.envelope);
    emit(merged, audit.outcome, auditCtx, occurredAtMs);
    return result;
  } catch (err) {
    emit(envelope, "error", auditCtx, occurredAtMs, errorMessage(err));
    throw err;
  }
}

function mergeEnvelope(
  base: AuditEnvelope,
  override: Partial<AuditEnvelope> | undefined,
): AuditEnvelope {
  if (!override) return base;
  return {
    ...base,
    ...override,
    extra: { ...(base.extra ?? {}), ...(override.extra ?? {}) },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "unknown_error";
}

function buildExtra(envelope: AuditEnvelope, errorMsg: string | undefined): Record<string, string> {
  const extra: Record<string, string> = { resource: envelope.resource };
  if (envelope.extra) for (const [k, v] of Object.entries(envelope.extra)) extra[k] = v;
  applyDiffExtras(extra, envelope);
  if (errorMsg) extra.errorMessage = errorMsg.substring(0, 256);
  return extra;
}

function applyDiffExtras(extra: Record<string, string>, envelope: AuditEnvelope): void {
  if (envelope.before) {
    const diff =
      envelope.after !== undefined
        ? diffSnapshots(envelope.before, envelope.after)
        : { before: envelope.before, after: {} as RedactedSnapshot };
    if (Object.keys(diff.before).length > 0) extra.before = JSON.stringify(diff.before);
    if (Object.keys(diff.after).length > 0) extra.after = JSON.stringify(diff.after);
    return;
  }
  if (envelope.after && Object.keys(envelope.after).length > 0) {
    extra.after = JSON.stringify(envelope.after);
  }
}

function emit(
  envelope: AuditEnvelope,
  outcome: AuditOutcome,
  auditCtx: ReturnType<typeof extractAuditContext>,
  occurredAtMs: number,
  errorMsg?: string,
): void {
  void writeAuditEvent({
    tenantId: envelope.tenantId,
    actor: auditCtx.actor,
    ...(auditCtx.actorUsername ? { actorUsername: auditCtx.actorUsername } : {}),
    action: envelope.action,
    outcome,
    ...(envelope.target ? { target: envelope.target } : {}),
    ...(auditCtx.ipAddress ? { ipAddress: auditCtx.ipAddress } : {}),
    ...(auditCtx.userAgent ? { userAgent: auditCtx.userAgent } : {}),
    occurredAtMs,
    extra: buildExtra(envelope, errorMsg),
  });
}

/**
 * shortcut: success path で envelope 全部使う 1-shot wrapper。 body() は any-T を返す。
 * audit override 不要なケース (= 9 割の handler) で使う。
 */
export async function withAuditSuccess<T>(
  c: Context,
  envelope: AuditEnvelope,
  body: () => Promise<T>,
): Promise<T> {
  return withAudit(c, envelope, async () => ({
    result: await body(),
    audit: { outcome: "success" },
  }));
}

export type { AuditResourceType };
