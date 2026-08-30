import { randomBytes } from "node:crypto";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DeploymentsCoordinationPort } from "../../control-data/deployments-repository.js";
import {
  type CoordinationStateScope,
  coordinationStateExpiresAt,
  createCoordinationMatchSecret,
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
  shouldRefreshCoordinationTtl,
} from "../../control-data/domain/coordination-scope.js";

export interface CoordinationStateRow {
  /** plugin 固有の共有 state。 plugin の applyOp が返した値。 */
  readonly state: unknown;
  /** 楽観ロック用 version。 row が無いときは 0 を初期値として扱う。 */
  readonly version: number;
  /** [Issue #3123] 行の TTL (epoch 秒)。 TTL 以前に書かれた行では undefined。 */
  readonly expiresAt?: number;
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
 * [Issue #3123] `nowIso` は行の TTL (`expiresAt`) 算出にも使う。 teardown を取りこぼした row を
 * 自然に消すための backstop であって、 主たる削除経路ではない。
 *
 * write だけが期限を延ばすわけではない (そうであってはならない)。 `tick` hook を持たない plugin は
 * 参加者が動いたときにしか書かないので、 write 基準だと終了時刻の無い event で試合中の row が
 * 期限切れになる。 tick 側が {@link touchCoordinationState} で延長する。
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
 * [Issue #3123] state / version に触れず TTL だけ延ばす。
 *
 * TTL は「試合が終わった」と「誰も動いていない」を区別できない。 `tick` hook を持たない plugin
 * (`microservice-migration-battle` の `router.ts`) は参加者が動いたときにしか書かないため、
 * 終了時刻の無い event ではその登録 state が試合中に期限切れになり、 次の request が黙って
 * `plugin.initialState` から作り直してしまう。
 *
 * tick は開始済み event の全 coordination problem に対して毎分走り (plugin が `tick` を
 * 実装しているかに依らない)、 event が終われば止まる。 そこから TTL を延ばすことで、
 * retention の起点が「参加者が静かになった時刻」ではなく「**event** が静かになった時刻」になる。
 */
export async function touchCoordinationState(
  deps: CoordinationStoreDeps,
  scope: CoordinationStateScope,
  nowIso: string,
): Promise<void> {
  const repository: DeploymentsCoordinationPort = await resolveDeploymentsRepository(deps);
  await repository.touchCoordinationState(scope, coordinationStateExpiresAt(parseNowMs(nowIso)));
}

/**
 * [Issue #3133] この試合の server-only 秘密を返す。 未発行なら発行して保存する (= op 経路)。
 *
 * plugin が `initialState` を呼ぶ前に必要なので、 state の read と write の間ではなく
 * **read の直後** に解決する。 発行は scope ごとに 1 度きり — 途中で変わると、 それまでに
 * 導出済みの share / 暗号文が全部無効になる。 同時に来た 2 つの op は backend の
 * insert-if-absent で同じ値に収束する。
 *
 * 戻り値は participant-facing な応答へは決して載せない。 構造としても、 秘密は state 行とは
 * 別の row / 別 table にあり {@link readCoordinationState} の SELECT からは見えない。
 */
export async function ensureCoordinationMatchSecret(
  deps: CoordinationStoreDeps,
  scope: CoordinationStateScope,
  nowIso: string,
): Promise<string> {
  const repository: DeploymentsCoordinationPort = await resolveDeploymentsRepository(deps);
  return repository.ensureCoordinationMatchSecret(
    scope,
    createCoordinationMatchSecret(randomBytes),
    coordinationStateExpiresAt(parseNowMs(nowIso)),
  );
}

/**
 * [Issue #3133] 発行済みの秘密を読むだけ (= 発行しない)。 read 専用経路 (portal の polling) 用。
 *
 * polling で発行してしまうと、 GET が書き込みになり、 始まらないかもしれない試合に秘密を
 * 配ることになる。 未発行なら undefined を返し、 plugin 側の fallback に委ねる。
 */
export async function readCoordinationMatchSecret(
  deps: CoordinationStoreDeps,
  scope: CoordinationStateScope,
): Promise<string | undefined> {
  const repository: DeploymentsCoordinationPort = await resolveDeploymentsRepository(deps);
  return repository.readCoordinationMatchSecret(scope);
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
