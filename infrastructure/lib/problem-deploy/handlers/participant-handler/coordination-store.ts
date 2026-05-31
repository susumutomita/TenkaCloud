import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

/**
 * ADR-028 D3 (#1420): inter-team coordination の per-event 共有 state を保存する store。
 *
 * cast-event ([[feedback_inter_team_coordination_plugin]]) と同じく **既存 Deployments テーブルに
 * 新 SK pattern を足すだけ** で新規 table / IAM / CDK は不要 (= participant-handler は既に
 * Deployments への Put 権限を持つ)。 1 event 1 row、 N teams 共有:
 *   PK = `COORD#<tenantId>#<eventId>`   SK = `STATE`
 *   attrs: state (plugin state JSON) / version (optimistic lock) / updatedAt (ISO8601)
 *
 * 書き込みは version 条件付き Put で楽観ロックする (= 同時 op の lost-update を防ぐ。
 * disruption-fire の conditional Put と同方針)。 conflict 時は caller が 409 で退避リトライ。
 */

const SK = "STATE";

function pk(tenantId: string, eventId: string): string {
  return `COORD#${tenantId}#${eventId}`;
}

export interface CoordinationStateRow {
  /** plugin 固有の共有 state。 plugin の applyOp が返した値。 */
  readonly state: unknown;
  /** 楽観ロック用 version。 row が無いときは 0 を初期値として扱う。 */
  readonly version: number;
}

/** store が必要とする DDB client の最小 shape (= test で容易に mock)。 */
export interface CoordinationStoreDeps {
  readonly ddb: Pick<DynamoDBDocumentClient, "send">;
  readonly tableName: string;
}

/** 現在の coordination state を読む。 row が無ければ undefined (= 未初期化)。 */
export async function readCoordinationState(
  deps: CoordinationStoreDeps,
  tenantId: string,
  eventId: string,
): Promise<CoordinationStateRow | undefined> {
  const out = await deps.ddb.send(
    new GetCommand({ TableName: deps.tableName, Key: { PK: pk(tenantId, eventId), SK } }),
  );
  if (!out.Item) return undefined;
  return { state: out.Item.state, version: Number(out.Item.version ?? 0) };
}

export type WriteCoordinationOutcome = { kind: "ok" } | { kind: "conflict" };

/**
 * 楽観ロックで state を書く。 `expectedVersion` が現在の version と一致するときだけ成功し、
 * version を +1 する。 新規 row (= version 不在) は `expectedVersion === 0` のときだけ作成する。
 * 不一致 (= 並行更新) は `conflict` を返し、 caller がリトライ判断する。
 */
export async function writeCoordinationState(
  deps: CoordinationStoreDeps,
  tenantId: string,
  eventId: string,
  state: unknown,
  expectedVersion: number,
  nowIso: string,
): Promise<WriteCoordinationOutcome> {
  try {
    await deps.ddb.send(
      new PutCommand({
        TableName: deps.tableName,
        Item: {
          PK: pk(tenantId, eventId),
          SK,
          state,
          version: expectedVersion + 1,
          updatedAt: nowIso,
        },
        ConditionExpression: "attribute_not_exists(version) OR version = :expected",
        ExpressionAttributeValues: { ":expected": expectedVersion },
      }),
    );
    return { kind: "ok" };
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return { kind: "conflict" };
    throw err;
  }
}
