import type { DeploymentItem } from "../deploy-handler/types.js";
import { getPrerequisiteBlockByEventId } from "../participant-handler/challenge-access.js";
import { type ParticipantSharedResources, queryTeamItems } from "../participant-handler/shared.js";
import { isSsrfSafeUrl } from "../shared/ssrf-guard.js";
import { type ResolvedEndpoint, resolveEndpoints } from "./resolve.js";
import { deleteOverride, putOverride, queryOverrides } from "./store.js";

/**
 * Endpoint registry の business logic。
 *
 * 流れ:
 *   1. teamLoginKey で team の deployments を引く (= GSI2 Query)
 *   2. problemId に該当する deployment 行を絞る
 *   3. problem の `metadata.endpoints[]` を shared.problemsEndpoints から取得
 *   4. (slot 名, deployment.stackOutputs, ProblemEndpoints table の override 行) を merge
 *
 * Auth: caller が teamLoginKey で deployment 行を引けたら自チームの問題と確定する
 *      (= 別チームの problemId を指定しても unauthorized 扱い)。
 */

/**
 * deployment 行から teamId / tenantId を取り出す前段 guard。 cross-tenant PK collision を
 * 物理的に防ぐため両方の string 非空を要求。 narrow した後の caller は `?? ""` 不要。
 */
type AuthorizedDeployment = DeploymentItem & { teamId: string; tenantId: string };
function isAuthorizedDeployment(d: Partial<DeploymentItem> | undefined): d is AuthorizedDeployment {
  return (
    !!d &&
    typeof d.teamId === "string" &&
    d.teamId.length > 0 &&
    typeof d.tenantId === "string" &&
    d.tenantId.length > 0
  );
}

/**
 * [Issue #2442 / Phase C1] `shared.endpointsTableName` が空文字なのは 2 通りある:
 *   - pure SQL backend (`turso`) 選択時 — `ProblemDeployBackendStack` が本 table を
 *     synth しないため env も配線されない (= 正常。 store.ts の seam が SQL executor 直結で処理する)
 *   - 旧 deploy chain — table 自体が未配線 (= 真の misconfigured)
 * injected `shared.runtime.needsManualPrune()` は「pure SQL backend が選択されているか」を返す
 * 既存の public predicate (A5, #2440) を再利用して両者を区別する — 空文字を無条件に
 * misconfigured 扱いすると、 pure SQL backend で常に 500 になる regression を生む。
 */
function isEndpointsRegistryUnconfigured(
  shared: Pick<ParticipantSharedResources, "endpointsTableName" | "runtime">,
): boolean {
  return !shared.endpointsTableName && !shared.runtime.needsManualPrune();
}

export type ListEndpointsOutcome =
  | { kind: "ok"; endpoints: ResolvedEndpoint[]; teamId: string }
  | { kind: "unauthorized" }
  | { kind: "no_endpoints" }
  | { kind: "misconfigured" }
  /**
   * Issue #2283: Progression Gate 未完了。 一覧 (GET) も stackOutputs 由来の接続 URL を
   * 返すため、 locked challenge では拒否する (= /portal/me の stackOutputs 空化と同じ防御層。
   * ここを素通しにすると GET 直呼びで locked 問題の endpoint が読める)。
   */
  | { kind: "challenge_prerequisite_not_met"; gateProblemId: string };

/**
 * GET /portal/me/problems/:problemId/endpoints — 該当 team × problem の slot 一覧を返す。
 *
 * - team に該当 problem の deployment が無い → unauthorized
 * - metadata.endpoints[] が空 (= Challenge 系 flag-only 問題) → `no_endpoints`
 *   (= UI 側で endpoint 機能を hide させる、404 と区別したいので別 kind)
 * - registry table が未配線 (= env 空) → `misconfigured`
 */
export async function listProblemEndpoints(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
  problemId: string,
): Promise<ListEndpointsOutcome> {
  if (isEndpointsRegistryUnconfigured(shared)) return { kind: "misconfigured" };

  const items = await queryTeamItems(shared, teamLoginKey);
  if (items.length === 0) return { kind: "unauthorized" };

  const deployment = items.find((i) => i.problemId === problemId);
  if (!isAuthorizedDeployment(deployment)) return { kind: "unauthorized" };

  const slots = shared.problemsEndpoints[problemId] ?? [];
  if (slots.length === 0) return { kind: "no_endpoints" };

  // Issue #2283: locked challenge の endpoint URL (stackOutputs 由来) は一覧でも返さない。
  const prerequisite = await getPrerequisiteBlockByEventId(
    shared,
    items,
    problemId,
    deployment.eventId,
  );
  if (prerequisite) return prerequisite;

  const overrides = await queryOverrides(
    shared.runtime,
    shared.ddb,
    shared.endpointsTableName,
    deployment.tenantId,
    deployment.teamId,
    problemId,
  );

  return {
    kind: "ok",
    teamId: deployment.teamId,
    endpoints: resolveEndpoints({
      slots,
      stackOutputs: deployment.stackOutputs,
      overrides,
    }),
  };
}

export type PutOverrideOutcome =
  | { kind: "ok"; endpoints: ResolvedEndpoint[]; teamId: string }
  | { kind: "unauthorized" }
  | { kind: "unknown_slot" }
  | { kind: "slot_not_overridable" }
  | { kind: "invalid_url" }
  | { kind: "no_endpoints" }
  | { kind: "misconfigured" }
  /**
   * Issue #2283: Progression Gate 未完了。 locked challenge への endpoint 登録 / 更新 / 解除
   * (= 採点開始のトリガーになる競技操作) を server-side で拒否する。
   */
  | { kind: "challenge_prerequisite_not_met"; gateProblemId: string };

/**
 * 競技者向け URL validation。`https?://...` のみ許容、 private IP / VPC 内 endpoint は許容
 * (= Battle で参加者が自分の AWS account 内 endpoint を登録するため public/private は問わない)。
 * SSRF 対策として metadata service / loopback literal は拒否する。host blocklist + scheme check は
 * `shared/ssrf-guard.ts` の `isSsrfSafeUrl` に集約 (scoring engine の probe 側と共有)。
 */
function isValidOverrideUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return false;
  return isSsrfSafeUrl(trimmed);
}

/**
 * POST /portal/me/problems/:problemId/endpoints — 1 slot の override URL を upsert。
 *
 * - team に該当 problem が無い → unauthorized
 * - metadata 側で当該 slot が宣言されていない → unknown_slot
 * - 宣言済だが `overridable=false` → slot_not_overridable
 * - URL validation 失敗 → invalid_url
 */
export async function upsertProblemEndpointOverride(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
  problemId: string,
  slot: string,
  urlValue: unknown,
  nowIso: string,
): Promise<PutOverrideOutcome> {
  if (isEndpointsRegistryUnconfigured(shared)) return { kind: "misconfigured" };

  const items = await queryTeamItems(shared, teamLoginKey);
  if (items.length === 0) return { kind: "unauthorized" };
  const deployment = items.find((i) => i.problemId === problemId);
  if (!isAuthorizedDeployment(deployment)) return { kind: "unauthorized" };

  const slots = shared.problemsEndpoints[problemId] ?? [];
  if (slots.length === 0) return { kind: "no_endpoints" };

  const slotDef = slots.find((s) => s.slot === slot);
  if (!slotDef) return { kind: "unknown_slot" };
  if (!slotDef.overridable) return { kind: "slot_not_overridable" };
  if (!isValidOverrideUrl(urlValue)) return { kind: "invalid_url" };

  // Issue #2283: locked challenge への endpoint 登録は採点開始を意味するので Gate を通す。
  // 無料の入力検証を先に済ませ、 拒否確定の request で DDB read を発生させない。
  const prerequisite = await getPrerequisiteBlockByEventId(
    shared,
    items,
    problemId,
    deployment.eventId,
  );
  if (prerequisite) return prerequisite;

  const tenantId = deployment.tenantId;
  await putOverride(shared.runtime, shared.ddb, shared.endpointsTableName, {
    tenantId,
    teamId: deployment.teamId,
    problemId,
    slot,
    overrideUrl: urlValue.trim(),
    nowIso,
  });

  // 直後の GET と同等の view を返す (= UI から再 GET 不要)。
  const overrides = await queryOverrides(
    shared.runtime,
    shared.ddb,
    shared.endpointsTableName,
    tenantId,
    deployment.teamId,
    problemId,
  );
  return {
    kind: "ok",
    teamId: deployment.teamId,
    endpoints: resolveEndpoints({
      slots,
      stackOutputs: deployment.stackOutputs,
      overrides,
    }),
  };
}

export type DeleteOverrideOutcome =
  | { kind: "ok"; endpoints: ResolvedEndpoint[]; teamId: string }
  | { kind: "unauthorized" }
  | { kind: "unknown_slot" }
  | { kind: "no_endpoints" }
  | { kind: "misconfigured" }
  /** Issue #2283: locked challenge の override 解除も probing 対象を変える競技操作なので拒否。 */
  | { kind: "challenge_prerequisite_not_met"; gateProblemId: string };

/**
 * DELETE /portal/me/problems/:problemId/endpoints/:slot — override を解除 (= default に戻す)。
 */
export async function deleteProblemEndpointOverride(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
  problemId: string,
  slot: string,
): Promise<DeleteOverrideOutcome> {
  if (isEndpointsRegistryUnconfigured(shared)) return { kind: "misconfigured" };

  const items = await queryTeamItems(shared, teamLoginKey);
  if (items.length === 0) return { kind: "unauthorized" };
  const deployment = items.find((i) => i.problemId === problemId);
  if (!isAuthorizedDeployment(deployment)) return { kind: "unauthorized" };

  const slots = shared.problemsEndpoints[problemId] ?? [];
  if (slots.length === 0) return { kind: "no_endpoints" };
  if (!slots.some((s) => s.slot === slot)) return { kind: "unknown_slot" };

  // Issue #2283: 解除 (= default URL への切替) も probing 対象を変えるので Gate を通す。
  // 無料の入力検証を先に済ませ、 拒否確定の request で DDB read を発生させない。
  const prerequisite = await getPrerequisiteBlockByEventId(
    shared,
    items,
    problemId,
    deployment.eventId,
  );
  if (prerequisite) return prerequisite;

  const tenantId = deployment.tenantId;
  await deleteOverride(shared.runtime, shared.ddb, shared.endpointsTableName, {
    tenantId,
    teamId: deployment.teamId,
    problemId,
    slot,
  });
  const overrides = await queryOverrides(
    shared.runtime,
    shared.ddb,
    shared.endpointsTableName,
    tenantId,
    deployment.teamId,
    problemId,
  );
  return {
    kind: "ok",
    teamId: deployment.teamId,
    endpoints: resolveEndpoints({
      slots,
      stackOutputs: deployment.stackOutputs,
      overrides,
    }),
  };
}
