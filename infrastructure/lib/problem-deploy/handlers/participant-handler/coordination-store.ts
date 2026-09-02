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
 *
 * [Issue #3150] This module is also the ONLY place that wraps / unwraps the
 * platform's schema-version envelope around the plugin's opaque `state`. The
 * repository (DynamoDB item / SQL row) never sees it -- it stores and returns
 * `state: unknown` verbatim, so neither backend nor the DDL needed a change.
 * `writeCoordinationState` wraps the plugin's state before handing it to the
 * repository; `readCoordinationState` unwraps it back out. A row written
 * before this issue (or through the repository directly) carries no
 * envelope, and is treated as `stateSchemaVersion: undefined` -- reconciled
 * by `coordination-state-schema.ts` as version 1, never as an error.
 */

export {
  type CoordinationStateScope,
  DEFAULT_COORDINATION_RUN_ID,
  shouldRefreshCoordinationTtl,
} from "../../control-data/domain/coordination-scope.js";

export interface CoordinationStateRow {
  /** plugin 固有の共有 state。 plugin の applyOp が返した値 (= envelope は剥がした後)。 */
  readonly state: unknown;
  /** 楽観ロック用 version。 row が無いときは 0 を初期値として扱う。 */
  readonly version: number;
  /** [Issue #3123] 行の TTL (epoch 秒)。 TTL 以前に書かれた行では undefined。 */
  readonly expiresAt?: number;
  /**
   * [Issue #3150] この行に刻まれた state の schema 版。 envelope の無い行 (= この Issue より前に
   * 書かれた行) では undefined -- `coordination-state-schema.ts` はこれを版 1 として扱う。
   */
  readonly stateSchemaVersion?: number;
}

/**
 * [Issue #3150] platform が `state` に被せる封筒。 repository はこれを opaque な
 * `state: unknown` としてそのまま保存・返却するだけで、 DDB item / SQL row のどちらも
 * 形を変えない (= DDL 変更ゼロ)。
 *
 * [Issue #3150] Codex review: マーカー 1 つでの判定は不十分。 plugin の State は `unknown` なので
 * どんな形もあり得る -- たまたま同じ key を持つ旧 state を封筒と誤認すると、 `state.state` が
 * undefined になって plugin に渡り、 500 か次の write での破壊になる。 **封筒の形が完全に
 * 揃ったときだけ**封筒と見なす (マーカー + 正の整数 version + `state` key の存在)。
 */
interface CoordinationStateEnvelope {
  readonly __tenkacloudCoordinationEnvelope: 1;
  readonly stateSchemaVersion: number;
  readonly state: unknown;
}

const COORDINATION_ENVELOPE_MARKER = 1;

function isCoordinationStateEnvelope(raw: unknown): raw is CoordinationStateEnvelope {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  if (r.__tenkacloudCoordinationEnvelope !== COORDINATION_ENVELOPE_MARKER) return false;
  if (
    typeof r.stateSchemaVersion !== "number" ||
    !Number.isInteger(r.stateSchemaVersion) ||
    r.stateSchemaVersion <= 0
  ) {
    return false;
  }
  return Object.hasOwn(r, "state");
}

/** store が必要とする DDB client の最小 shape (= test で容易に mock)。 */
export interface CoordinationStoreDeps {
  /** [#2527 Slice 4] Injected control-data runtime (from the Lambda entrypoint's instance). */
  readonly runtime: ControlDataRuntime;
  readonly ddb: Pick<DynamoDBDocumentClient, "send">;
  readonly tableName: string;
}

/**
 * 現在の coordination state を読む。 row が無ければ undefined (= 未初期化)。
 *
 * [Issue #3150] repository が返す `state` が envelope なら剥がして
 * `stateSchemaVersion` を取り出す。 envelope で無ければ (= この Issue より前の行) そのまま
 * `state` として返し、 `stateSchemaVersion` は undefined のままにする -- 1 として扱うかどうかは
 * `coordination-state-schema.ts` の仕事で、 ここでは決めない。
 */
export async function readCoordinationState(
  deps: CoordinationStoreDeps,
  scope: CoordinationStateScope,
): Promise<CoordinationStateRow | undefined> {
  const repository: DeploymentsCoordinationPort = await resolveDeploymentsRepository(deps);
  const record = await repository.readCoordinationState(scope);
  if (!record) return undefined;
  if (isCoordinationStateEnvelope(record.state)) {
    return {
      state: record.state.state,
      version: record.version,
      expiresAt: record.expiresAt,
      stateSchemaVersion: record.state.stateSchemaVersion,
    };
  }
  return { state: record.state, version: record.version, expiresAt: record.expiresAt };
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
 *
 * [Issue #3150] `stateSchemaVersion` (省略時 1) を caller が渡す -- 呼ぶ直前に確定している
 * plugin の版 (`pluginStateSchemaVersion(plugin)`)。
 *
 * Codex review (P1, rollback 互換): **版 2 以上のときだけ封筒を被せ、 版 1 は生の state を
 * そのまま書く**。 封筒は旧 dispatcher が知らない形なので、 全行を封筒にすると「この版を deploy →
 * 行に触る → 1 つ前の版に rollback」で旧 reader が封筒を state として plugin に渡してしまう
 * (旧 dispatcher は state を opaque に通すだけなので、 生の state なら版に関係なく素通りする)。
 * 版を宣言しない / 1 と宣言する plugin -- 今日ある全 plugin -- の行は #3150 以前と byte 単位で
 * 同一になり、 dispatcher の rollback は安全なまま。 封筒が現れるのは問題側の著者が
 * `stateSchemaVersion: 2` を宣言して初めてで、 それはこの dispatcher を要求する変更そのもの。
 * 読み側は封筒の有無を見るだけなので (`readCoordinationState`)、 両方の行が混在しても整合する。
 */
export async function writeCoordinationState(
  deps: CoordinationStoreDeps,
  scope: CoordinationStateScope,
  state: unknown,
  expectedVersion: number,
  nowIso: string,
  stateSchemaVersion = 1,
): Promise<WriteCoordinationOutcome> {
  const repository: DeploymentsCoordinationPort = await resolveDeploymentsRepository(deps);
  const payload: unknown =
    stateSchemaVersion >= 2
      ? ({
          __tenkacloudCoordinationEnvelope: COORDINATION_ENVELOPE_MARKER,
          stateSchemaVersion,
          state,
        } satisfies CoordinationStateEnvelope)
      : state;
  const outcome = await repository.writeCoordinationState(
    scope,
    payload,
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
