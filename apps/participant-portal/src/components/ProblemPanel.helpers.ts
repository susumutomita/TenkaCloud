import type { StatusIndicatorProps } from "@cloudscape-design/components/status-indicator";
import {
  type ApplicationStatus,
  type ApplicationStatusOverall,
  type AttackProbeOutcome,
  type AttackProbeResult,
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

/**
 * Issue #2422: 1 attack-probe の直近サイクルの結果を StatusIndicator + 人間可読ラベルに変換する。
 * defender は「green (200) なのに満点にならない理由」= まだ刺さっている probe を、 正確な endpoint /
 * 脆弱性クラスを知らずとも「landed → -N pt このサイクル」という形で把握できる (非スポイラー)。
 *
 *   - landed  → error   「−penalty pt (このサイクル)」= 脆弱、 まだ刺さっている
 *   - blocked → success 「防御成功 (0 pt)」= 防げている
 *   - skipped → pending 「判定不能」= slot 未解決 / 到達不能 (可用性は別途)
 *
 * `label` / `symptom` は問題側 metadata が明示した非スポイラー文言のみ。 label 不在なら index で採番。
 */
const ATTACK_PROBE_INDICATOR: Record<AttackProbeOutcome, StatusIndicatorProps.Type> = {
  landed: "error",
  blocked: "success",
  skipped: "pending",
};

export interface AttackProbeRow {
  readonly type: StatusIndicatorProps.Type;
  readonly name: string;
  readonly outcomeLabel: string;
  readonly symptom?: string;
}

export function describeAttackProbe(
  probe: AttackProbeResult,
  index: number,
  t: ProblemPanelT,
): AttackProbeRow {
  const name = probe.label?.trim()
    ? probe.label
    : t("problem_panel.attack_probe_default_name", {
        index: index + 1,
      });
  const delta = probe.outcome === "landed" ? -probe.penalty : 0;
  return {
    type: ATTACK_PROBE_INDICATOR[probe.outcome],
    name,
    outcomeLabel: t(`problem_panel.attack_probe_${probe.outcome}`, {
      penalty: probe.penalty,
      delta,
    }),
    ...(probe.symptom?.trim() ? { symptom: probe.symptom } : {}),
  };
}

/**
 * Issue #2422: 攻撃 probe の集約要約。 landed が 1 つでもあれば warning (= 減点中) を、 全て
 * blocked/skipped なら success 寄りの中立を返し、 セクション見出しの StatusIndicator に使う。
 */
export function summarizeAttackProbes(
  probes: readonly AttackProbeResult[],
  t: ProblemPanelT,
): { readonly type: StatusIndicatorProps.Type; readonly label: string } {
  const landed = probes.filter((p) => p.outcome === "landed").length;
  if (landed > 0) {
    return {
      type: "warning",
      label: t("problem_panel.attack_probe_summary_landed", { landed, total: probes.length }),
    };
  }
  return {
    type: "success",
    label: t("problem_panel.attack_probe_summary_clear", { total: probes.length }),
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
    // Issue #2283: Progression Gate。 locked 問題への flag 提出 / hint reveal は backend が
    // 409 challenge_prerequisite_not_met で拒否する。 UI は通常 lock 表示で先回りするので
    // 到達しないが、 polling 反映前の隙間で届いたときに親切文言を出す (defense-in-depth)。
    if (err.errorCode === "challenge_prerequisite_not_met") {
      return t("problem_panel.prerequisite_locked_error");
    }
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
    ...(en?.writeup?.trim() ? { writeup: en.writeup } : {}),
    ...(problem.scoring && hints
      ? { scoring: { ...problem.scoring, hints: hints.map(localizeHint) } }
      : {}),
  };
}
