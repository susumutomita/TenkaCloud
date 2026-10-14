import type { ParticipantTeamView } from "@tenkacloud/portal-contracts";
import { metadataToEntry } from "../../../../../packages/portal-contracts/src/problem-catalog.js";
import { publicMetadata } from "../../../../../scripts/local-host/browser-public-metadata.js";
import type { ExecutionCatalog } from "../shared/execution-catalog.js";
import type { EventGate } from "./event-gate.js";

/** Authorized event views release only the pinned narrative after start and prerequisite unlock. */
export function releaseCatalogInstructions(
  problems: ParticipantTeamView["problems"],
  catalog: ExecutionCatalog | undefined,
  gate: EventGate | undefined,
  lockedIds: readonly string[],
  now: number,
): ParticipantTeamView["problems"] {
  if (!catalog?.instructions || !gate?.startsAt) return problems;
  const starts = Date.parse(gate.startsAt);
  if (!Number.isFinite(starts) || now < starts) return problems;
  return problems.map((problem) => {
    if (lockedIds.includes(problem.problemId)) return problem;
    const text = catalog.instructions?.[problem.problemId];
    if (!text) return problem;
    return {
      ...problem,
      ...(text.instructions !== undefined ? { instructions: text.instructions } : {}),
      ...(text.englishInstructions !== undefined
        ? {
            i18n: {
              ...problem.i18n,
              en: { ...problem.i18n?.en, instructions: text.englishInstructions },
            },
          }
        : {}),
    };
  });
}

/** Use only the event-pinned public projection; this reader never needs source-object access. */
export async function savedProblemCatalog(
  catalog: ExecutionCatalog,
  ids: readonly (string | undefined)[],
) {
  if (ids.some((id) => !id || !catalog.publicMetadata?.[id])) return [];
  return ids.map((id) => {
    if (!id) throw new Error("Saved problem identity is missing");
    const metadata = catalog.publicMetadata?.[id] as { id?: unknown };
    if (metadata.id !== id) throw new Error("Saved problem metadata identity mismatch");
    const directory = catalog.catalog[id];
    const suffix = /(?:challenges|battles)\/[^/]+$/u.exec(directory ?? "")?.[0];
    if (!suffix) throw new Error("Saved problem catalog has no public metadata identity");
    // Dashboard module paths were already edition-pinned by the producer.
    const projected = publicMetadata(JSON.stringify(metadata), `/problems/${suffix}/metadata.json`);
    if (!projected) throw new Error("Saved problem metadata cannot be projected");
    return metadataToEntry(JSON.parse(projected));
  });
}
