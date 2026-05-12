import type { DeploymentItem } from "../deploy-handler/types.js";
import { type ParticipantSharedResources, queryTeamItems } from "../participant-handler/shared.js";
import { type ResolvedEndpoint, resolveEndpoints } from "./resolve.js";
import { deleteOverride, putOverride, queryOverrides } from "./store.js";

/**
 * Endpoint registry (ADR-012 Phase 3.A) の business logic。
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

export type ListEndpointsOutcome =
  | { kind: "ok"; endpoints: ResolvedEndpoint[]; teamId: string }
  | { kind: "unauthorized" }
  | { kind: "no_endpoints" }
  | { kind: "misconfigured" };

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
  if (!shared.endpointsTableName) return { kind: "misconfigured" };

  const items = await queryTeamItems(shared, teamLoginKey);
  if (items.length === 0) return { kind: "unauthorized" };

  const deployment = items.find((i) => i.problemId === problemId);
  if (!deployment || typeof deployment.teamId !== "string" || deployment.teamId.length === 0) {
    return { kind: "unauthorized" };
  }

  const slots = shared.problemsEndpoints[problemId] ?? [];
  if (slots.length === 0) return { kind: "no_endpoints" };

  const overrides = await queryOverrides(
    shared.ddb,
    shared.endpointsTableName,
    deployment.tenantId ?? "",
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
  | { kind: "misconfigured" };

/**
 * 競技者向け URL validation。`https?://...` のみ許容、private IP / localhost も許容する
 * (= Battle で参加者が自分の AWS account 内 endpoint を登録するため public/private は問わない)。
 *
 * Phase 3.A の主な目的は「文字列が URL 形式か」「scheme が http(s) か」「長さが妥当か」の 3 点。
 */
function isValidOverrideUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return false;
  try {
    const u = new URL(trimmed);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
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
  if (!shared.endpointsTableName) return { kind: "misconfigured" };

  const items = await queryTeamItems(shared, teamLoginKey);
  if (items.length === 0) return { kind: "unauthorized" };
  const deployment = items.find((i) => i.problemId === problemId);
  if (!deployment || typeof deployment.teamId !== "string" || deployment.teamId.length === 0) {
    return { kind: "unauthorized" };
  }

  const slots = shared.problemsEndpoints[problemId] ?? [];
  if (slots.length === 0) return { kind: "no_endpoints" };

  const slotDef = slots.find((s) => s.slot === slot);
  if (!slotDef) return { kind: "unknown_slot" };
  if (!slotDef.overridable) return { kind: "slot_not_overridable" };
  if (!isValidOverrideUrl(urlValue)) return { kind: "invalid_url" };

  const tenantId = deployment.tenantId ?? "";
  await putOverride(shared.ddb, shared.endpointsTableName, {
    tenantId,
    teamId: deployment.teamId,
    problemId,
    slot,
    overrideUrl: urlValue.trim(),
    nowIso,
  });

  // 直後の GET と同等の view を返す (= UI から再 GET 不要)。
  const overrides = await queryOverrides(
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
  | { kind: "misconfigured" };

/**
 * DELETE /portal/me/problems/:problemId/endpoints/:slot — override を解除 (= default に戻す)。
 */
export async function deleteProblemEndpointOverride(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
  problemId: string,
  slot: string,
): Promise<DeleteOverrideOutcome> {
  if (!shared.endpointsTableName) return { kind: "misconfigured" };

  const items = await queryTeamItems(shared, teamLoginKey);
  if (items.length === 0) return { kind: "unauthorized" };
  const deployment = items.find((i) => i.problemId === problemId);
  if (!deployment || typeof deployment.teamId !== "string" || deployment.teamId.length === 0) {
    return { kind: "unauthorized" };
  }

  const slots = shared.problemsEndpoints[problemId] ?? [];
  if (slots.length === 0) return { kind: "no_endpoints" };
  if (!slots.some((s) => s.slot === slot)) return { kind: "unknown_slot" };

  const tenantId = deployment.tenantId ?? "";
  await deleteOverride(shared.ddb, shared.endpointsTableName, {
    tenantId,
    teamId: deployment.teamId,
    problemId,
    slot,
  });
  const overrides = await queryOverrides(
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

// Test 用に DeploymentItem を引きたいケースのために re-export。
export type { DeploymentItem };
