import { describe, expect, it } from "vitest";
import {
  estimateControlDataQuota,
  TURSO_FREE_MONTHLY_ROWS_READ,
  TURSO_FREE_MONTHLY_ROWS_WRITTEN,
} from "../../../lib/problem-deploy/control-data/quota-model.js";

describe("estimateControlDataQuota", () => {
  it("should keep the event-day profile below one percent of both monthly quotas", () => {
    const estimate = estimateControlDataQuota({
      participantCount: 300,
      leaderboardPollIntervalSeconds: 30,
      eventDurationHours: 24,
      summaryRowWrites: 25_000,
      snapshotRefreshIntervalSeconds: 30,
    });

    expect(estimate).toMatchObject({
      leaderboardSnapshotRowReads: 864_000,
      summaryRowWrites: 25_000,
      snapshotRowWrites: 2_880,
      totalRowWrites: 27_880,
      withinFreeQuota: true,
    });
    expect(estimate.monthlyReadUtilization).toBeCloseTo(0.001728);
    expect(estimate.monthlyWriteUtilization).toBeCloseTo(0.002788);
  });

  it("should fail the gate when either monthly quota is exceeded", () => {
    expect(
      estimateControlDataQuota({
        participantCount: TURSO_FREE_MONTHLY_ROWS_READ + 1,
        leaderboardPollIntervalSeconds: 3600,
        eventDurationHours: 1,
        summaryRowWrites: 1,
        snapshotRefreshIntervalSeconds: 3600,
      }).withinFreeQuota,
    ).toBe(false);

    expect(
      estimateControlDataQuota({
        participantCount: 1,
        leaderboardPollIntervalSeconds: 3600,
        eventDurationHours: 1,
        summaryRowWrites: TURSO_FREE_MONTHLY_ROWS_WRITTEN,
        snapshotRefreshIntervalSeconds: 3600,
      }).withinFreeQuota,
    ).toBe(false);
  });

  it("should reject zero, fractional, and negative profile values", () => {
    const base = {
      participantCount: 300,
      leaderboardPollIntervalSeconds: 30,
      eventDurationHours: 24,
      summaryRowWrites: 25_000,
      snapshotRefreshIntervalSeconds: 30,
    };

    expect(() => estimateControlDataQuota({ ...base, participantCount: 0 })).toThrow(
      /participantCount/,
    );
    expect(() => estimateControlDataQuota({ ...base, eventDurationHours: 1.5 })).toThrow(
      /eventDurationHours/,
    );
    expect(() => estimateControlDataQuota({ ...base, summaryRowWrites: -1 })).toThrow(
      /summaryRowWrites/,
    );
  });
});
