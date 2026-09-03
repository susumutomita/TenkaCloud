import { toErrorMessage } from "@tenkacloud/web-kit";
import { StatusCodes } from "http-status-codes";
import { useEffect, useState } from "react";
import { type ApiClient, ApiError } from "../../api/client";
import {
  deleteEventProgressionGate,
  type EventDetail,
  getTenantFeatureFlags,
  type ProgressionGateConfig,
  type ProgressionGatePolicy,
  putEventProgressionGate,
  putTenantFeatureFlags,
} from "../../api/events-client";
import {
  buildTeamOverrides,
  GATE_FLAG,
  initialDrafts,
  isDemoFlagsUnsupported,
  isValidBonusInput,
  mapGateSaveError,
  type OverrideDraft,
  validateDraft,
} from "./progression-gate-models";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export interface TenantGateFlagState {
  readonly flags: Readonly<Record<string, boolean>> | null;
  readonly flagsError: string | null;
  readonly toggleError: string | null;
  readonly toggleInFlight: boolean;
  /** registry default false: tenant 行に true が無い限り無効 (= backend 判定と同一)。 */
  readonly enabled: boolean;
  readonly toggleFlag: (next: boolean) => Promise<void>;
}

/**
 * [#2527 Slice 6] Gate tab の feature-flag use case: `GET /feature-flags` の読込みと
 * Toggle (`PUT /admin/feature-flags`) を持つ。 有効判定は **tenant DDB row のみ** —
 * `config.features` は使わない。 backend の enforcement (`tenant-feature-flags.ts`) が
 * 同じ行だけを見るため、 判定源を一致させないと「UI は編集可なのに保存が 409」の
 * ちぐはぐが起きる (Issue #2283)。
 */
export function useTenantGateFlag(apiClient: ApiClient | null, t: Translate): TenantGateFlagState {
  const [flags, setFlags] = useState<Readonly<Record<string, boolean>> | null>(null);
  const [flagsError, setFlagsError] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [toggleInFlight, setToggleInFlight] = useState(false);

  useEffect(() => {
    if (!apiClient) return;
    let cancelled = false;
    (async () => {
      try {
        const fetched = await getTenantFeatureFlags(apiClient);
        if (!cancelled) setFlags(fetched);
      } catch (err) {
        if (cancelled) return;
        // #2283: demo NOT_IMPLEMENTED は「flag 行なし = 機能 OFF」扱い (isDemoFlagsUnsupported)。
        if (isDemoFlagsUnsupported(err)) {
          setFlags({});
        } else {
          setFlagsError(toErrorMessage(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiClient]);

  const toggleFlag = async (next: boolean) => {
    // Toggle の disabled が同条件 (!apiClient || toggleInFlight) を mirror するため guard は不到達 (防御的)。
    /* v8 ignore next */
    if (!apiClient || toggleInFlight) return;
    setToggleInFlight(true);
    setToggleError(null);
    try {
      // #2283: PUT /admin/feature-flags は full-replace。 mount 時 snapshot (state の flags) に
      // merge すると、 他 admin / 他 tab がその後に変えた flag を黙って巻き戻すため、
      // 直前に最新 flags を再取得してそちらへ merge する。
      const current = await getTenantFeatureFlags(apiClient);
      const updated = await putTenantFeatureFlags(apiClient, {
        ...current,
        [GATE_FLAG]: next,
      });
      setFlags(updated);
    } catch (err) {
      setToggleError(
        err instanceof ApiError && err.status === StatusCodes.FORBIDDEN
          ? t("gate.error_toggle_forbidden")
          : toErrorMessage(err),
      );
    } finally {
      setToggleInFlight(false);
    }
  };

  return {
    flags,
    flagsError,
    toggleError,
    toggleInFlight,
    // registry default false: tenant 行に true が無い限り無効 (= backend 判定と同一)。
    enabled: flags?.[GATE_FLAG] === true,
    toggleFlag,
  };
}

export interface GateEditorState {
  readonly gateProblemId: string | null;
  readonly unlockTargetIds: readonly string[];
  readonly defaultPolicy: ProgressionGatePolicy;
  /** [Issue #3174] Event 既定の完了ボーナス。 空欄 = 省略 (= 0)。 */
  readonly defaultBonus: string;
  readonly setDefaultBonus: (next: string) => void;
  readonly saveInFlight: boolean;
  readonly saveError: string | null;
  readonly savedFlash: boolean;
  readonly confirmRemove: boolean;
  readonly removeInFlight: boolean;
  /** 検証違反の i18n key (null = 保存可能)。 */
  readonly validationErrorKey: string | null;
  readonly draftFor: (teamId: string) => OverrideDraft;
  readonly setDraft: (teamId: string, next: OverrideDraft) => void;
  /** 自己参照 (gate ∈ targets) を UI 段階で防ぐ: gate 変更時に target から除外する。 */
  readonly changeGateProblem: (next: string) => void;
  readonly setUnlockTargetIds: (next: readonly string[]) => void;
  readonly setDefaultPolicy: (next: ProgressionGatePolicy) => void;
  readonly setConfirmRemove: (next: boolean) => void;
  readonly dismissSavedFlash: () => void;
  readonly save: () => Promise<void>;
  readonly remove: () => Promise<void>;
}

/**
 * [#2527 Slice 6] Gate 編集 form の use case: form state、draft 管理、client-side 検証、
 * full-replace PUT / confirm 付き DELETE を持つ。 表示は `GateEditor` (JSX) が担う。
 * 「Gate を有効化する」 概念 = 設定 (progressionGate) の有無: `detail.progressionGate` が
 * undefined なら空 form、 あれば prefill (Issue #2283)。
 */
export function useGateEditor(args: {
  readonly apiClient: ApiClient | null;
  readonly canMutateTenant: boolean;
  readonly detail: EventDetail;
  readonly onRefresh: () => void;
  readonly t: Translate;
}): GateEditorState {
  const { apiClient, canMutateTenant, detail, onRefresh, t } = args;
  const stored = detail.progressionGate;
  const [gateProblemId, setGateProblemId] = useState<string | null>(stored?.gateProblemId ?? null);
  const [unlockTargetIds, setUnlockTargetIds] = useState<readonly string[]>(
    stored?.unlockTargetIds ?? [],
  );
  const [defaultPolicy, setDefaultPolicy] = useState<ProgressionGatePolicy>(
    stored?.defaultPolicy ?? "required",
  );
  // [Issue #3174] The event-wide bonus. Blank means "omit", which the backend
  // reads as 0 — the same figure operators used to get with no field to see it in.
  const [defaultBonus, setDefaultBonus] = useState<string>(
    stored?.completionBonus !== undefined && stored.completionBonus > 0
      ? String(stored.completionBonus)
      : "",
  );
  const [drafts, setDrafts] = useState<Record<string, OverrideDraft>>(() => initialDrafts(stored));
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removeInFlight, setRemoveInFlight] = useState(false);

  const validationErrorKey =
    validateDraft({
      gateProblemId,
      unlockTargetIds,
      drafts,
      teamIds: detail.teams.map((team) => team.teamId),
    }) ?? (isValidBonusInput(defaultBonus) ? null : "gate.error_bonus_range");

  const draftFor = (teamId: string): OverrideDraft =>
    drafts[teamId] ?? { policy: "inherit", bonus: "" };
  const setDraft = (teamId: string, next: OverrideDraft) =>
    setDrafts((prev) => ({ ...prev, [teamId]: next }));

  const changeGateProblem = (next: string) => {
    setGateProblemId(next);
    // 自己参照 (gate ∈ targets) を UI 段階で防ぐ: gate 変更時に target から除外する。
    setUnlockTargetIds((prev) => prev.filter((id) => id !== next));
  };

  const save = async () => {
    // save button の disabled が同条件を mirror するため、 この guard は UI 経路では不到達 (防御的)。
    /* v8 ignore next */
    if (!apiClient || !canMutateTenant || saveInFlight || validationErrorKey) return;
    // validateDraft が gateProblemId 非 null を保証済み。
    /* v8 ignore next */
    if (!gateProblemId) return;
    const teamOverrides = buildTeamOverrides(detail.teams, draftFor);
    const bonus = defaultBonus.trim() === "" ? 0 : Number(defaultBonus.trim());
    const config: ProgressionGateConfig = {
      gateProblemId,
      unlockTargetIds: unlockTargetIds.filter((id) => id !== gateProblemId),
      defaultPolicy,
      // Omitted when zero, so the stored shape stays what it was for events that
      // never wanted a bonus.
      ...(bonus > 0 ? { completionBonus: bonus } : {}),
      ...(teamOverrides ? { teamOverrides } : {}),
    };
    setSaveInFlight(true);
    setSaveError(null);
    setSavedFlash(false);
    try {
      await putEventProgressionGate(apiClient, detail.eventId, config);
      setSavedFlash(true);
      onRefresh();
    } catch (err) {
      setSaveError(mapGateSaveError(err, t));
    } finally {
      setSaveInFlight(false);
    }
  };

  const remove = async () => {
    if (!apiClient || !canMutateTenant || removeInFlight) return;
    setRemoveInFlight(true);
    setSaveError(null);
    try {
      await deleteEventProgressionGate(apiClient, detail.eventId);
      setConfirmRemove(false);
      onRefresh();
    } catch (err) {
      setSaveError(toErrorMessage(err));
    } finally {
      setRemoveInFlight(false);
    }
  };

  return {
    gateProblemId,
    unlockTargetIds,
    defaultPolicy,
    defaultBonus,
    setDefaultBonus,
    saveInFlight,
    saveError,
    savedFlash,
    confirmRemove,
    removeInFlight,
    validationErrorKey,
    draftFor,
    setDraft,
    changeGateProblem,
    setUnlockTargetIds,
    setDefaultPolicy,
    setConfirmRemove,
    dismissSavedFlash: () => setSavedFlash(false),
    save,
    remove,
  };
}
