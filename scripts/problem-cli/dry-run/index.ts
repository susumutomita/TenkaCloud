import { existsSync } from "node:fs";
import { join } from "node:path";

import { findProblemDir, readProblemMetadata } from "../problem-loader";
import { runAttackDetectionDryRun } from "./attack-detection";
import { runFlagDryRun } from "./flag";
import { runPhasedPollingDryRun } from "./phased-polling";
import type { DryRunArgs, DryRunKindInput, DryRunResult } from "./types";
import { runUptimeFlatDryRun } from "./uptime-flat";
import { runUptimeMultiDryRun } from "./uptime-multi";

export type { DryRunArgs, DryRunResult } from "./types";

/**
 * 問題の `metadata.scoring` を読んで、 与えられた input に対する得点を local 計算する。
 * 実 deploy 不要 (= scoring engine の Lambda 経路を回さない) で採点ロジックの妥当性を
 * 確認できる。 #951 sub #3。
 */
export function runDryRun(args: DryRunArgs): DryRunResult {
  const dir = findProblemDir(args.problemId);
  if (!dir) {
    return {
      ok: false,
      summary: `Problem dir not found for id="${args.problemId}"`,
      lines: [],
    };
  }
  const metaPath = join(dir, "metadata.json");
  if (!existsSync(metaPath)) {
    return { ok: false, summary: "metadata.json not found", lines: [] };
  }
  const meta = readProblemMetadata(dir);
  const scoring = (meta.scoring ?? {}) as Record<string, unknown>;
  const kind = String(scoring.kind ?? "");
  const lines: string[] = [];
  const input: DryRunKindInput = { args, dir, meta, scoring, lines, kind };

  if (kind === "flag") return runFlagDryRun(input);
  if (kind === "uptime-flat" || kind === "uptime") return runUptimeFlatDryRun(input);
  if (kind === "uptime-multi") return runUptimeMultiDryRun(input);
  if (kind === "phased-polling") return runPhasedPollingDryRun(input);
  if (kind === "attack-detection") return runAttackDetectionDryRun(input);

  // それでも未対応の kind (= 将来追加分)
  lines.push(`kind="${kind}" の dry-run は未対応です (= 将来 kind 追加時に拡張)`);
  return { ok: true, summary: `kind=${kind} dry-run unsupported`, lines };
}
