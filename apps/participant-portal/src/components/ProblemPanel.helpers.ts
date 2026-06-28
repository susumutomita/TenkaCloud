import type { StatusIndicatorProps } from "@cloudscape-design/components/status-indicator";
import {
  type ApplicationStatus,
  type ApplicationStatusOverall,
  type ParticipantHintView,
  type ParticipantProblemView,
  PortalScoringGateError,
  PortalValidationError,
  type SubmitFlagOutcome,
} from "../api/portal-client";
import type { LocaleCode } from "../i18n";

export type ProblemPanelT = (
  key: string,
  params?: Readonly<Record<string, string | number>>,
) => string;

/**
 * Issue #1917: uptime kind の集約 health (ADR-005 D1) を StatusIndicator と人間可読ラベルに
 * 変換する pure helper。 競技者は「なぜ減点されたか」を、 落ちている個別 endpoint URL を
 * 知らずとも「サービスが degraded/down」という形で把握できる (per-endpoint は露出しない)。
 */
const APP_STATUS_INDICATOR: Record<ApplicationStatusOverall, StatusIndicatorProps.Type> = {
  healthy: "success",
  degraded: "warning",
  down: "error",
  unknown: "pending",
};

export function describeApplicationStatus(
  status: ApplicationStatus,
  t: ProblemPanelT,
): { readonly type: StatusIndicatorProps.Type; readonly label: string } {
  return {
    type: APP_STATUS_INDICATOR[status.overall],
    label: t(`problem_panel.health_${status.overall}`, {
      healthy: status.healthyCount,
      total: status.totalCount,
    }),
  };
}

type ProblemPanelValidationMessageKey =
  | "problem_panel.submit_error_prefix"
  | "problem_panel.validation_error";

/**
 * Issue #1006: scoring gate (= 競技開始前 / 終了後 / 一時停止) のエラーを 「いつ開始 / 終了か」
 * を添えた人間可読 message に変換する。 backend が startsAt / endsAt を返すようになったので、
 * UI 側で 「あと N 分」 を計算して表示する。 #1093: i18n 化。
 */
function describeScoringGate(
  t: ProblemPanelT,
  err: PortalScoringGateError,
  now: Date = new Date(),
): string {
  if (err.kind === "scoring_not_started") {
    if (!err.startsAt) return t("problem_panel.scoring_gate_not_started_no_eta");
    const startsAt = new Date(err.startsAt);
    if (Number.isNaN(startsAt.getTime())) {
      return t("problem_panel.scoring_gate_not_started_unknown");
    }
    const diffMs = startsAt.getTime() - now.getTime();
    if (diffMs <= 0) {
      return t("problem_panel.scoring_gate_not_started_passed", {
        startsAt: startsAt.toLocaleString(),
      });
    }
    const minutes = Math.ceil(diffMs / 60_000);
    return t("problem_panel.scoring_gate_not_started_remaining", {
      minutes,
      startsAt: startsAt.toLocaleString(),
    });
  }
  if (err.kind === "scoring_ended") {
    if (!err.endsAt) return t("problem_panel.scoring_gate_ended_no_eta");
    const endsAt = new Date(err.endsAt);
    if (Number.isNaN(endsAt.getTime())) return t("problem_panel.scoring_gate_ended_unknown");
    return t("problem_panel.scoring_gate_ended_at", { endsAt: endsAt.toLocaleString() });
  }
  return t("problem_panel.scoring_gate_paused");
}

export function formatProblemPanelActionError(
  t: ProblemPanelT,
  err: unknown,
  validationMessageKey: ProblemPanelValidationMessageKey,
): string {
  if (err instanceof PortalScoringGateError) return describeScoringGate(t, err);
  if (err instanceof PortalValidationError) {
    return t(validationMessageKey, { errorCode: err.errorCode });
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function shouldRefreshAfterFlagSubmit(result: SubmitFlagOutcome): boolean {
  return result.kind === "ok" || result.kind === "already_scored";
}

/**
 * #2054 i18n: resolve a revealed hint's content for the current locale. The en
 * override lives in `i18n.en.content` (present only once revealed, mirroring
 * `content`); ja is the canonical `content`. Empty/missing → canonical.
 */
function localizeHint(hint: ParticipantHintView): ParticipantHintView {
  const enContent = hint.i18n?.en?.content;
  return enContent?.trim() ? { ...hint, content: enContent } : hint;
}

/**
 * #2054 i18n: resolve the displayed problem text for the current locale so the
 * portal's locale switcher localizes the live API view (name / description /
 * instructions + revealed hint content). ja is the top-level canonical and is
 * returned unchanged; en overlays each field from `i18n.en`, falling back to the
 * canonical value when an override is missing or empty.
 */
export function localizeProblem(
  problem: ParticipantProblemView,
  lang: LocaleCode,
): ParticipantProblemView {
  if (lang !== "en") return problem;
  const en = problem.i18n?.en;
  const hints = problem.scoring?.hints;
  return {
    ...problem,
    ...(en?.name?.trim() ? { name: en.name } : {}),
    ...(en?.description?.trim() ? { description: en.description } : {}),
    ...(en?.instructions?.trim() ? { instructions: en.instructions } : {}),
    ...(problem.scoring && hints
      ? { scoring: { ...problem.scoring, hints: hints.map(localizeHint) } }
      : {}),
  };
}
