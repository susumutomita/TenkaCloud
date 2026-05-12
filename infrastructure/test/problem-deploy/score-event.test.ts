import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { writeScoreEvent } from "../../lib/problem-deploy/handlers/shared/score-event";

const parent = {
  jobId: "01HZX0K3M3K9ZQHB3MRQHBA1B2",
  problemId: "security-battle-royale",
  teamId: "T1",
  eventId: "E1",
  expiresAt: 1_700_000_000,
};

describe("writeScoreEvent (ADR-005 Phase 3.1: source extension)", () => {
  it("source=uptime のとき result=ok / points=指定値で書き込む", async () => {
    const send = vi.fn().mockResolvedValue({});
    const ddb = { send } as unknown as Parameters<typeof writeScoreEvent>[0];
    await writeScoreEvent(ddb, "T", parent, "uptime", 5, "2026-05-10T10:00:00.000Z");
    const cmd = send.mock.calls[0]?.[0] as PutCommand;
    expect(cmd).toBeInstanceOf(PutCommand);
    expect(cmd.input.Item).toMatchObject({
      source: "uptime",
      points: 5,
      result: "ok",
      occurredAt: "2026-05-10T10:00:00.000Z",
    });
  });

  it("source=flag のとき result=ok / points=指定値で書き込む (= 既存挙動維持)", async () => {
    const send = vi.fn().mockResolvedValue({});
    const ddb = { send } as unknown as Parameters<typeof writeScoreEvent>[0];
    await writeScoreEvent(ddb, "T", parent, "flag", 100, "2026-05-10T10:00:00.000Z");
    const cmd = send.mock.calls[0]?.[0] as PutCommand;
    expect(cmd.input.Item).toMatchObject({
      source: "flag",
      points: 100,
      result: "ok",
    });
  });

  it("source=attack-detected のとき result=down / points=0 で書き込む (新仕様)", async () => {
    const send = vi.fn().mockResolvedValue({});
    const ddb = { send } as unknown as Parameters<typeof writeScoreEvent>[0];
    await writeScoreEvent(ddb, "T", parent, "attack-detected", 0, "2026-05-10T10:00:00.000Z");
    const cmd = send.mock.calls[0]?.[0] as PutCommand;
    expect(cmd.input.Item).toMatchObject({
      source: "attack-detected",
      points: 0,
      result: "down",
      occurredAt: "2026-05-10T10:00:00.000Z",
    });
  });

  it("source=microservice-migration + points>0 のとき result=ok で書き込む (#606 Phase 2)", async () => {
    const send = vi.fn().mockResolvedValue({});
    const ddb = { send } as unknown as Parameters<typeof writeScoreEvent>[0];
    await writeScoreEvent(
      ddb,
      "T",
      parent,
      "microservice-migration",
      1_000,
      "2026-05-10T10:00:00.000Z",
    );
    const cmd = send.mock.calls[0]?.[0] as PutCommand;
    expect(cmd.input.Item).toMatchObject({
      source: "microservice-migration",
      points: 1_000,
      result: "ok",
    });
  });

  it("source=microservice-migration + points<0 (probe 失敗) のとき result=down で書き込む (#606 Phase 2)", async () => {
    const send = vi.fn().mockResolvedValue({});
    const ddb = { send } as unknown as Parameters<typeof writeScoreEvent>[0];
    await writeScoreEvent(
      ddb,
      "T",
      parent,
      "microservice-migration",
      -100,
      "2026-05-10T10:00:00.000Z",
    );
    const cmd = send.mock.calls[0]?.[0] as PutCommand;
    expect(cmd.input.Item).toMatchObject({
      source: "microservice-migration",
      points: -100,
      result: "down",
    });
  });

  it("source=microservice-migration-bonus は常に result=ok で書き込む (#606 Phase 2、+5000 lump-sum)", async () => {
    const send = vi.fn().mockResolvedValue({});
    const ddb = { send } as unknown as Parameters<typeof writeScoreEvent>[0];
    await writeScoreEvent(
      ddb,
      "T",
      parent,
      "microservice-migration-bonus",
      5_000,
      "2026-05-10T10:00:00.000Z",
    );
    const cmd = send.mock.calls[0]?.[0] as PutCommand;
    expect(cmd.input.Item).toMatchObject({
      source: "microservice-migration-bonus",
      points: 5_000,
      result: "ok",
    });
  });

  it("PK / SK が DEPLOYMENT#<jobId> / EVENT#<ts>#<ulid> 形になる", async () => {
    const send = vi.fn().mockResolvedValue({});
    const ddb = { send } as unknown as Parameters<typeof writeScoreEvent>[0];
    await writeScoreEvent(ddb, "T", parent, "uptime", 5, "2026-05-10T10:00:00.000Z");
    const item = (send.mock.calls[0]?.[0] as PutCommand).input.Item as {
      PK: string;
      SK: string;
    };
    expect(item.PK).toBe(`DEPLOYMENT#${parent.jobId}`);
    expect(item.SK).toMatch(/^EVENT#2026-05-10T10:00:00\.000Z#[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
