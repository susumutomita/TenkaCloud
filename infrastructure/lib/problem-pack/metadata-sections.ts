/**
 * [Problem Packs / Issue #2088] Metadata-section validation for the pack validator.
 *
 * Split out of `validate-pack.ts` (SRP): this module runs the existing reused
 * pure parsers (`parseScoringMetadata` / `parseEndpointSlot` / `parsePhaseEntry`
 * / `parseDisruptionEntry`) over a problem's optional metadata sections. The
 * parsers return `undefined` on invalid input rather than throwing, so a section
 * that is *present* but unparseable is surfaced as a METADATA_INVALID diagnostic
 * (an author typo that would otherwise silently disable scoring / endpoints at
 * runtime). It owns no I/O.
 */

import { parseEndpointSlot } from "../utils/endpoints-metadata.js";
import { parseDisruptionEntry, parsePhaseEntry } from "../utils/metadata-parser.js";
import { parseScoringMetadata } from "../utils/scoring-metadata.js";
import type { PackDiagnostic } from "./diagnostics.js";

/** The minimal problem shape this module needs (metadata + where to report it). */
export interface ProblemMetadataView {
  readonly metadataFile: string;
  readonly metadata: Record<string, unknown>;
}

/** Validate the optional `scoring` / `endpoints` / `phases` / `disruptions` sections. */
export function validateMetadataSections(
  problem: ProblemMetadataView,
  diagnostics: PackDiagnostic[],
): void {
  const meta = problem.metadata;
  if (meta.scoring !== undefined && !parseScoringMetadata(meta.scoring)) {
    diagnostics.push({
      code: "METADATA_INVALID",
      file: problem.metadataFile,
      path: "scoring",
      message: "scoring section is present but does not match any built-in scoring kind.",
    });
  }
  reportInvalidArrayEntries(meta.endpoints, "endpoints", parseEndpointSlot, problem, diagnostics);
  reportInvalidArrayEntries(meta.phases, "phases", parsePhaseEntry, problem, diagnostics);
  reportInvalidArrayEntries(
    meta.disruptions,
    "disruptions",
    parseDisruptionEntry,
    problem,
    diagnostics,
  );
}

function reportInvalidArrayEntries(
  value: unknown,
  field: string,
  parse: (entry: unknown) => unknown,
  problem: ProblemMetadataView,
  diagnostics: PackDiagnostic[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    diagnostics.push({
      code: "METADATA_INVALID",
      file: problem.metadataFile,
      path: field,
      message: `${field} must be an array.`,
    });
    return;
  }
  value.forEach((entry, index) => {
    if (!parse(entry)) {
      diagnostics.push({
        code: "METADATA_INVALID",
        file: problem.metadataFile,
        path: `${field}[${index}]`,
        message: `${field}[${index}] is not a valid ${field} entry.`,
      });
    }
  });
}
