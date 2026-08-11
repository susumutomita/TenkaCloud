import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DeploymentsCoordinationPort } from "../../control-data/deployments-repository.js";
import type { ControlDataRuntime } from "../../control-data/runtime-repositories.js";
import { resolveDeploymentsRepository } from "./shared.js";

/**
 * Issue #1420: inter-team coordination の per-event 共有 state を保存する store。
 *
 * cast-event と同じく **既存 Deployments テーブルに
 * 新 SK pattern を足すだけ** で新規 table / IAM / CDK は不要 (= participant-handler は既に
 * Deployments への Put 権限を持つ)。 1 event 1 row、 N teams 共有:
 *   PK = `COORD#<tenantId>#<eventId>`   SK = `STATE`
 *   attrs: state (plugin state JSON) / version (optimistic lock) / updatedAt (ISO8601)
 *
 * 書き込みは version 条件付き Put で楽観ロックする (= 同時 op の lost-update を防ぐ。
 * disruption-fire の conditional Put と同方針)。 conflict 時は caller が 409 で退避リトライ。
 *
 * [Issue #2441 / Phase B3] The PK/SK derivation + conditional Put now live in
 * `DeploymentsRepository.writeCoordinationState`; this module maps its A2/B2-style
 * `{ outcome: "updated" | "conflict" }` union back onto the pre-seam
 * `WriteCoordinationOutcome` shape so callers are unchanged.
 */

export interface CoordinationStateRow {
  /** plugin 固有の共有 state。 plugin の applyOp が返した値。 */
  readonly state: unknown;
  /** 楽観ロック用 version。 row が無いときは 0 を初期値として扱う。 */
  readonly version: number;
}

/** store が必要とする DDB client の最小 shape (= test で容易に mock)。 */
export interface CoordinationStoreDeps {
  /** [#2527 Slice 4] Injected control-data runtime (from the Lambda entrypoint's instance). */
  readonly runtime: ControlDataRuntime;
  readonly ddb: Pick<DynamoDBDocumentClient, "send">;
  readonly tableName: string;
}

/** 現在の coordination state を読む。 row が無ければ undefined (= 未初期化)。 */
export async function readCoordinationState(
  deps: CoordinationStoreDeps,
  tenantId: string,
  eventId: string,
): Promise<CoordinationStateRow | undefined> {
  const repository: DeploymentsCoordinationPort = await resolveDeploymentsRepository(deps);
  return repository.readCoordinationState(tenantId, eventId);
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
  const repository: DeploymentsCoordinationPort = await resolveDeploymentsRepository(deps);
  const outcome = await repository.writeCoordinationState(
    tenantId,
    eventId,
    state,
    expectedVersion,
    nowIso,
  );
  return outcome.outcome === "updated" ? { kind: "ok" } : { kind: "conflict" };
}
