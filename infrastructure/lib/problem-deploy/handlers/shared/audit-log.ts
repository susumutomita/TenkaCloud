import { DynamoDBClient, type DynamoDBClient as RawDynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import {
  type ControlDataRuntime,
  createDefaultControlDataRuntime,
} from "../../control-data/runtime-repositories.js";
import type { AdminAuditRow } from "../../control-data/types.js";
import { MACHINE_ACTOR_PREFIX } from "./machine-scopes.js";

/**
 * Issue #950 (ADR-020 Phase D): admin 操作の append-only 監査ログを書き込む shared helper。
 *
 * 旧状態: admin 操作 (= user 招待 / role 変更 / 削除、 SAML CRUD、 ExternalId rotate、 Event 削除 等) は
 * CloudWatch Logs に \`console.log\` で 1 行残るだけ。 「誰が・いつ・何を」 を後追いする集約 storage が
 * 無く、 audit は CloudWatch Logs Insights grep に依存。 本 helper は 3 handler (= deploy /
 * event / competitor-accounts) と admin-insight Lambda から共通で呼ばれ、 1 DDB Table に行を
 * 集約する (= ADR-006 Notifications の writeScoreEvent と同パターン)。
 *
 * Schema (= `admin-audit-log-table.ts` 参照):
 *   PK: TENANT#<tenantId>   (tenant 操作)
 *       SYSTEM#<env>        (SystemAdmin 操作、 tenant に紐づかない)
 *   SK: AUDIT#<ulid>
 *   GSI1PK: ACTOR#<sub>     (actor 別の 「誰が何をしたか」 query)
 *   GSI1SK: <occurredAt ISO8601>
 *   attrs: actor / actorUsername / action / outcome / target / ipAddress / userAgent /
 *          occurredAt / ttl
 *
 * fail-safe: write 失敗しても caller の business logic を阻害しない (= audit 行欠落より
 * primary 操作の成功を優先)。 失敗時は console.error で警告のみ。
 *
 * env: `ADMIN_AUDIT_LOG_TABLE_NAME` が空文字 / 未設定なら write は no-op (= 旧 stack 互換、
 * audit 行 0 件で正常動作)。 CDK 側で table 配線が landed したあとから自動で記録され始める。
 *
 * Retention (Issue #1341 / #1335 Phase 3): SOC2 typical 1-year retention 要件のため、
 * `AUDIT_RETENTION_DAYS` env で TTL 日数を override できる。 default 90 日 (= OSS / self-hosted)、
 * enterprise hosted は env で 365 を指定する。 immutable archive (= S3 Object Lock 1-year compliance)
 * は別経路 (= DDB Stream → S3 Lambda) で長期保管する設計のため、 TTL 365 でも free tier 圧迫は
 * 1 op/日 × 365 ≒ 365 行で minor (= 1/1 RCU/WCU で吸収できる)。
 */

const DEFAULT_AUDIT_TTL_DAYS = 90;
const ENTERPRISE_AUDIT_TTL_DAYS = 365;
const SECONDS_PER_DAY = 86400;

/**
 * Issue #1341: env `AUDIT_RETENTION_DAYS` を解釈する。 未設定 / 空文字 / 不正値は
 * 90 日 default に倒す (= OSS 互換)。 正の整数に限り受理する (= 入力 sanitize)。
 */
export function resolveAuditRetentionDays(): number {
  const raw = process.env.AUDIT_RETENTION_DAYS;
  if (!raw) return DEFAULT_AUDIT_TTL_DAYS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_AUDIT_TTL_DAYS;
  // SOC2 typical 1-year (= 365)、 finance 7-year (= 2555) の範囲を許容。 上限は 10 年 (= 3650)
  // でガード (= 設定ミスで TTL が極端に長くなり ttl pruning が事実上 disabled になるのを防ぐ)。
  const MAX_DAYS = 3650;
  if (parsed > MAX_DAYS) return MAX_DAYS;
  return parsed;
}

/** SOC2 enterprise default. Re-exported for CDK tests and ADR alignment. */
export const SOC2_AUDIT_RETENTION_DAYS = ENTERPRISE_AUDIT_TTL_DAYS;

/**
 * Issue #2311 (ADR-049 cost-zero): 監査ログ出力の on/off を deploy 時に切り替える feature flag。
 *
 * 監査行 1 write = `DynamoDbLowCapacity` で 1 WCU に固定された table への 1 write であり、
 * organizer にとっては書き込みコスト (WCU 予算 / burst credit) とのトレードオフになる。監査が
 * 不要なイベントでは出力を止めてコストを節約できるようにする。
 *
 * env `AUDIT_LOG_ENABLED` が明示的に `"false"` のときだけ無効化する (= **default on**、未設定 /
 * `"true"` は従来どおり書き込む → 旧挙動互換でリグレッションなし)。全ての監査書き込みは
 * `writeAuditEvent` を通る (admin 操作 / SBT onboarding / Cognito sign-in の各 Lambda 含む) ため、
 * ここ 1 箇所の gate で全経路をカバーする。
 */
export function isAuditLoggingEnabled(): boolean {
  return process.env.AUDIT_LOG_ENABLED !== "false";
}

export type AuditOutcome = "success" | "forbidden" | "not_found" | "conflict" | "error";

export interface AuditEvent {
  /**
   * tenant 操作なら tenantId、 SystemAdmin 操作なら `"SYSTEM"` を渡す。 後者は
   * `PK = "SYSTEM#<env>"` で書かれる (= tenant 越境のない単一 partition)。
   */
  readonly tenantId: string;
  /** Cognito sub (= 安定識別子)。 不明なら "unknown" を渡す。 */
  readonly actor: string;
  /** Cognito cognito:username (= 通常 email)。 不明なら undefined。 */
  readonly actorUsername?: string;
  /** e.g. "patch_user_role" / "invite_user" / "rotate_external_id" / "delete_event"。 */
  readonly action: string;
  readonly outcome: AuditOutcome;
  /** 対象 resource (= username / awsAccountId / eventId)。 */
  readonly target?: string;
  /** Source IP (X-Forwarded-For 等)。 */
  readonly ipAddress?: string;
  readonly userAgent?: string;
  /** ms epoch (= Date.now())、 ISO8601 化して保存。 */
  readonly occurredAtMs: number;
  /** optional 追加情報 (= 任意の string map、 内部監査用のみで PII を入れない)。 */
  readonly extra?: Readonly<Record<string, string>>;
}

const documentClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({}) satisfies RawDynamoDBClient,
);

/**
 * [#2527 Slice 4] Default control-data runtime for this fire-and-forget audit
 * side-channel — the same injectable-with-real-default convention as
 * `documentClient` above. The 12 `void writeAuditEvent(...)` call sites across
 * four Lambda families stay signature-free; tests (and any future caller that
 * wants the entrypoint's instance) inject a runtime explicitly instead. This is
 * the one deliberate self-composed runtime left after the Slice 4 DI migration.
 */
const defaultAuditRuntime = createDefaultControlDataRuntime();

export interface AuditClient {
  send: typeof documentClient.send;
}

/**
 * [Issue #2442 / Phase C4] `true` for pure-SQL `CONTROL_DATA_BACKEND` values, where the
 * AdminAuditLog DynamoDB table is not synthesized (no `ADMIN_AUDIT_LOG_TABLE_NAME` env either) —
 * the seam routes straight to the SQL executor instead, so an empty table name is legitimate
 * there, not a misconfiguration (mirrors the A5/B6/C1-C3 pattern).
 */
function isPureSqlBackend(): boolean {
  const backend = process.env.CONTROL_DATA_BACKEND;
  return backend === "turso";
}

function getEnv(): { tableName: string; env: string } | undefined {
  const tableName = process.env.ADMIN_AUDIT_LOG_TABLE_NAME ?? "";
  // the dynamodb backend requires the physical table; a legacy stack that never wired the
  // table stays a no-op (旧 stack 互換). Pure SQL never had a table to begin with.
  if (!isPureSqlBackend() && tableName.length === 0) return undefined;
  const env = process.env.DEPLOY_ENVIRONMENT ?? "development";
  return { tableName, env };
}

/**
 * audit 行を書き込む (= 業務 logic と並列の補助 write、 fail-safe)。
 *
 * 戻り値: 書き込んだ場合 true、 env 未配線 / 失敗の場合 false。 caller は戻り値を見ない
 * (= 「best-effort write」 として扱う)。 unit test は env mock + client mock で coverage。
 *
 * [Issue #2442 / Phase C4] The actual write now routes through the `AdminAuditLogRepository` seam
 * (`CONTROL_DATA_BACKEND` participation, mirrors every other C-phase aggregate). The
 * best-effort contract is unchanged: the seam itself throws on failure (fail loud, matching every
 * other repository in this codebase), and this function is the one place that catches it and
 * degrades to a warning — callers never see a rejected promise.
 */
export async function writeAuditEvent(
  event: AuditEvent,
  client: AuditClient = documentClient,
  runtime: ControlDataRuntime = defaultAuditRuntime,
): Promise<boolean> {
  // Issue #2311: feature flag で無効化されていれば table 配線に関係なく no-op。
  if (!isAuditLoggingEnabled()) return false;
  const cfg = getEnv();
  if (!cfg) return false;
  const occurredAt = new Date(event.occurredAtMs).toISOString();
  const id = ulid(event.occurredAtMs);
  const pk = event.tenantId === "SYSTEM" ? `SYSTEM#${cfg.env}` : `TENANT#${event.tenantId}`;
  const ttl = Math.floor(event.occurredAtMs / 1000) + resolveAuditRetentionDays() * SECONDS_PER_DAY;

  const row: AdminAuditRow = {
    pk,
    sk: `AUDIT#${id}`,
    gsi1pk: `ACTOR#${event.actor}`,
    gsi1sk: occurredAt,
    actor: event.actor,
    action: event.action,
    outcome: event.outcome,
    occurredAt,
    ttl,
    ...(event.actorUsername ? { actorUsername: event.actorUsername } : {}),
    ...(event.target ? { target: event.target } : {}),
    ...(event.ipAddress ? { ipAddress: event.ipAddress } : {}),
    ...(event.userAgent ? { userAgent: event.userAgent } : {}),
    ...(event.extra ? { extra: event.extra } : {}),
  };

  try {
    const repository = await runtime.resolveAdminAuditLogRepository({
      // Structurally-typed `AuditClient` (test-injectable) vs the concrete DynamoDBDocumentClient
      // the repository expects — production always passes the real singleton; only tests pass a
      // duck-typed `{ send }` fake here (same cast convention `makeFakeDdb` test helpers use).
      ddb: client as unknown as DynamoDBDocumentClient,
      adminAuditLogTableName: cfg.tableName,
    });
    await repository.appendAudit(row);
    return true;
  } catch (err) {
    // audit 行欠落は primary 操作の成否に比べて重要度が低い。 log は残すが throw しない。
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[audit] writeAuditEvent failed", {
      action: event.action,
      outcome: event.outcome,
      message,
    });
    return false;
  }
}

/**
 * Hono Context から actor / actorUsername / ipAddress / userAgent を抽出する helper。
 * 既存 `resolveCognitoSub` と同じ JWT claims 経路を読む (= deploy-handler/auth.ts に依存しない、
 * lightweight な独立 helper)。
 */
export function extractAuditContext(c: {
  env?: unknown;
  req?: { header: (name: string) => string | undefined };
}): {
  actor: string;
  actorUsername: string | undefined;
  ipAddress: string | undefined;
  userAgent: string | undefined;
} {
  const event = (c.env as { event?: { requestContext?: { authorizer?: unknown; http?: unknown } } })
    ?.event;
  const authorizer = (event?.requestContext as { authorizer?: unknown })?.authorizer as
    | { jwt?: { claims?: Record<string, unknown> }; claims?: Record<string, unknown> }
    | undefined;
  const claims = authorizer?.jwt?.claims ?? authorizer?.claims;
  // #2948 / ADR-0005: machine (M2M) access token には `cognito:username` が無く、`sub` がある
  // 保証も無い。`token_use === "access"` を machine の目印にし、actor を `m2m:<client_id>` に
  // 固定する。`client_id` すら無ければ `m2m:unknown` (= 裸の "unknown" と衝突させないことで、
  // audit 検索で human 不明行と machine 不明行を取り違えない)。
  const isMachineToken = claims?.token_use === "access";
  const clientId = typeof claims?.client_id === "string" ? claims.client_id.trim() : "";
  const sub = isMachineToken
    ? `${MACHINE_ACTOR_PREFIX}${clientId.length > 0 ? clientId : "unknown"}`
    : typeof claims?.sub === "string"
      ? claims.sub
      : "unknown";
  const cognitoUsername =
    !isMachineToken && typeof claims?.["cognito:username"] === "string"
      ? (claims["cognito:username"] as string)
      : undefined;
  // HTTP API v2 → requestContext.http.* ; REST API v1 (= tenant API) → requestContext.identity.*。
  // claims と同様に v1/v2 両方を fallback で読む。 旧実装は v2 path のみで、 REST v1 の tenant API
  // では IP / userAgent が常に undefined → 監査ログの IP 列が "-" のままだった。
  const requestContext = event?.requestContext as {
    http?: { sourceIp?: string; userAgent?: string };
    identity?: { sourceIp?: string; userAgent?: string };
  };
  return {
    actor: sub,
    actorUsername: cognitoUsername,
    ipAddress: requestContext?.http?.sourceIp ?? requestContext?.identity?.sourceIp,
    userAgent: requestContext?.http?.userAgent ?? requestContext?.identity?.userAgent,
  };
}
