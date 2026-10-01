import { describe, expect, it } from "vitest";
import {
  RegistrationConfigSchema,
  registrationEventActive,
  registrationInfoSchema,
  registrationProgressSchema,
  registrationSecretSchema,
  validRegistrationSelection,
} from "../src/event-registration.js";

const now = Date.parse("2026-09-22T09:00:00.000Z");
const event = {
  status: "READY",
  expiresAt: Math.floor((now + 3_600_000) / 1000),
  endsAt: "2026-09-22T09:30:00.000Z",
};
const teamId = `01${"A".repeat(24)}`;
const loginKey = "a".repeat(43);

describe("registration contracts", () => {
  it("accepts a disabled configuration and a bounded team pool", () => {
    expect(RegistrationConfigSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(
      RegistrationConfigSchema.safeParse({
        enabled: true,
        closesAt: "2026-09-22T09:15:00.000Z",
        teamIds: [teamId],
      }).success,
    ).toBe(true);
    expect(RegistrationConfigSchema.safeParse({ enabled: false, teamIds: [] }).success).toBe(false);
    expect(
      RegistrationConfigSchema.safeParse({
        enabled: true,
        closesAt: "2026-09-22T09:15:00.000Z",
        teamIds: [],
      }).success,
    ).toBe(false);
    expect(
      RegistrationConfigSchema.safeParse({
        enabled: true,
        closesAt: "2026-09-22T09:15:00.000Z",
        teamIds: ["invalid-team-id"],
      }).success,
    ).toBe(false);
  });

  it("requires a valid login key only for a ready receipt", () => {
    const progress = { eventName: "Battle", teamId, ready: 0, total: 1 };
    expect(registrationProgressSchema.safeParse({ ...progress, state: "preparing" }).success).toBe(
      true,
    );
    expect(registrationProgressSchema.safeParse({ ...progress, state: "ready" }).success).toBe(
      false,
    );
    expect(
      registrationProgressSchema.safeParse({
        ...progress,
        state: "ready",
        teamLoginKey: loginKey,
      }).success,
    ).toBe(true);
    expect(registrationSecretSchema.safeParse(loginKey.slice(1)).success).toBe(false);
    expect(registrationSecretSchema.safeParse(`!${loginKey.slice(1)}`).success).toBe(false);
    expect(
      registrationInfoSchema.safeParse({ name: "Battle", state: "open", remaining: 1 }).success,
    ).toBe(true);
    expect(
      registrationInfoSchema.safeParse({ name: "Battle", state: "open", remaining: -1 }).success,
    ).toBe(false);
  });
});

describe("registration window", () => {
  it("admits draft, deploying and ready events only before expiry and end", () => {
    for (const status of ["DRAFT", "DEPLOYING", "READY"]) {
      expect(registrationEventActive({ ...event, status }, now)).toBe(true);
    }
    expect(registrationEventActive({ ...event, status: "STOPPED" }, now)).toBe(false);
    expect(registrationEventActive(event, Date.parse(event.endsAt))).toBe(false);
    expect(registrationEventActive({ ...event, endsAt: undefined }, event.expiresAt * 1000)).toBe(
      false,
    );
    expect(registrationEventActive(undefined, now)).toBe(false);
  });

  it("requires a unique pool and a finite deadline within both event limits", () => {
    const closesAt = "2026-09-22T09:15:00.000Z";
    expect(validRegistrationSelection(event, [teamId], closesAt, now)).toBe(true);
    expect(validRegistrationSelection(event, [], closesAt, now)).toBe(false);
    expect(validRegistrationSelection(event, [teamId, teamId], closesAt, now)).toBe(false);
    expect(validRegistrationSelection(event, [teamId], "invalid", now)).toBe(false);
    expect(validRegistrationSelection(event, [teamId], new Date(now).toISOString(), now)).toBe(
      false,
    );
    expect(validRegistrationSelection(event, [teamId], "2026-09-22T09:31:00.000Z", now)).toBe(
      false,
    );
    expect(
      validRegistrationSelection(
        { ...event, endsAt: undefined },
        [teamId],
        "2026-09-22T10:01:00.000Z",
        now,
      ),
    ).toBe(false);
  });
});
