import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.DEPLOYMENTS_TABLE_NAME = "TestDeployments";
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

describe("buildParticipantSharedResources (Lambda init resilience #535)", () => {
  it("EVENTS_TABLE_NAME 未設定でも throw せず eventsTableName=undefined で build できる (Lambda init を死なせない)", () => {
    delete process.env.EVENTS_TABLE_NAME;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const shared = buildParticipantSharedResources();
    expect(shared.eventsTableName).toBeUndefined();
    expect(shared.tableName).toBe("TestDeployments");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EVENTS_TABLE_NAME env が未設定"));
  });

  it("EVENTS_TABLE_NAME が設定されていれば値が反映され、warning は出ない", () => {
    process.env.EVENTS_TABLE_NAME = "TestEvents";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const shared = buildParticipantSharedResources();
    expect(shared.eventsTableName).toBe("TestEvents");
    expect(warn).not.toHaveBeenCalled();
  });

  it("DEPLOYMENTS_TABLE_NAME は必須 (= 未設定なら throw、portal 自体が動かないので fail-fast)", () => {
    delete process.env.DEPLOYMENTS_TABLE_NAME;
    expect(() => buildParticipantSharedResources()).toThrow("DEPLOYMENTS_TABLE_NAME is empty");
  });
});
