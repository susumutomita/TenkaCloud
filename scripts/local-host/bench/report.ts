import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BenchReport, HttpRunResult, LatencyStats, StateRunResult } from "./types";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(Math.round(bytes))} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function ms(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function p95Cell(stats: LatencyStats): string {
  return stats.count === 0 ? "n/a" : ms(stats.p95);
}

/** first→last p95, so growth in per-request cost as state accumulates is visible at a glance. */
function trendCell(first: LatencyStats | undefined, last: LatencyStats | undefined): string {
  if (!first || !last) return "n/a";
  return `${p95Cell(first)} → ${p95Cell(last)}`;
}

/** One summary row per team count; the full per-minute series is only in the JSON output. */
export function renderStateTable(results: readonly StateRunResult[]): string {
  const header =
    "| Teams | Minutes | Wall (s) | Final state | State growth (bytes/min) | Projection p95 (first→last) | Op p95 (first→last) | DB size | WAL size | Rejected ops | Errors | Stopped |";
  const divider = "|---|---|---|---|---|---|---|---|---|---|---|---|";
  const rows = results.map((result) => {
    const minutes = result.minutes.length;
    const first = result.minutes[0];
    const last = result.minutes[minutes - 1];
    const growth =
      minutes > 1 && first ? (result.finalStateBytes - first.stateBytes) / (minutes - 1) : 0;
    return [
      "",
      String(result.teams),
      String(minutes),
      (result.wallClockMs / 1000).toFixed(1),
      formatBytes(result.finalStateBytes),
      formatBytes(growth),
      trendCell(first?.projection, last?.projection),
      trendCell(first?.op, last?.op),
      formatBytes(result.finalDbBytes),
      formatBytes(result.finalWalBytes),
      String(result.totalRejectedOps),
      String(result.totalErrors),
      result.stoppedReason,
      "",
    ].join("|");
  });
  return [
    header,
    divider,
    ...rows,
    "",
    "Note: projection latency is measured only for the sampled teams (`--sample`); every team's " +
      "projection is still read each step to find LEAK targets, since that traffic matches one " +
      "real browser tab per team polling every 5s.",
    "Note: requests run sequentially within one simulated step, not concurrently — this mode " +
      "isolates per-request cost growth from state size; see Mode http for concurrent load.",
  ].join("\n");
}

export function renderHttpTable(result: HttpRunResult): string {
  const header =
    "| Tabs | Requests | Non-2xx | Net errors | Dropped ticks | Error rate | Overall p50/p95/p99 | Projection p95 | CPU% avg/max | RSS avg/max | SQLite Δ |";
  const divider = "|---|---|---|---|---|---|---|---|---|---|---|";
  const rows = result.steps.map((step) =>
    [
      "",
      String(step.tabs),
      String(step.requestsSent),
      String(step.nonOkCount),
      String(step.networkErrorCount),
      String(step.droppedTicks),
      `${(step.errorRate * 100).toFixed(2)}%`,
      `${ms(step.overall.p50)}/${ms(step.overall.p95)}/${ms(step.overall.p99)}`,
      step.projection.count === 0 ? "n/a" : ms(step.projection.p95),
      `${step.cpuPercent.avg.toFixed(0)}/${step.cpuPercent.max.toFixed(0)}`,
      `${formatBytes(step.rssBytes.avg)}/${formatBytes(step.rssBytes.max)}`,
      formatBytes(step.sqliteBytesAdded),
      "",
    ].join("|"),
  );
  const notes = [
    "Note: the load generator and the host process share this machine's CPU; treat CPU% as " +
      "relative headroom, not an isolated server measurement.",
    "Note: SQLite Δ is a floor — WAL frames are reused after a checkpoint, so file growth can " +
      "understate write volume once checkpoints start.",
  ];
  if (result.stoppedEarly)
    notes.push(
      `Ramp stopped early at ${String(result.stoppedEarly.atTabs)} tabs: ${result.stoppedEarly.reason}`,
    );
  return [header, divider, ...rows, "", ...notes].join("\n");
}

export function writeJsonReport(path: string, report: BenchReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2));
}
