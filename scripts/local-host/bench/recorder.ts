import { LatencyRecorder } from "./stats";
import type { HttpStepRecord } from "./types";

/**
 * Tabs keep polling continuously across ramp steps (an open loop, like real browser timers);
 * only the calls made while a window is `active` count toward that step's reported stats.
 */
export class WindowRecorder {
  private readonly overall = new LatencyRecorder();
  private readonly projection = new LatencyRecorder();
  private requestsSent = 0;
  private nonOkCount = 0;
  private networkErrorCount = 0;
  private droppedTicks = 0;
  private active = false;

  beginWindow(): void {
    this.overall.reset();
    this.projection.reset();
    this.requestsSent = 0;
    this.nonOkCount = 0;
    this.networkErrorCount = 0;
    this.droppedTicks = 0;
    this.active = true;
  }

  recordDropped(): void {
    if (this.active) this.droppedTicks += 1;
  }

  recordSuccess(latencyMs: number, status: number, isProjection: boolean): void {
    if (!this.active) return;
    this.requestsSent += 1;
    this.overall.push(latencyMs);
    if (isProjection) this.projection.push(latencyMs);
    if (status >= 300) this.nonOkCount += 1;
  }

  recordNetworkError(): void {
    if (!this.active) return;
    this.requestsSent += 1;
    this.networkErrorCount += 1;
  }

  endWindow(
    tabs: number,
    seconds: number,
    cpuPercent: HttpStepRecord["cpuPercent"],
    rssBytes: HttpStepRecord["rssBytes"],
    sqliteBytesAdded: number,
  ): HttpStepRecord {
    this.active = false;
    const total = this.requestsSent || 1;
    return {
      tabs,
      seconds,
      requestsSent: this.requestsSent,
      nonOkCount: this.nonOkCount,
      networkErrorCount: this.networkErrorCount,
      droppedTicks: this.droppedTicks,
      errorRate: (this.nonOkCount + this.networkErrorCount) / total,
      overall: this.overall.summarize(),
      projection: this.projection.summarize(),
      cpuPercent,
      rssBytes,
      sqliteBytesAdded,
    };
  }
}
