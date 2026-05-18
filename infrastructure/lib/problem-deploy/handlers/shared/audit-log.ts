import { DynamoDBClient, type DynamoDBClient as RawDynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";

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
 */

const AUDIT_TTL_DAYS = 90;
const AUDIT_TTL_SECONDS = AUDIT_TTL_DAYS * 86400;

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

export interface AuditClient {
  send: typeof documentClient.send;
}

function getEnv(): { tableName: string; env: string } | undefined {
  const tableName = process.env.ADMIN_AUDIT_LOG_TABLE_NAME ?? "";
  if (tableName.length === 0) return undefined;
  const env = process.env.DEPLOY_ENVIRONMENT ?? "development";
  return { tableName, env };
}

/**
 * audit 行を書き込む (= 業務 logic と並列の補助 write、 fail-safe)。
 *
 * 戻り値: 書き込んだ場合 true、 env 未配線 / 失敗の場合 false。 caller は戻り値を見ない
 * (= 「best-effort write」 として扱う)。 unit test は env mock + client mock で coverage。
 */
export async function writeAuditEvent(
  event: AuditEvent,
  client: AuditClient = documentClient,
): Promise<boolean> {
  const cfg = getEnv();
  if (!cfg) return false;
  const occurredAt = new Date(event.occurredAtMs).toISOString();
  const id = ulid(event.occurredAtMs);
  const pk = event.tenantId === "SYSTEM" ? `SYSTEM#${cfg.env}` : `TENANT#${event.tenantId}`;
  const ttl = Math.floor(event.occurredAtMs / 1000) + AUDIT_TTL_SECONDS;

  const item: Record<string, unknown> = {
    PK: pk,
    SK: `AUDIT#${id}`,
    GSI1PK: `ACTOR#${event.actor}`,
    GSI1SK: occurredAt,
    actor: event.actor,
    action: event.action,
    outcome: event.outcome,
    occurredAt,
    ttl,
  };
  if (event.actorUsername) item.actorUsername = event.actorUsername;
  if (event.target) item.target = event.target;
  if (event.ipAddress) item.ipAddress = event.ipAddress;
  if (event.userAgent) item.userAgent = event.userAgent;
  if (event.extra) item.extra = event.extra;

  try {
    await client.send(
      new PutCommand({
        TableName: cfg.tableName,
        Item: item,
      }),
    );
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
  const sub = typeof claims?.sub === "string" ? claims.sub : "unknown";
  const cognitoUsername =
    typeof claims?.["cognito:username"] === "string"
      ? (claims["cognito:username"] as string)
      : undefined;
  const http = (event?.requestContext as { http?: { sourceIp?: string; userAgent?: string } })
    ?.http;
  return {
    actor: sub,
    actorUsername: cognitoUsername,
    ipAddress: http?.sourceIp,
    userAgent: http?.userAgent,
  };
}
