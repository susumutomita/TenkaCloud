import { toErrorMessage } from "@tenkacloud/web-kit";
import { StatusCodes } from "http-status-codes";
import { useState } from "react";
import { type ApiClient, ApiError } from "../api/client";
import {
  archiveEvent,
  type BulkDeployBody,
  type BulkResult,
  bulkDeployEvent,
  bulkTeardownEvent,
  type EventDetail,
  endEvent,
  lockEventScoring,
  setEventSchedule,
  unlockEventScoring,
} from "../api/events-client";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export interface EndsAtValidation {
  readonly canSubmit: boolean;
  /** i18n key (= `event_detail.error_*`) returned for the caller to resolve via useT(). */
  readonly errorKey?: string;
  readonly value?: Date;
}

export function validateEndsAtInput(
  date: string,
  time: string,
  startsAt: string | undefined,
  nowMs: number,
): EndsAtValidation {
  if (!date || !time) return { canSubmit: false };
  const value = new Date(`${date}T${time}:00`);
  if (Number.isNaN(value.getTime())) {
    return { canSubmit: false, errorKey: "event_detail.error_endsat_format" };
  }
  if (value.getTime() < nowMs - 60_000) {
    return { canSubmit: false, errorKey: "event_detail.error_endsat_past" };
  }
  if (startsAt) {
    const startsAtMs = new Date(startsAt).getTime();
    if (Number.isFinite(startsAtMs) && value.getTime() <= startsAtMs) {
      return { canSubmit: false, errorKey: "event_detail.error_endsat_before_start" };
    }
  }
  return { canSubmit: true, value };
}

/**
 * [ADR-047] 自動撤去予定時刻の入力検証。 過去不可 (now-60s 以前) かつ endsAt 以降 (= 採点 gate を
 * 閉じてから撤去する always-ends 不変条件)。 endsAt 未設定なら下限制約なし。
 */
export function validateTeardownAtInput(
  date: string,
  time: string,
  endsAt: string | undefined,
  nowMs: number,
): EndsAtValidation {
  if (!date || !time) return { canSubmit: false };
  const value = new Date(`${date}T${time}:00`);
  if (Number.isNaN(value.getTime())) {
    return { canSubmit: false, errorKey: "event_detail.error_teardown_format" };
  }
  if (value.getTime() < nowMs - 60_000) {
    return { canSubmit: false, errorKey: "event_detail.error_teardown_past" };
  }
  if (endsAt) {
    const endsAtMs = new Date(endsAt).getTime();
    if (Number.isFinite(endsAtMs) && value.getTime() < endsAtMs) {
      return { canSubmit: false, errorKey: "event_detail.error_teardown_before_ends" };
    }
  }
  return { canSubmit: true, value };
}

/**
 * [ADR-047 follow-up] 自動デプロイ予定時刻の入力検証 (validateTeardownAtInput の鏡像)。 過去不可
 * (now-60s 以前) かつ endsAt 以前 (= deploy → 採点 → 終了 の時系列を保つ)。 endsAt 未設定なら
 * 上限制約なし。
 */
export function validateDeployAtInput(
  date: string,
  time: string,
  endsAt: string | undefined,
  nowMs: number,
): EndsAtValidation {
  if (!date || !time) return { canSubmit: false };
  const value = new Date(`${date}T${time}:00`);
  if (Number.isNaN(value.getTime())) {
    return { canSubmit: false, errorKey: "event_detail.error_deploy_format" };
  }
  if (value.getTime() < nowMs - 60_000) {
    return { canSubmit: false, errorKey: "event_detail.error_deploy_past" };
  }
  if (endsAt) {
    const endsAtMs = new Date(endsAt).getTime();
    if (Number.isFinite(endsAtMs) && value.getTime() > endsAtMs) {
      return { canSubmit: false, errorKey: "event_detail.error_deploy_after_ends" };
    }
  }
  return { canSubmit: true, value };
}

function resolveScheduledStartInput(
  date: string,
  time: string,
  nowMs: number,
  t: Translate,
):
  | { readonly ok: true; readonly startsAt: string }
  | { readonly ok: false; readonly error: string } {
  if (!date || !time) return { ok: false, error: t("event_detail.error_date_time_required") };
  // DatePicker は YYYY-MM-DD、TimeInput は HH:mm。秒は :00 固定で組む (operator UX が分精度想定)。
  const local = new Date(`${date}T${time}:00`);
  if (Number.isNaN(local.getTime())) {
    return { ok: false, error: t("event_detail.error_date_time_format") };
  }
  if (local.getTime() < nowMs - 60_000) {
    return { ok: false, error: t("event_detail.error_startsat_past") };
  }
  return { ok: true, startsAt: local.toISOString() };
}

function formatEndEventError(err: unknown, t: Translate): string {
  if (err instanceof ApiError && err.status === StatusCodes.CONFLICT) {
    const match = err.message.match(/"currentStatus"\s*:\s*"([A-Z_]+)"/);
    const current = match?.[1];
    return current
      ? t("event_detail.error_end_status_with_current", { current })
      : t("event_detail.error_end_status");
  }
  return toErrorMessage(err);
}

export function useEventOperations(args: {
  readonly apiClient: ApiClient | null;
  readonly canMutateTenant: boolean;
  readonly detail: EventDetail | null;
  readonly eventId: string;
  readonly refresh: () => Promise<void>;
  readonly setError: (error: string | null) => void;
  readonly t: Translate;
}) {
  const { apiClient, canMutateTenant, detail, eventId, refresh, setError, t } = args;
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  // #555/#756: deploy 系操作は同じ POST /deploy 経路。in-flight 状態だけ分けて表示する。
  const [bulkInFlight, setBulkInFlight] = useState<
    "deploy" | "teardown" | "retry-failed" | "redeploy" | null
  >(null);
  const [confirmTeardown, setConfirmTeardown] = useState(false);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [scheduleDate, setScheduleDate] = useState("");
  const [scheduleTime, setScheduleTime] = useState("");
  const [scheduleInFlight, setScheduleInFlight] = useState<"now" | "scheduled" | null>(null);
  // #536: 終了予約 modal の state (= 開始 modal と独立)
  const [endsAtModalOpen, setEndsAtModalOpen] = useState(false);
  const [endsAtDate, setEndsAtDate] = useState("");
  const [endsAtTime, setEndsAtTime] = useState("");
  const [endsAtInFlight, setEndsAtInFlight] = useState(false);
  // [ADR-047] 自動撤去予定 modal の state (= endsAt modal と独立)
  const [teardownModalOpen, setTeardownModalOpen] = useState(false);
  const [teardownDate, setTeardownDate] = useState("");
  const [teardownTime, setTeardownTime] = useState("");
  const [teardownInFlight, setTeardownInFlight] = useState(false);
  // [ADR-047 follow-up] 自動デプロイ予定 modal の state (= teardown modal の鏡像、独立)
  const [deployScheduleModalOpen, setDeployScheduleModalOpen] = useState(false);
  const [deployDate, setDeployDate] = useState("");
  const [deployTime, setDeployTime] = useState("");
  const [deployScheduleInFlight, setDeployScheduleInFlight] = useState(false);
  const [endInFlight, setEndInFlight] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  // Issue #1038 P1 #9 follow-up: scoreboard freeze 分数の operator 編集 state
  const [freezeMinutesInput, setFreezeMinutesInput] = useState<string>("");
  const [freezeMinutesInFlight, setFreezeMinutesInFlight] = useState(false);
  // #708: TEARDOWN が ROLLBACK_COMPLETE な stack で stuck したときの operator rescue。
  const [confirmForceArchive, setConfirmForceArchive] = useState(false);
  const [forceArchiveInFlight, setForceArchiveInFlight] = useState(false);
  const [notifyModalOpen, setNotifyModalOpen] = useState(false);
  const [notifyJustSent, setNotifyJustSent] = useState(false);
  // #558: scoring lock/unlock の in-flight 状態。"lock" / "unlock" / null を持つ。
  const [scoringLockInFlight, setScoringLockInFlight] = useState<"lock" | "unlock" | null>(null);

  const handleBulkDeploy = async (body: BulkDeployBody = {}) => {
    if (!apiClient || !canMutateTenant || bulkInFlight) return;
    setBulkInFlight(
      body.retryFailedOnly ? "retry-failed" : body.forceRedeploy ? "redeploy" : "deploy",
    );
    setError(null);
    try {
      const res = await bulkDeployEvent(apiClient, eventId, body);
      setBulkResult(res);
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBulkInFlight(null);
    }
  };

  const handleBulkTeardown = async () => {
    if (!apiClient || !canMutateTenant || bulkInFlight) return;
    setBulkInFlight("teardown");
    setConfirmTeardown(false);
    setError(null);
    try {
      const res = await bulkTeardownEvent(apiClient, eventId);
      setBulkResult(res);
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBulkInFlight(null);
    }
  };

  const handleStartNow = async () => {
    if (!apiClient || !canMutateTenant || scheduleInFlight) return;
    setScheduleInFlight("now");
    setError(null);
    try {
      await setEventSchedule(apiClient, eventId, { startNow: true });
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setScheduleInFlight(null);
    }
  };

  const handleScheduledStart = async () => {
    if (!apiClient || !canMutateTenant || scheduleInFlight) return;
    const resolved = resolveScheduledStartInput(scheduleDate, scheduleTime, Date.now(), t);
    if (!resolved.ok) {
      setError(resolved.error);
      return;
    }
    setScheduleInFlight("scheduled");
    setError(null);
    try {
      await setEventSchedule(apiClient, eventId, { startsAt: resolved.startsAt });
      setScheduleModalOpen(false);
      setScheduleDate("");
      setScheduleTime("");
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setScheduleInFlight(null);
    }
  };

  const handleScheduleEnd = async () => {
    if (!apiClient || !canMutateTenant || endsAtInFlight) return;
    const validation = validateEndsAtInput(endsAtDate, endsAtTime, detail?.startsAt, Date.now());
    if (!validation.canSubmit || !validation.value) {
      setError(
        validation.errorKey ? t(validation.errorKey) : t("event_detail.error_endsat_required"),
      );
      return;
    }
    setEndsAtInFlight(true);
    setError(null);
    try {
      await setEventSchedule(apiClient, eventId, { endsAt: validation.value.toISOString() });
      setEndsAtModalOpen(false);
      setEndsAtDate("");
      setEndsAtTime("");
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setEndsAtInFlight(false);
    }
  };

  const handleEndNowSchedule = async () => {
    if (!apiClient || !canMutateTenant || endsAtInFlight) return;
    setEndsAtInFlight(true);
    setError(null);
    try {
      await setEventSchedule(apiClient, eventId, { endsAt: new Date(Date.now()).toISOString() });
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setEndsAtInFlight(false);
    }
  };

  const handleScheduleTeardown = async () => {
    if (!apiClient || !canMutateTenant || teardownInFlight) return;
    const validation = validateTeardownAtInput(
      teardownDate,
      teardownTime,
      detail?.endsAt,
      Date.now(),
    );
    if (!validation.canSubmit || !validation.value) {
      setError(
        validation.errorKey ? t(validation.errorKey) : t("event_detail.error_teardown_required"),
      );
      return;
    }
    setTeardownInFlight(true);
    setError(null);
    try {
      await setEventSchedule(apiClient, eventId, { teardownAt: validation.value.toISOString() });
      setTeardownModalOpen(false);
      setTeardownDate("");
      setTeardownTime("");
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setTeardownInFlight(false);
    }
  };

  const handleScheduleDeploy = async () => {
    if (!apiClient || !canMutateTenant || deployScheduleInFlight) return;
    const validation = validateDeployAtInput(deployDate, deployTime, detail?.endsAt, Date.now());
    if (!validation.canSubmit || !validation.value) {
      setError(
        validation.errorKey ? t(validation.errorKey) : t("event_detail.error_deploy_required"),
      );
      return;
    }
    setDeployScheduleInFlight(true);
    setError(null);
    try {
      await setEventSchedule(apiClient, eventId, { deployAt: validation.value.toISOString() });
      setDeployScheduleModalOpen(false);
      setDeployDate("");
      setDeployTime("");
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setDeployScheduleInFlight(false);
    }
  };

  const handleSaveFreezeMinutes = async () => {
    if (!apiClient || !canMutateTenant || freezeMinutesInFlight) return;
    const trimmed = freezeMinutesInput.trim();
    if (trimmed === "") {
      setError(t("event_detail.error_freeze_required"));
      return;
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 0 || n > 180) {
      setError(t("event_detail.error_freeze_range"));
      return;
    }
    setFreezeMinutesInFlight(true);
    setError(null);
    try {
      await setEventSchedule(apiClient, eventId, { scoreboardFreezeMinutes: n });
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setFreezeMinutesInFlight(false);
    }
  };

  const handleLockScoring = async () => {
    if (!apiClient || !canMutateTenant || scoringLockInFlight) return;
    setScoringLockInFlight("lock");
    setError(null);
    try {
      await lockEventScoring(apiClient, eventId);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === StatusCodes.CONFLICT) {
        setError(t("event_detail.error_lock_status"));
      } else {
        setError(toErrorMessage(err));
      }
    } finally {
      setScoringLockInFlight(null);
    }
  };

  const handleUnlockScoring = async () => {
    if (!apiClient || !canMutateTenant || scoringLockInFlight) return;
    setScoringLockInFlight("unlock");
    setError(null);
    try {
      await unlockEventScoring(apiClient, eventId);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === StatusCodes.CONFLICT) {
        setError(t("event_detail.error_unlock_status"));
      } else {
        setError(toErrorMessage(err));
      }
    } finally {
      setScoringLockInFlight(null);
    }
  };

  const handleForceArchive = async () => {
    if (!apiClient || !canMutateTenant || forceArchiveInFlight) return;
    setForceArchiveInFlight(true);
    setConfirmForceArchive(false);
    setError(null);
    try {
      await archiveEvent(apiClient, eventId);
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setForceArchiveInFlight(false);
    }
  };

  const handleEndEvent = async () => {
    if (!apiClient || !canMutateTenant || endInFlight) return;
    setEndInFlight(true);
    setConfirmEnd(false);
    setError(null);
    try {
      await endEvent(apiClient, eventId);
      await refresh();
    } catch (err) {
      setError(formatEndEventError(err, t));
    } finally {
      setEndInFlight(false);
    }
  };

  return {
    bulkInFlight,
    bulkResult,
    confirmEnd,
    confirmForceArchive,
    confirmTeardown,
    deployDate,
    deployScheduleInFlight,
    deployScheduleModalOpen,
    deployTime,
    endInFlight,
    endsAtDate,
    endsAtInFlight,
    endsAtModalOpen,
    endsAtTime,
    forceArchiveInFlight,
    freezeMinutesInFlight,
    freezeMinutesInput,
    handleBulkDeploy,
    handleBulkTeardown,
    handleEndEvent,
    handleEndNowSchedule,
    handleForceArchive,
    handleLockScoring,
    handleSaveFreezeMinutes,
    handleScheduleDeploy,
    handleScheduleEnd,
    handleScheduleTeardown,
    handleScheduledStart,
    handleStartNow,
    handleUnlockScoring,
    notifyJustSent,
    notifyModalOpen,
    scheduleDate,
    scheduleInFlight,
    scheduleModalOpen,
    scheduleTime,
    scoringLockInFlight,
    setBulkResult,
    setConfirmEnd,
    setConfirmForceArchive,
    setConfirmTeardown,
    setDeployDate,
    setDeployScheduleModalOpen,
    setDeployTime,
    setEndsAtDate,
    setEndsAtModalOpen,
    setEndsAtTime,
    setFreezeMinutesInput,
    setNotifyJustSent,
    setNotifyModalOpen,
    setScheduleDate,
    setScheduleModalOpen,
    setScheduleTime,
    setTeardownDate,
    setTeardownModalOpen,
    setTeardownTime,
    teardownDate,
    teardownInFlight,
    teardownModalOpen,
    teardownTime,
  };
}
