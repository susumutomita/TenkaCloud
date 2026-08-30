import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DeploymentsCoordinationPort } from "../../control-data/deployments-repository.js";
import {
  type CoordinationStateScope,
  coordinationStateExpiresAt,
} from "../../control-data/domain/coordination-scope.js";
import type { ControlDataRuntime } from "../../control-data/runtime-repositories.js";
import { resolveDeploymentsRepository } from "./shared.js";

/**
 * Issue #1420: inter-team coordination の per-event 共有 state を保存する store。
 *
 * cast-event と同じく **既存 Deployments テーブルに
 * 新 SK pattern を足すだけ** で新規 table / IAM / CDK は不要 (= participant-handler は既に
 * Deployments への Put 権限を持つ)。 1 (event, problem, run) 1 row、 N teams 共有:
 *   PK = `COORD#<tenantId>#<eventId>#<problemId>#<runId>`   SK = `STATE`
 *   attrs: state (plugin state JSON) / version (optimistic lock) / updatedAt (ISO8601) /
 *          expiresAt (TTL, epoch seconds)
 *
 * [Issue #3123] key に problem / run が入る前は `COORD#<tenantId>#<eventId>` の 1 行を
 * 1 event 内の **全** coordination 問題が共有しており、 2 問目の deploy が 1 問目の
 * game state を黙って上書きしていた。 namespace / lifecycle / retention は platform の
 * 責務で、 plugin は永続化 key を一切知らない (= pure state machine のまま)。
 *
 * 書き込みは version 条件付き Put で楽観ロックする (= 同時 op の lost-update を防ぐ。
 * disruption-fire の conditional Put と同方針)。 conflict 時は caller が 409 で退避リトライ。
 *
 * [Issue #2441 / Phase B3] The PK/SK derivation + conditional Put now live in
 * `DeploymentsRepository.writeCoordinationState`; this module maps its A2/B2-style
 * `{ outcome: "updated" | "conflict" }` union back onto the pre-seam
 * `WriteCoordinationOutcome` shape so callers are unchanged.
 */

export {
  type CoordinationStateScope,
  DEFAULT_COORDINATION_RUN_ID,
} from "../../control-data/domain/coordination-scope.js";

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
  scope: CoordinationStateScope,
): Promise<CoordinationStateRow | undefined> {
  const repository: DeploymentsCoordinationPort = await resolveDeploymentsRepository(deps);
  return repository.readCoordinationState(scope);
}

export type WriteCoordinationOutcome = { kind: "ok" } | { kind: "conflict" };

/**
 * version 条件付きで state を書く。
 *   - 新規 (row 無し): expectedVersion=0 で呼ぶ → attribute_not_exists(version) が成立
 *   - 更新: 直前の read が返した version を渡す → 一致時のみ上書き
 * 競合 (他の op が先に書いた) は例外にせず `{ kind: "conflict" }` を返す。
 *
 * [Issue #3123] `nowMs` は行の TTL (`expiresAt`) 算出にも使う。 write のたびに更新されるので、
 * 試合中の row は期限切れにならず、 teardown を取りこぼした row だけが自然に消える。
 */
export async function writeCoordinationState(
  deps: CoordinationStoreDeps,
  scope: CoordinationStateScope,
  state: unknown,
  expectedVersion: number,
  nowIso: string,
): Promise<WriteCoordinationOutcome> {
  const repository: DeploymentsCoordinationPort = await resolveDeploymentsRepository(deps);
  const outcome = await repository.writeCoordinationState(
    scope,
    state,
    expectedVersion,
    nowIso,
    coordinationStateExpiresAt(parseNowMs(nowIso)),
  );
  return outcome.outcome === "updated" ? { kind: "ok" } : { kind: "conflict" };
}

/**
 * [Issue #3123] `nowIso` -> epoch ms。 caller は全て `new Date(...).toISOString()` を渡すので
 * 到達しないが、 parse 不能な値をそのまま通すと `expiresAt` が `NaN` になり、 行が「TTL 属性が
 * 数値でない」= 永久に sweep されない row として静かに残る。 壊れた retention を黙って作るより、
 * 呼び出し側の bug をその場で落とす。
 */
function parseNowMs(nowIso: string): number {
  const parsed = Date.parse(nowIso);
  if (Number.isNaN(parsed)) {
    throw new RangeError(`coordination write timestamp is not an ISO8601 instant: ${nowIso}`);
  }
  return parsed;
}

/**
 * [Issue #3123] platform lifecycle 用 primitive: 1 つの scope の state を消す。
 *
 * 冪等 — 存在しない row の削除は成功。 run reset (= 次の op が initialState から再構築),
 * problem destroy, event cleanup がすべてこれを呼ぶ。 他の scope には触れない。
 */
export async function deleteCoordinationState(
  deps: CoordinationStoreDeps,
  scope: CoordinationStateScope,
): Promise<void> {
  const repository: DeploymentsCoordinationPort = await resolveDeploymentsRepository(deps);
  await repository.deleteCoordinationState(scope);
}
