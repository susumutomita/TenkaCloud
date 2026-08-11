import { toErrorMessage } from "@tenkacloud/web-kit";
import { StatusCodes } from "http-status-codes";
import { ApiError } from "../api/client";

/**
 * Issue #2221: pure validation/formatting logic extracted from useEventOperations.ts (the hook
 * bundles ~11 mutation operations; this module holds only the ~110 lines that have no React
 * dependency). Behavior is unchanged — every function here is a verbatim (or, for the 3
 * mirror-image datetime validators, parameterized-but-equivalent) move.
 */

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export interface EndsAtValidation {
  readonly canSubmit: boolean;
  /** i18n key (= `event_detail.error_*`) returned for the caller to resolve via useT(). */
  readonly errorKey?: string;
  readonly value?: Date;
}

/**
 * A same-day-or-later relative-time constraint checked against an optional ISO reference
 * (e.g. "endsAt must be after startsAt"). `violates` compares `value` against `reference` in
 * milliseconds; each of the 3 datetime validators below supplies its own direction/inclusivity.
 */
interface RelativeConstraint {
  readonly referenceIso: string | undefined;
  readonly errorKey: string;
  readonly violates: (valueMs: number, referenceMs: number) => boolean;
}

/**
 * Shared implementation behind `validateEndsAtInput` / `validateTeardownAtInput` /
 * `validateDeployAtInput` — all 3 validate a `date` + `time` pair into a `Date`, reject blank
 * input, reject unparseable input (`${keyPrefix}_format`), reject values more than 60s in the
 * past (`${keyPrefix}_past`), then apply an optional relative constraint against another
 * already-known ISO timestamp.
 */
function validateDateTimeInput(
  date: string,
  time: string,
  nowMs: number,
  keyPrefix: string,
  constraint?: RelativeConstraint,
): EndsAtValidation {
  if (!date || !time) return { canSubmit: false };
  const value = new Date(`${date}T${time}:00`);
  if (Number.isNaN(value.getTime())) {
    return { canSubmit: false, errorKey: `event_detail.error_${keyPrefix}_format` };
  }
  if (value.getTime() < nowMs - 60_000) {
    return { canSubmit: false, errorKey: `event_detail.error_${keyPrefix}_past` };
  }
  if (constraint?.referenceIso) {
    const referenceMs = new Date(constraint.referenceIso).getTime();
    if (Number.isFinite(referenceMs) && constraint.violates(value.getTime(), referenceMs)) {
      return { canSubmit: false, errorKey: constraint.errorKey };
    }
  }
  return { canSubmit: true, value };
}

export function validateEndsAtInput(
  date: string,
  time: string,
  startsAt: string | undefined,
  nowMs: number,
): EndsAtValidation {
  return validateDateTimeInput(date, time, nowMs, "endsat", {
    referenceIso: startsAt,
    errorKey: "event_detail.error_endsat_before_start",
    violates: (valueMs, startsAtMs) => valueMs <= startsAtMs,
  });
}

/**
 * 自動撤去予定時刻の入力検証。 過去不可 (now-60s 以前) かつ endsAt 以降 (= 採点 gate を
 * 閉じてから撤去する always-ends 不変条件)。 endsAt 未設定なら下限制約なし。
 */
export function validateTeardownAtInput(
  date: string,
  time: string,
  endsAt: string | undefined,
  nowMs: number,
): EndsAtValidation {
  return validateDateTimeInput(date, time, nowMs, "teardown", {
    referenceIso: endsAt,
    errorKey: "event_detail.error_teardown_before_ends",
    violates: (valueMs, endsAtMs) => valueMs < endsAtMs,
  });
}

/**
 * 自動デプロイ予定時刻の入力検証 (validateTeardownAtInput の鏡像)。 過去不可
 * (now-60s 以前) かつ endsAt 以前 (= deploy → 採点 → 終了 の時系列を保つ)。 endsAt 未設定なら
 * 上限制約なし。
 */
export function validateDeployAtInput(
  date: string,
  time: string,
  endsAt: string | undefined,
  nowMs: number,
): EndsAtValidation {
  return validateDateTimeInput(date, time, nowMs, "deploy", {
    referenceIso: endsAt,
    errorKey: "event_detail.error_deploy_after_ends",
    violates: (valueMs, endsAtMs) => valueMs > endsAtMs,
  });
}

export function resolveScheduledStartInput(
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

export function formatEndEventError(err: unknown, t: Translate): string {
  if (err instanceof ApiError && err.status === StatusCodes.CONFLICT) {
    const match = err.message.match(/"currentStatus"\s*:\s*"([A-Z_]+)"/);
    const current = match?.[1];
    return current
      ? t("event_detail.error_end_status_with_current", { current })
      : t("event_detail.error_end_status");
  }
  return toErrorMessage(err);
}
