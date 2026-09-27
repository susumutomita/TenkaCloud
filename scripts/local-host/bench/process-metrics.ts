import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { average } from "./stats";

export function fileBytesOrZero(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** The host's `.sqlite` main file plus its WAL and shared-memory index, summed. */
export function sqliteBytesTotal(databasePath: string): number {
  return (
    fileBytesOrZero(databasePath) +
    fileBytesOrZero(`${databasePath}-wal`) +
    fileBytesOrZero(`${databasePath}-shm`)
  );
}

export interface ProcessSample {
  readonly cpuPercent: number;
  readonly rssBytes: number;
}

/** One `ps` read of a single process; `null` when the pid is gone or `ps` output is unparseable. */
export function samplePid(pid: number): Promise<ProcessSample | null> {
  return new Promise((accept) => {
    // Absolute path, not a PATH lookup: this only ever reads the local host child's own usage.
    execFile("/bin/ps", ["-o", "%cpu=,rss=", "-p", String(pid)], (error, stdout) => {
      if (error) {
        accept(null);
        return;
      }
      const [cpuText, rssText] = stdout.trim().split(/\s+/u);
      const cpuPercent = Number(cpuText);
      const rssKilobytes = Number(rssText);
      if (!Number.isFinite(cpuPercent) || !Number.isFinite(rssKilobytes)) {
        accept(null);
        return;
      }
      accept({ cpuPercent, rssBytes: rssKilobytes * 1024 });
    });
  });
}

export interface ProcessUsageSummary {
  readonly cpuPercent: { readonly avg: number; readonly max: number };
  readonly rssBytes: { readonly avg: number; readonly max: number };
}

const EMPTY_USAGE: ProcessUsageSummary = {
  cpuPercent: { avg: 0, max: 0 },
  rssBytes: { avg: 0, max: 0 },
};

/** Polls one pid on an interval; `stop()` returns the window's average/max and resets. */
export class ProcessSampler {
  private samples: ProcessSample[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private readonly pid: number,
    private readonly intervalMs: number,
  ) {}
  start(): void {
    this.timer = setInterval(() => {
      void samplePid(this.pid).then((sample) => {
        if (sample) this.samples.push(sample);
      });
    }, this.intervalMs);
  }
  stop(): ProcessUsageSummary {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.samples.length === 0) return EMPTY_USAGE;
    const cpuValues = this.samples.map((sample) => sample.cpuPercent);
    const rssValues = this.samples.map((sample) => sample.rssBytes);
    const summary: ProcessUsageSummary = {
      cpuPercent: { avg: average(cpuValues), max: Math.max(...cpuValues) },
      rssBytes: { avg: average(rssValues), max: Math.max(...rssValues) },
    };
    this.samples = [];
    return summary;
  }
}
