import { describe, expect, it } from "vitest";
import {
  buildScoreEventItem,
  buildScoreEventRecord,
} from "../../lib/problem-deploy/handlers/shared/score-event";

/**
 * [Issue #2441 / Phase B3] `writeScoreEvent` (raw `ddb.send(PutCommand)`) was
 * retired — every caller now resolves its own `DeploymentsRepository` and calls
 * `appendScoreEvent(buildScoreEventRecord(...))` (pinned in
 * `test/problem-deploy/control-data/deployments-repository-scan.test.ts`). This
 * suite keeps pinning the two pure builders that remain here: the domain
 * `ScoreEventRecord` (no physical keys) and the physical `ScoreEventItem`
 * (still used by `DeploymentsRepository.awardGateBonusAtomic`'s TransactWrite).
 */

const parent = {
  jobId: "01HZX0K3M3K9ZQHB3MRQHBA1B2",
  problemId: "security-battle-royale",
  teamId: "T1",
  eventId: "E1",
  expiresAt: 1_700_000_000,
};

describe("buildScoreEventRecord source extension", () => {
  it("source=uptime のとき result=ok / points=指定値で組み立てる", () => {
    const record = buildScoreEventRecord(parent, "uptime", 5, "2026-05-10T10:00:00.000Z");
    expect(record).toMatchObject({
      source: "uptime",
      points: 5,
      result: "ok",
      occurredAt: "2026-05-10T10:00:00.000Z",
    });
  });

  it("source=flag のとき result=ok / points=指定値で組み立てる (= 既存挙動維持)", () => {
    const record = buildScoreEventRecord(parent, "flag", 100, "2026-05-10T10:00:00.000Z");
    expect(record).toMatchObject({ source: "flag", points: 100, result: "ok" });
  });

  it("source=attack-detected のとき result=down / points=0 で組み立てる (新仕様)", () => {
    const record = buildScoreEventRecord(parent, "attack-detected", 0, "2026-05-10T10:00:00.000Z");
    expect(record).toMatchObject({
      source: "attack-detected",
      points: 0,
      result: "down",
      occurredAt: "2026-05-10T10:00:00.000Z",
    });
  });

  it("source=flag-wrong のとき result=wrong で組み立てる", () => {
    const record = buildScoreEventRecord(parent, "flag-wrong", -10, "2026-05-10T10:00:00.000Z");
    expect(record).toMatchObject({ source: "flag-wrong", points: -10, result: "wrong" });
  });

  it("PK/SK を持たない domain shape (物理キーは repository の実装詳細)", () => {
    const record = buildScoreEventRecord(parent, "uptime", 5, "2026-05-10T10:00:00.000Z");
    expect(record).not.toHaveProperty("PK");
    expect(record).not.toHaveProperty("SK");
    expect(record.jobId).toBe(parent.jobId);
    expect(record.expiresAt).toBe(parent.expiresAt);
  });
});

describe("buildScoreEventItem (physical PK/SK, still used by awardGateBonusAtomic)", () => {
  it("PK / SK が DEPLOYMENT#<jobId> / EVENT#<ts>#<ulid> 形になる", () => {
    const item = buildScoreEventItem(parent, "uptime", 5, "2026-05-10T10:00:00.000Z");
    expect(item.PK).toBe(`DEPLOYMENT#${parent.jobId}`);
    expect(item.SK).toMatch(/^EVENT#2026-05-10T10:00:00\.000Z#[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("PK/SK 以外のフィールドは buildScoreEventRecord と同じ内容", () => {
    const record = buildScoreEventRecord(parent, "gate-bonus", 25, "2026-05-10T10:00:00.000Z");
    const item = buildScoreEventItem(parent, "gate-bonus", 25, "2026-05-10T10:00:00.000Z");
    const { PK, SK, ...rest } = item;
    expect(rest).toEqual(record);
  });
});
