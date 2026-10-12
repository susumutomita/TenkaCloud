import type { SkillCatalogSnapshot } from "../../../../packages/portal-contracts/src/skill-evidence";
import {
  assessableSource,
  skillDeclarations,
} from "../../../../packages/portal-contracts/src/skill-evidence";
export interface SkillEvidenceInput {
  readonly eventId: string;
  readonly teams: readonly {
    readonly teamId: string;
    readonly displayName?: string;
    readonly internalSlug: string;
  }[];
  readonly problems: readonly {
    readonly problemId: string;
    readonly skillCatalog?: SkillCatalogSnapshot;
  }[];
  readonly deploymentsByProblem: Readonly<
    Record<string, readonly { readonly jobId: string; readonly teamId: string }[]>
  >;
  readonly scoreHistoryAvailable?: boolean;
  readonly scoreEventsByTeam?: readonly {
    readonly teamId: string;
    readonly historyAvailable?: boolean;
    readonly events: readonly SkillObservation[];
  }[];
}
interface SkillObservation {
  readonly problemId: string;
  readonly jobId: string;
  readonly source: string;
  readonly points: number;
  readonly result: string;
  readonly occurredAt: string;
}

export type EvidenceStatus =
  | "demonstrated"
  | "not_observed"
  | "insufficient_evidence"
  | "not_assessable";
export interface SkillEvidenceRow {
  readonly eventId: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly problemId: string;
  readonly skillId?: string;
  readonly label?: string;
  readonly englishLabel?: string;
  readonly rule?: string;
  readonly revision?: string;
  readonly status: EvidenceStatus;
  readonly reason: string;
  readonly observations: readonly {
    readonly jobId: string;
    readonly occurredAt: string;
    readonly source: string;
    readonly result: string;
  }[];
}

/** No score inference, live catalog fallback, personal identity, or invented observation IDs. */
export function buildSkillEvidence(detail: SkillEvidenceInput): readonly SkillEvidenceRow[] {
  const rows: SkillEvidenceRow[] = [];
  for (const team of detail.teams) {
    for (const problem of detail.problems) {
      const snapshot = problem.skillCatalog;
      const declarations = skillDeclarations(snapshot?.declarations);
      const base = {
        eventId: detail.eventId,
        teamId: team.teamId,
        teamName: team.displayName ?? team.internalSlug,
        problemId: problem.problemId,
      };
      if (!declarations) {
        rows.push({
          ...base,
          status: "not_assessable",
          reason: "metadata_missing",
          observations: [],
        });
        continue;
      }
      const history = detail.scoreEventsByTeam?.find((entry) => entry.teamId === team.teamId);
      rows.push(
        ...declarations.map((declaration) => {
          const revision = /^sha256:[a-f0-9]{64}$/u.test(snapshot?.revision ?? "")
            ? snapshot?.revision
            : undefined;
          const events =
            history?.events.filter(
              (entry) =>
                entry.problemId === problem.problemId && entry.source === declaration.rule.source,
            ) ?? [];
          const jobs = detail.deploymentsByProblem[problem.problemId] ?? [];
          const valid = (entry: SkillObservation) =>
            Number.isFinite(Date.parse(entry.occurredAt)) &&
            !!entry.jobId &&
            jobs.some((job) => job.jobId === entry.jobId && job.teamId === team.teamId);
          const observations = [
            ...new Map(
              events.filter(valid).map((entry) => {
                const result = observedResult(entry);
                return [
                  JSON.stringify([entry.jobId, entry.occurredAt, entry.source, result]),
                  {
                    jobId: entry.jobId,
                    occurredAt: entry.occurredAt,
                    source: entry.source,
                    result,
                  },
                ];
              }),
            ).values(),
          ].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
          const [status, reason] = evidenceState({
            supported: assessableSource(snapshot?.scoringKind ?? "", declaration.rule.source),
            historyAvailable:
              detail.scoreHistoryAvailable !== false &&
              !!history &&
              history.historyAvailable !== false,
            revisionKnown: !!revision,
            observationsValid: events.every(valid),
            success: observations.some((entry) => entry.result === "ok"),
          });
          return {
            ...base,
            skillId: declaration.skillId,
            label: declaration.label,
            englishLabel: declaration.i18n.en.label,
            rule: `${declaration.rule.source} / ok`,
            revision,
            status,
            reason,
            observations,
          };
        }),
      );
    }
  }
  return rows;
}

/**
 * Cloud uptime rows keep `result: "ok"` even for a failed probe; the failure is the zero or
 * negative score delta (success points are at least 1 in the catalog schema). Only a positive
 * uptime row is a successful probe; local rows already record a failed probe as `wrong`.
 */
function observedResult(entry: SkillObservation): string {
  if (entry.result !== "ok" || entry.source !== "uptime") return entry.result;
  return entry.points > 0 ? "ok" : "wrong";
}

function evidenceState(input: {
  readonly supported: boolean;
  readonly historyAvailable: boolean;
  readonly revisionKnown: boolean;
  readonly observationsValid: boolean;
  readonly success: boolean;
}): readonly [EvidenceStatus, string] {
  if (!input.supported) return ["not_assessable", "scoring_unsupported"];
  if (!input.historyAvailable) return ["insufficient_evidence", "history_missing"];
  if (!input.revisionKnown) return ["insufficient_evidence", "revision_missing"];
  if (!input.observationsValid) return ["insufficient_evidence", "observation_missing"];
  return input.success ? ["demonstrated", "matched"] : ["not_observed", "no_success"];
}
