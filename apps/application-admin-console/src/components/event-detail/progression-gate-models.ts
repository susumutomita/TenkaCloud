import { toErrorMessage } from "@tenkacloud/web-kit";
import { StatusCodes } from "http-status-codes";
import { ApiError } from "../../api/client";
import type {
  EventDetail,
  ProgressionGateConfig,
  ProgressionGatePolicy,
  ProgressionGateTeamOverride,
} from "../../api/events-client";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

/**
 * Issue #2283: per-tenant runtime flag key。backend
 * (infrastructure/lib/problem-deploy/handlers/shared/progression-gate.ts の
 * `CHALLENGE_PREREQUISITE_GATE_FLAG`) と同じ文字列。 apps は infrastructure を import
 * できないためここに鏡像を持つ。
 */
export const GATE_FLAG = "challengePrerequisiteGate";

/** 完了 bonus の上限 (backend `MAX_COMPLETION_BONUS` の鏡像)。 */
export const MAX_COMPLETION_BONUS = 100_000;

/** backend `ProgressionGateInvalidReason` の鏡像 (= 400 invalid_progression_gate の reason 値)。 */
export const GATE_INVALID_REASONS = [
  "gate_problem_not_in_event",
  "unlock_target_not_in_event",
  "unknown_override_team",
  "event_archived",
] as const;

/** team 行の編集値。 "inherit" = override 無し (= Event default に従う)。 */
export type OverridePolicyChoice = "inherit" | ProgressionGatePolicy;
export interface OverrideDraft {
  readonly policy: OverridePolicyChoice;
  readonly bonus: string;
}

export function initialDrafts(
  stored: ProgressionGateConfig | undefined,
): Record<string, OverrideDraft> {
  const out: Record<string, OverrideDraft> = {};
  for (const [teamId, override] of Object.entries(stored?.teamOverrides ?? {})) {
    out[teamId] = {
      policy: override.policy ?? "inherit",
      // completionBonus 0 / 未設定は空欄表示 (= 保存時も省略する)。
      bonus:
        override.completionBonus !== undefined && override.completionBonus > 0
          ? String(override.completionBonus)
          : "",
    };
  }
  return out;
}

/** bonus 入力 1 個の検証。空欄は「省略」(= 0 扱い) で valid。 */
export function isValidBonusInput(bonus: string): boolean {
  const trimmed = bonus.trim();
  if (trimmed === "") return true;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 0 && n <= MAX_COMPLETION_BONUS;
}

/**
 * client-side 検証 (backend schema の鏡像)。 違反があれば i18n key を返す。
 * gate ∉ targets は UI 構造 (option から gate を除外 + gate 変更時に prune) で担保するが、
 * 保存直前にもここで検査して防御する。
 */
export function validateDraft(args: {
  readonly gateProblemId: string | null;
  readonly unlockTargetIds: readonly string[];
  readonly drafts: Readonly<Record<string, OverrideDraft>>;
  readonly teamIds: readonly string[];
}): string | null {
  const { gateProblemId, unlockTargetIds, drafts, teamIds } = args;
  if (!gateProblemId) return "gate.error_gate_required";
  const targets = unlockTargetIds.filter((id) => id !== gateProblemId);
  if (targets.length === 0) return "gate.error_no_targets";
  // #2283: 保存 (buildTeamOverrides) と表示は detail.teams のみを走査するため、 検証も
  // 実在 team の draft に限定する。 でないと除去済み team の残骸 draft が「見えないエラー」で
  // Save を永続 block する。
  for (const teamId of teamIds) {
    // [Issue #3174] The bonus is checked whatever the policy is. It used to be
    // skipped for `inherit` rows, which was consistent with dropping them on
    // save — and both together are why "keep the default policy, give everyone
    // a bonus" could not be expressed.
    const draft = drafts[teamId];
    if (draft && !isValidBonusInput(draft.bonus)) {
      return "gate.error_bonus_range";
    }
  }
  return null;
}

/**
 * 保存する teamOverrides を draft から組み立てる。 override は「実在 team のみ」
 * (= detail.teams を走査): 過去 team の残骸 draft を送らない。 全 team が inherit なら
 * undefined (= teamOverrides キー自体を省略)。
 */
export function buildTeamOverrides(
  teams: EventDetail["teams"],
  draftFor: (teamId: string) => OverrideDraft,
): Readonly<Record<string, ProgressionGateTeamOverride>> | undefined {
  const out: Record<string, ProgressionGateTeamOverride> = {};
  for (const team of teams) {
    const draft = draftFor(team.teamId);
    const trimmed = draft.bonus.trim();
    const bonus = trimmed === "" ? 0 : Number(trimmed);
    // [Issue #3174] A row is sent when it says ANYTHING — a policy of its own, a
    // bonus of its own, or both. Skipping every `inherit` row is what made the
    // bonus a hostage of the policy override: the only way to give a team a
    // handicap was to stop it following the event's policy.
    const hasPolicy = draft.policy !== "inherit";
    if (!hasPolicy && bonus <= 0) continue;
    out[team.teamId] = {
      ...(hasPolicy ? { policy: draft.policy } : {}),
      ...(bonus > 0 ? { completionBonus: bonus } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * #2283: GET /feature-flags 失敗のうち 「demo mode (Issue #1954) の fixture client が
 * feature-flags API 未実装 (NOT_IMPLEMENTED) を投げた」 場合だけ true。 これは
 * 「flag 行なし = 機能 OFF」 と同義に扱い、 常時表示の Gate tab を error alert で
 * 赤くしない (= read-only の無効 Alert 表示に落とす)。
 */
export function isDemoFlagsUnsupported(err: unknown): boolean {
  return err instanceof ApiError && err.status === StatusCodes.NOT_IMPLEMENTED;
}

/**
 * 保存エラーを operator 向け文言に変換する。 backend contract (Issue #2283):
 *   - 409 `{ error: "feature_disabled" }` — tenant flag が途中で OFF になった
 *   - 400 `{ error: "invalid_progression_gate", reason }` — cross-entity 検証失敗
 * ApiError.message は response body を含む (`API 400: {...}`) ので reason を regex で拾う
 * (useEventOperations の formatEndEventError と同じ手法)。
 */
export function mapGateSaveError(err: unknown, t: Translate): string {
  if (err instanceof ApiError) {
    if (err.status === StatusCodes.CONFLICT && err.message.includes("feature_disabled")) {
      return t("gate.error_feature_disabled");
    }
    if (err.status === StatusCodes.BAD_REQUEST) {
      const reason = err.message.match(/"reason"\s*:\s*"([a-z_]+)"/)?.[1];
      if (reason && (GATE_INVALID_REASONS as readonly string[]).includes(reason)) {
        return t(`gate.error_reason_${reason}`);
      }
    }
  }
  return toErrorMessage(err);
}
