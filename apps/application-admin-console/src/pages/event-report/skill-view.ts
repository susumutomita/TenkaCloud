import type { EventDetail } from "../../api/events-client";
import { buildSkillEvidence } from "../../lib/skill-evidence";
import type { Translate } from "./export-view";

export interface SkillEvidenceView {
  readonly title: string;
  readonly note: string;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/** One resolved view shared by UI, HTML, Markdown and browser print. */
export function buildSkillView(
  detail: EventDetail,
  locale: "ja" | "en",
  t: Translate,
): SkillEvidenceView {
  const unknown = t("event_report.skill_unknown");
  return {
    title: t("event_report.skill_title"),
    note: t("event_report.skill_note"),
    headers: ["team", "skill", "state", "basis"].map((name) => t(`event_report.skill_${name}`)),
    rows: buildSkillEvidence(detail).map((row) => {
      const label = locale === "en" ? row.englishLabel : row.label;
      const skill = row.skillId ? `${label} (${row.skillId})` : unknown;
      const status = t(`event_report.skill_${row.status}`);
      const reason = t(`event_report.skill_reason_${row.reason}`);
      return [
        `${row.teamName} (${row.teamId})`,
        skill,
        `${status}: ${reason}`,
        [
          `event: ${row.eventId}`,
          `problem: ${row.problemId}`,
          `rule: ${row.rule ?? unknown}`,
          `${t("event_report.skill_revision")}: ${row.revision ?? unknown}`,
          ...row.observations.map(
            (observation) =>
              `job: ${observation.jobId}; ${observation.source} / ${observation.result}; ${observation.occurredAt}`,
          ),
          ...(row.observations.length ? [] : [`${t("event_report.col_occurred_at")}: ${unknown}`]),
        ].join("; "),
      ];
    }),
  };
}
