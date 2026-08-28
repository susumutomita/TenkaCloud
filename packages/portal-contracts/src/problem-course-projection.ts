/**
 * Participant-safe projection for curriculum position and external-course alignment.
 *
 * Track order is the only learning-order contract. The former catalog-wide knowledge graph
 * duplicated this information without a dependable authoring or maintenance path.
 */

export interface ProblemCourseMetadataInput {
  readonly id: string;
  readonly name: string;
  readonly track?: { id?: string; order?: number; chapter?: string };
  readonly courseAlignment?: {
    courseId?: string;
    edition?: string;
    week?: number;
    role?: string;
    spoilerPolicy?: string;
    sources?: { repository?: string; ref?: string; path?: string; kind?: string }[];
  };
}

export interface ProblemTrackPosition {
  readonly id: string;
  /** Sole source of truth for order inside a track. */
  readonly order: number;
  /** Week or chapter label used for grouping. */
  readonly chapter: string;
}

export interface ProblemCourseAlignment {
  readonly courseId: string;
  readonly edition: string;
  readonly week: number;
  readonly role: string;
  readonly sources: readonly {
    readonly repository: string;
    readonly ref: string;
    readonly path: string;
    readonly kind: string;
  }[];
}

export function toTrackPosition(
  raw: ProblemCourseMetadataInput["track"],
): ProblemTrackPosition | undefined {
  if (!raw || typeof raw.id !== "string" || typeof raw.chapter !== "string") return undefined;
  if (typeof raw.order !== "number" || !Number.isFinite(raw.order)) return undefined;
  return { id: raw.id, order: raw.order, chapter: raw.chapter };
}

/**
 * Keep only participant-safe alignment fields. Embargoed material is omitted entirely.
 */
export function toCourseAlignment(
  raw: ProblemCourseMetadataInput["courseAlignment"],
): ProblemCourseAlignment | undefined {
  if (!raw || raw.spoilerPolicy === "embargoed") return undefined;
  const { courseId, edition, week, role } = raw;
  if (typeof courseId !== "string" || typeof edition !== "string" || typeof role !== "string") {
    return undefined;
  }
  if (typeof week !== "number" || !Number.isFinite(week)) return undefined;
  const sources = (raw.sources ?? []).flatMap((source) =>
    typeof source.repository === "string" &&
    typeof source.ref === "string" &&
    typeof source.path === "string" &&
    typeof source.kind === "string"
      ? [
          {
            repository: source.repository,
            ref: source.ref,
            path: source.path,
            kind: source.kind,
          },
        ]
      : [],
  );
  return { courseId, edition, week, role, sources };
}
