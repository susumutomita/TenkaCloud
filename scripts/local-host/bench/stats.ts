import { cpus, totalmem } from "node:os";
import type { LatencyStats, MachineInfo } from "./types";

const EMPTY: LatencyStats = { count: 0, p50: 0, p95: 0, p99: 0, max: 0 };

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index] ?? 0;
}

/** Accumulates latency samples (milliseconds) for one window, then summarizes and clears. */
export class LatencyRecorder {
  private samples: number[] = [];
  push(ms: number): void {
    this.samples.push(ms);
  }
  get count(): number {
    return this.samples.length;
  }
  summarize(): LatencyStats {
    if (this.samples.length === 0) return EMPTY;
    const sorted = [...this.samples].sort((left, right) => left - right);
    return {
      count: sorted.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: sorted[sorted.length - 1] ?? 0,
    };
  }
  reset(): void {
    this.samples = [];
  }
}

export function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function machineInfo(): MachineInfo {
  const info = cpus();
  return {
    cpuModel: info[0]?.model ?? "unknown",
    cpuCount: info.length,
    totalMemoryBytes: totalmem(),
    bunVersion: Bun.version,
    platform: process.platform,
  };
}
