import { problemAuthorFields } from "../../packages/portal-contracts/src/problem-authors.js";
import {
  type ProblemCourseMetadataInput,
  toCourseAlignment,
  toTrackPosition,
} from "../../packages/portal-contracts/src/problem-course-projection.js";
import { parseEndpointSlot } from "../../packages/problem-sdk/src/endpoints-metadata.js";
import { catalogMetadata } from "../problem-pack/catalog-read.js";
import { isReviewedCoordination } from "./coordination-catalog.js";

function catalogModuleId(id: string): string {
  return id
    .replace(/\\/gu, "/")
    .replace(
      /\/.tenkacloud\/catalog-store\/snapshots\/[a-f0-9]{64}\/(?:[^?]*?\/)?(challenges|battles)\//u,
      "/problems/$1/",
    );
}
function dockerChallenge(raw: Record<string, unknown>): boolean {
  const runtime = raw.runtime as Record<string, unknown> | undefined;
  const scoring = raw.scoring as Record<string, unknown> | undefined;
  return (
    runtime?.provider === "docker" &&
    runtime.engine === "compose" &&
    (scoring?.kind === "verify" || scoring?.kind === "multi-verify")
  );
}

/** Build-time allowlist, not runtime tree-shaking: never ship organizer-only metadata,
 * hint content, answers, writeups or pre-start instructions to a hosting browser. */
function editionDashboard(value: unknown, edition: string | undefined) {
  const dashboard = value as { slots?: Record<string, string> } | undefined;
  if (!dashboard?.slots) return undefined;
  if (!edition) return { slots: dashboard.slots };
  return {
    slots: Object.fromEntries(
      Object.entries(dashboard.slots).map(([slot, path]) => [
        slot,
        path.replace(/^portal\//u, `portal/${edition}/`),
      ]),
    ),
  };
}
export function publicMetadata(code: string, id: string): string | null {
  const edition = /\/catalog-store\/snapshots\/([a-f0-9]{64})\//u.exec(id)?.[1];
  id = catalogModuleId(id);
  if (!/[/\\]problems[/\\][^/\\]+[/\\][^/\\]+[/\\]metadata\.json(?:\?.*)?$/u.test(id)) return null;
  const raw = catalogMetadata(JSON.parse(code) as Record<string, unknown>);
  const runtime = metadataObject(raw.runtime);
  const scoring = metadataObject(raw.scoring);
  const english = metadataObject(metadataObject(raw.i18n).en);
  const native = isReviewedCoordination(raw.id);
  const pinnedDashboard = editionDashboard(raw.dashboard, edition);
  const coordination = raw.interTeamCoordination as
    | { publicHint?: boolean; name?: string; description?: string }
    | undefined;
  const publicCoordination =
    coordination?.publicHint === true
      ? { publicHint: true, name: coordination.name, description: coordination.description }
      : undefined;
  return JSON.stringify({
    ...problemAuthorFields(raw.authors),
    id: raw.id,
    name: raw.name,
    // Four legacy local exercises are authored under battles/, but their verifier
    // contract is an independent per-team Challenge, not inter-team coordination.
    category: dockerChallenge(raw) ? "Challenge" : raw.category,
    status: raw.status,
    visibility: raw.visibility,
    difficulty: raw.difficulty,
    estimatedDuration: raw.estimatedDuration,
    shortDescription: raw.shortDescription,
    learningGoals: [],
    track: toTrackPosition(raw.track as ProblemCourseMetadataInput["track"]),
    courseAlignment: toCourseAlignment(
      raw.courseAlignment as ProblemCourseMetadataInput["courseAlignment"],
    ),
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    // The catalog facet needs only the public classification, never scoring parameters.
    ...(typeof scoring.kind === "string" ? { scoring: { kind: scoring.kind } } : {}),
    runtime: native
      ? { provider: "local", engine: "bun" }
      : { provider: runtime.provider, engine: runtime.engine },
    ...(native ? { dashboard: pinnedDashboard, interTeamCoordination: publicCoordination } : {}),
    ...(raw.id === "hello-world-battle" ? { endpoints: publicEndpointSlots(raw.endpoints) } : {}),
    i18n: { en: { name: english.name, shortDescription: english.shortDescription } },
  });
}

function publicEndpointSlots(value: unknown) {
  if (!Array.isArray(value)) throw new Error("Reviewed Battle endpoints are missing.");
  return value.map((entry) => {
    const endpoint = parseEndpointSlot(entry);
    if (!endpoint) throw new Error("Reviewed Battle endpoint is invalid.");
    return { slot: endpoint.slot, default: endpoint.default, overridable: endpoint.overridable };
  });
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
