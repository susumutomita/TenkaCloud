import { readFileSync } from "node:fs";
import type { Finding } from "./types.ts";

export interface BaselineEntry {
  readonly ruleId: string;
  readonly filePath: string;
  readonly line: number;
  readonly match: string;
}

export interface BaselineFile {
  readonly entries: readonly BaselineEntry[];
}

export function loadBaseline(path: string): BaselineFile {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BaselineFile;
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "ENOENT") return { entries: [] };
    throw err;
  }
}

export function isBaselined(finding: Finding, baseline: BaselineFile): boolean {
  return baseline.entries.some(
    (entry) =>
      entry.ruleId === finding.ruleId &&
      entry.filePath === finding.filePath &&
      entry.line === finding.line &&
      (finding.match === undefined || entry.match === finding.match),
  );
}
