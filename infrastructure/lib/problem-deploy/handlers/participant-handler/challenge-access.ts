import type { ParticipantProgressionView, ParticipantTeamView } from "@tenkacloud/portal-contracts";
import type { ProblemWriteup } from "../../../utils/writeup-metadata.js";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { DELETED_LIKE_STATUSES } from "../shared/constants.js";
import {
  CHALLENGE_PREREQUISITE_GATE_FLAG,
  computeLockedProblemIds,
  isGateCompleted,
  type ProgressionGateConfig,
  resolveTeamGatePolicy,
  selectGateCompletionRow,
} from "../shared/progression-gate.js";
import { isTenantFeatureEnabled } from "../shared/tenant-feature-flags.js";
import { type EventGate, evaluateGate, type GateBlock, getEventGate } from "./event-gate.js";
import {
  type ParticipantSharedResources,
  queryTeamItems,
  resolveFeatureFlagsRepository,
} from "./shared.js";

/**
 * Issue #2283: challenge access 判定の単一箇所 (= Progression Gate enforcement)。
 *
 * frontend の見た目だけで制御せず、 locked challenge への競技操作を server-side で拒否する。
 * URL 直打ち / API 直呼びでも bypass できない。 guard を通る participant 経路:
 *   - flag 提出 (submit-flag) / hint 開封 (reveal-hint) — `getCompetitionAccessBlock`
 *   - endpoint 登録・更新・解除 + 一覧 (problem-endpoints) — `getPrerequisiteBlockByEventId`
 *   - AWS Console / CLI credentials / composite bridge / deploy-logs (= jobId 指定の
 *     read/access 経路。 locked 問題の接続情報・stack 情報を先読みさせない) —
 *     `getJobPrerequisiteBlock`
 *   - `/portal/me` 系 view (lookup / PATCH me) — `decorateTeamView` が locked 問題の
 *     stackOutputs を空にして返す
 *
 * 判定順 (すべて read 時導出、 永続 lock 状態なし):
 *   1. Event に Gate 設定が無い → 許可 (従来挙動)
 *   2. 対象 problem が unlock target でない (Gate challenge 自身を含む) → 許可
 *   3. team policy が `off` / Gate 完了済 → 許可 (`computeLockedProblemIds` に集約)
 *   4. per-tenant flag `challengePrerequisiteGate` が OFF (既定) → 許可
 *      (flag read は DDB GET なので、 上の無料判定で落ちない場合だけ読む + 30s cache)
 *   5. それ以外 → `challenge_prerequisite_not_met` block
 *
 * 管理者 / 運営者の経路 (deploy-handler / event-handler, Cognito JWT) は本 guard を
 * 通らないので、 既存運用は lock の影響を受けない。
 */

export interface PrerequisiteBlock {
  readonly kind: "challenge_prerequisite_not_met";
  /** 未完了の Gate challenge (= 先に完了すべき問題)。 UI 文言 + 機械判定用。 */
  readonly gateProblemId: string;
}

/**
 * tenant flag の in-memory TTL cache (Lambda instance 単位)。
 *
 * `/portal/me` は 30s polling されるため、 Gate 設定のある event では flag read が
 * poll ごとに発生し 1-RCU の Events table を圧迫する (+ throttle 時に enforcement が
 * 揺れる)。 30s cache で「tenant あたり 30s に 1 read」まで抑える。 flag OFF 切替の
 * 反映も最大 30s 遅延に収まり、 「Flag OFF で速やかに解除」 の要件と両立する。
 */
const TENANT_FLAG_CACHE_TTL_MS = 30_000;
const tenantFlagCache = new Map<
  string,
  { readonly value: Promise<boolean>; readonly expiresAtMs: number }
>();

/** test 用: module-level cache を破棄する (本番 code からは呼ばない)。 */
export function clearTenantFlagCacheForTest(): void {
  tenantFlagCache.clear();
}

function isGateFlagEnabled(shared: ParticipantSharedResources, tenantId: string): Promise<boolean> {
  const nowMs = Date.now();
  const cached = tenantFlagCache.get(tenantId);
  if (cached && cached.expiresAtMs > nowMs) return cached.value;
  const value = isTenantFeatureEnabled(
    resolveFeatureFlagsRepository(shared),
    tenantId,
    CHALLENGE_PREREQUISITE_GATE_FLAG,
  );
  tenantFlagCache.set(tenantId, { value, expiresAtMs: nowMs + TENANT_FLAG_CACHE_TTL_MS });
  return value;
}

/** DELETING / DELETED 系の残骸行を除いた live 行のみを対象にする (lookup.ts の防御と同じ)。 */
function isLiveItem(item: Partial<DeploymentItem>): boolean {
  const status = (item.status ?? "PENDING") as DeploymentStatus;
  return !DELETED_LIKE_STATUSES.has(status);
}

function findIdentitySample(
  items: readonly Partial<DeploymentItem>[],
): { readonly tenantId?: string; readonly teamId?: string } | undefined {
  const found = items.find(
    (i) => isLiveItem(i) && typeof i.tenantId === "string" && i.tenantId.length > 0,
  );
  if (!found) return undefined;
  return {
    tenantId: found.tenantId,
    teamId: typeof found.teamId === "string" ? found.teamId : undefined,
  };
}

/** team の locked 問題集合 (Gate 設定なしは空)。 view / guard の両方がここを通る。 */
function lockedSetFor(
  config: ProgressionGateConfig,
  items: readonly Partial<DeploymentItem>[],
  teamId: string | undefined,
): ReadonlySet<string> {
  const gateCompleted = isGateCompleted(selectGateCompletionRow(items, config.gateProblemId));
  return computeLockedProblemIds(config, teamId, gateCompleted);
}

/**
 * team の deployment 行集合 + 取得済み EventGate から、 対象 problemId への競技操作を
 * block すべきか判定する。 caller (submit-flag / reveal-hint) が既に event 行を読んで
 * いる場合は同じ `gate` を渡して 2 重 GET を避ける。
 */
export async function getPrerequisiteBlock(
  shared: ParticipantSharedResources,
  items: readonly Partial<DeploymentItem>[],
  targetProblemId: string,
  gate: EventGate | undefined,
): Promise<PrerequisiteBlock | undefined> {
  const config = gate?.progressionGate;
  if (!config) return undefined;

  const sample = findIdentitySample(items);
  if (!lockedSetFor(config, items, sample?.teamId).has(targetProblemId)) return undefined;

  // tenantId が引けない旧行 (Phase 1 以前) は flag 判定不能 → 既定 OFF に倒して許可。
  // (旧 event に Gate 設定が存在することは無いので実質 unreachable の防御。)
  if (!sample?.tenantId) return undefined;
  if (!(await isGateFlagEnabled(shared, sample.tenantId))) return undefined;

  return { kind: "challenge_prerequisite_not_met", gateProblemId: config.gateProblemId };
}

/**
 * event 行未取得の caller (endpoints handler 等) 向け: eventId から gate を読んで判定する。
 * eventId 不在 (= 旧 deployment) は Gate 概念が無いので許可。
 */
export async function getPrerequisiteBlockByEventId(
  shared: ParticipantSharedResources,
  items: readonly Partial<DeploymentItem>[],
  targetProblemId: string,
  eventId: string | undefined,
): Promise<PrerequisiteBlock | undefined> {
  if (typeof eventId !== "string" || eventId.length === 0) return undefined;
  // tenantId は team の deployment 行 (= 自 tenant) から導出して seam の tenant scope に渡す。
  const gate = await getEventGate(shared, findIdentitySample(items)?.tenantId, eventId);
  return getPrerequisiteBlock(shared, items, targetProblemId, gate);
}

/**
 * submit-flag / reveal-hint 共通の競技 gate: event scoring gate (開始前 / 終了後 / lock 中)
 * → Progression Gate の順で判定する。 両経路がこの 1 関数を通ることで、 gate 条件の追加が
 * 片側だけに入って挙動が割れる drift を防ぐ。 eventId 不在 (旧 deployment) は従来どおり素通し。
 */
export async function getCompetitionAccessBlock(
  shared: ParticipantSharedResources,
  items: readonly Partial<DeploymentItem>[],
  item: Partial<DeploymentItem> & { problemId: string },
): Promise<GateBlock | PrerequisiteBlock | undefined> {
  if (typeof item.eventId !== "string" || item.eventId.length === 0) return undefined;
  // 対象 deployment 行の tenantId (= 自 tenant) を seam の tenant scope に渡す。
  const tenantId = item.tenantId ?? findIdentitySample(items)?.tenantId;
  const gate = await getEventGate(shared, tenantId, item.eventId);
  const blocked = evaluateGate(gate, Date.now());
  if (blocked) return blocked;
  return getPrerequisiteBlock(shared, items, item.problemId, gate);
}

/**
 * jobId 指定の access 経路 (AWS Console signin / CLI credentials / composite bridge の
 * parent / deploy-logs) 向け guard。 jobId から team 内の deployment を解決し、 その
 * problemId が locked なら block する (= locked 問題の stack / log / AWS access で
 * 先行着手させない)。 jobId が team のものでない場合は undefined を返し、 各 service の
 * 既存 not_found / unauthorized 判定に委ねる。
 */
export async function getJobPrerequisiteBlock(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
  jobId: string,
): Promise<PrerequisiteBlock | undefined> {
  const items = await queryTeamItems(shared, teamLoginKey);
  const target = items.find((i) => i.jobId === jobId);
  if (!target || typeof target.problemId !== "string") return undefined;
  return getPrerequisiteBlockByEventId(
    shared,
    items,
    target.problemId,
    typeof target.eventId === "string" ? target.eventId : undefined,
  );
}

/**
 * `/portal/me` の progression view (= portal-contracts の `ParticipantProgressionView`)。
 * Gate 設定なし / flag OFF は `undefined` (= wire 上も従来 shape のまま、 既存挙動を維持)。
 */
export async function buildProgressionView(
  shared: ParticipantSharedResources,
  items: readonly Partial<DeploymentItem>[],
  gate: EventGate | undefined,
): Promise<ParticipantProgressionView | undefined> {
  const config = gate?.progressionGate;
  if (!config) return undefined;
  const sample = findIdentitySample(items);
  if (!sample?.tenantId) return undefined;
  if (!(await isGateFlagEnabled(shared, sample.tenantId))) return undefined;

  const gateCompleted = isGateCompleted(selectGateCompletionRow(items, config.gateProblemId));
  const { policy, completionBonus } = resolveTeamGatePolicy(config, sample.teamId);
  const locked = computeLockedProblemIds(config, sample.teamId, gateCompleted);
  return {
    gateProblemId: config.gateProblemId,
    gateCompleted,
    policy,
    completionBonus,
    lockedProblemIds: [...locked],
  };
}

/**
 * team view に eventGate + progression を注入し、 locked 問題の stackOutputs を空にする。
 * `/portal/me` (lookup) と `PATCH /portal/me` (update) の両応答がここを通る —
 * 片方だけ素通しにすると locked 問題の接続情報が rename 応答から漏れる。
 */
export async function decorateTeamView(
  shared: ParticipantSharedResources,
  items: readonly Partial<DeploymentItem>[],
  view: ParticipantTeamView,
): Promise<ParticipantTeamView> {
  const eventId = view.team.eventId;
  if (!eventId) return { ...view, eventGate: { kind: "scoring_not_started" } };

  // tenantId は team の deployment 行 (= 自 tenant) から導出して seam の tenant scope に渡す。
  const gate = await getEventGate(shared, findIdentitySample(items)?.tenantId, eventId);
  const block = evaluateGate(gate, Date.now());
  // locked 問題は stackOutputs を空にして返す (= lock 中に接続情報を見て先行着手できない
  // 防御層。 unlock 後の再取得で埋まる)。
  const progression = await buildProgressionView(shared, items, gate);
  const accessFilteredProblems = progression
    ? view.problems.map((p) =>
        progression.lockedProblemIds.includes(p.problemId) ? { ...p, stackOutputs: {} } : p,
      )
    : view.problems;
  // Cloud competition policy: writeups are released only after the event gate reports ended
  // and only for problems this team solved. Before that, the field is absent from the wire
  // response (the text lives only in the backend Lambda bundle, never in browser assets).
  const problems = releaseSolvedWriteups(
    accessFilteredProblems,
    shared.problemsWriteups ?? {},
    block?.kind === "scoring_ended",
  );
  return {
    ...view,
    problems,
    eventGate: block ?? { kind: "ok" },
    ...(progression ? { progression } : {}),
  };
}

export function isProblemSolvedForWriteup(
  problem: ParticipantTeamView["problems"][number],
): boolean {
  if (problem.scoring?.kind === "flag") return problem.scoring.flagSubmitted === true;
  if (problem.scoring?.kind === "multi-flag") {
    const flags = problem.scoring.flags ?? [];
    return flags.length > 0 && flags.every((flag) => flag.solved);
  }
  return false;
}

function attachSolvedWriteup(
  problem: ParticipantTeamView["problems"][number],
  writeup: ProblemWriteup | undefined,
): ParticipantTeamView["problems"][number] {
  if (!writeup || !isProblemSolvedForWriteup(problem)) return problem;
  return {
    ...problem,
    writeup: writeup.ja,
    i18n: {
      ...problem.i18n,
      en: { ...problem.i18n?.en, writeup: writeup.en },
    },
  };
}

export function releaseSolvedWriteups(
  problems: ParticipantTeamView["problems"],
  writeups: Readonly<Record<string, ProblemWriteup>>,
  eventEnded: boolean,
): ParticipantTeamView["problems"] {
  if (!eventEnded) return problems;
  return problems.map((problem) => attachSolvedWriteup(problem, writeups[problem.problemId]));
}
