import { afterEach, describe, expect, it } from "vitest";
import { countUnread, loadLastSeenAt, saveLastSeenAt } from "../../src/lib/notifications-storage";

const KEY_PREFIX = "TenkaCloud.participant.lastSeenNotificationAt";
const EV_A = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
const EV_B = "01HZX0K3M3K9ZQHB3MRQHBA1B3";

afterEach(() => localStorage.clear());

describe("notifications-storage", () => {
  describe("loadLastSeenAt / saveLastSeenAt", () => {
    it("should return null in initial state", () => {
      expect(loadLastSeenAt(EV_A)).toBeNull();
    });

    it("should retrieve a saved value via loadSession", () => {
      saveLastSeenAt(EV_A, "2026-05-10T14:00:00.000Z");
      expect(loadLastSeenAt(EV_A)).toBe("2026-05-10T14:00:00.000Z");
    });

    it("should not roll back when trying to overwrite with an older value (= max wins)", () => {
      saveLastSeenAt(EV_A, "2026-05-10T14:00:00.000Z");
      saveLastSeenAt(EV_A, "2026-05-10T13:00:00.000Z");
      expect(localStorage.getItem(`${KEY_PREFIX}:${EV_A}`)).toBe("2026-05-10T14:00:00.000Z");
    });

    it("should ignore empty string / empty eventId (graceful)", () => {
      saveLastSeenAt(EV_A, "");
      expect(loadLastSeenAt(EV_A)).toBeNull();
      saveLastSeenAt("", "2026-05-10T14:00:00.000Z");
      expect(loadLastSeenAt("")).toBeNull();
    });

    it("should store under an independent key per eventId (no silent read-marking across events)", () => {
      saveLastSeenAt(EV_A, "2026-05-10T14:00:00.000Z");
      // 別 event は影響を受けない
      expect(loadLastSeenAt(EV_B)).toBeNull();
      saveLastSeenAt(EV_B, "2026-05-09T10:00:00.000Z");
      expect(loadLastSeenAt(EV_A)).toBe("2026-05-10T14:00:00.000Z");
      expect(loadLastSeenAt(EV_B)).toBe("2026-05-09T10:00:00.000Z");
    });
  });

  describe("countUnread", () => {
    const items = [
      { occurredAt: "2026-05-10T14:00:00.000Z" },
      { occurredAt: "2026-05-10T13:00:00.000Z" },
      { occurredAt: "2026-05-10T12:00:00.000Z" },
    ];

    it("should mark all items unread when lastSeen is null", () => {
      expect(countUnread(items, null)).toBe(3);
    });

    it("should mark only rows newer than lastSeen as unread", () => {
      expect(countUnread(items, "2026-05-10T13:30:00.000Z")).toBe(1);
    });

    it("should return 0 unread when lastSeen equals the latest item", () => {
      expect(countUnread(items, "2026-05-10T14:00:00.000Z")).toBe(0);
    });

    it("should return 0 for an empty array", () => {
      expect(countUnread([], null)).toBe(0);
    });
  });
});
