import { describe, expect, it } from "vitest";
import {
  isDisruptionWindowOpen,
  isRoundTerminated,
  MAX_ROUND_DURATION_MINUTES,
  resolveRoundTerminalAt,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/round-liveness";

/**
 * #1421 (ADR-029): attack-resilience liveness invariants の純関数を pin する。
 * - "every round reaches a terminal state": resolveRoundTerminalAt は常に有限終端を返す
 * - "no disruption is permanent": isDisruptionWindowOpen は round 開始〜終端に限定される
 */

describe("resolveRoundTerminalAt", () => {
  it("should use an explicit eventEndsAt when present", () => {
    expect(
      resolveRoundTerminalAt({
        eventStartsAt: "2026-05-08T09:00:00.000Z",
        eventEndsAt: "2026-05-08T11:00:00.000Z",
      }),
    ).toBe("2026-05-08T11:00:00.000Z");
  });

  it("should fall back to startsAt + cap when endsAt is unset (= guaranteed terminal)", () => {
    // 30 日 cap → 2026-05-08T09:00 + 30d = 2026-06-07T09:00。
    expect(resolveRoundTerminalAt({ eventStartsAt: "2026-05-08T09:00:00.000Z" })).toBe(
      "2026-06-07T09:00:00.000Z",
    );
  });

  it("should honor a custom cap", () => {
    expect(resolveRoundTerminalAt({ eventStartsAt: "2026-05-08T09:00:00.000Z" }, 60)).toBe(
      "2026-05-08T10:00:00.000Z",
    );
  });

  it("should return undefined when startsAt is missing or unparseable", () => {
    expect(resolveRoundTerminalAt({})).toBeUndefined();
    expect(resolveRoundTerminalAt({ eventStartsAt: "not-a-date" })).toBeUndefined();
  });

  it("should treat an empty-string endsAt as unset and fall back to the cap", () => {
    expect(
      resolveRoundTerminalAt({ eventStartsAt: "2026-05-08T09:00:00.000Z", eventEndsAt: "" }),
    ).toBe("2026-06-07T09:00:00.000Z");
  });

  it("should default the cap to 30 days", () => {
    expect(MAX_ROUND_DURATION_MINUTES).toBe(30 * 24 * 60);
  });
});

describe("isRoundTerminated", () => {
  const round = { eventStartsAt: "2026-05-08T09:00:00.000Z" };
  it("should be false before the resolved terminal and true at/after it", () => {
    expect(isRoundTerminated(round, "2026-05-20T00:00:00.000Z")).toBe(false); // within 30d
    expect(isRoundTerminated(round, "2026-07-01T00:00:00.000Z")).toBe(true); // past 30d cap
  });
  it("should be true at/after an explicit endsAt", () => {
    const r = {
      eventStartsAt: "2026-05-08T09:00:00.000Z",
      eventEndsAt: "2026-05-08T11:00:00.000Z",
    };
    expect(isRoundTerminated(r, "2026-05-08T10:59:59.000Z")).toBe(false);
    expect(isRoundTerminated(r, "2026-05-08T11:00:00.000Z")).toBe(true);
  });
  it("should be false when the round has no resolvable terminal (not started)", () => {
    expect(isRoundTerminated({}, "2026-05-08T10:00:00.000Z")).toBe(false);
  });
});

describe("isDisruptionWindowOpen", () => {
  const round = {
    eventStartsAt: "2026-05-08T09:00:00.000Z",
    eventEndsAt: "2026-05-08T11:00:00.000Z",
  };
  it("should be open only between start and terminal", () => {
    expect(isDisruptionWindowOpen(round, "2026-05-08T08:00:00.000Z")).toBe(false); // before start
    expect(isDisruptionWindowOpen(round, "2026-05-08T10:00:00.000Z")).toBe(true); // mid-round
    expect(isDisruptionWindowOpen(round, "2026-05-08T11:00:00.000Z")).toBe(false); // at terminal
  });
  it("should be closed for an unstarted round", () => {
    expect(isDisruptionWindowOpen({}, "2026-05-08T10:00:00.000Z")).toBe(false);
  });
  it("should close once a no-endsAt round passes the cap (no permanent injection window)", () => {
    expect(
      isDisruptionWindowOpen(
        { eventStartsAt: "2026-05-08T09:00:00.000Z" },
        "2026-05-09T00:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      isDisruptionWindowOpen(
        { eventStartsAt: "2026-05-08T09:00:00.000Z" },
        "2026-07-01T00:00:00.000Z",
      ),
    ).toBe(false);
  });
});
