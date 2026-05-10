import { afterEach, describe, expect, it } from "vitest";
import { countUnread, loadLastSeenAt, saveLastSeenAt } from "../../src/lib/notifications-storage";

const STORAGE_KEY = "TenkaCloud.participant.lastSeenNotificationAt";

afterEach(() => localStorage.clear());

describe("notifications-storage", () => {
  describe("loadLastSeenAt / saveLastSeenAt", () => {
    it("初期状態では null を返すべき", () => {
      expect(loadLastSeenAt()).toBeNull();
    });

    it("saveSession した値を loadSession で取り出せる", () => {
      saveLastSeenAt("2026-05-10T14:00:00.000Z");
      expect(loadLastSeenAt()).toBe("2026-05-10T14:00:00.000Z");
    });

    it("古い値で上書きしようとしても巻き戻さない (= max 採用)", () => {
      saveLastSeenAt("2026-05-10T14:00:00.000Z");
      saveLastSeenAt("2026-05-10T13:00:00.000Z");
      expect(localStorage.getItem(STORAGE_KEY)).toBe("2026-05-10T14:00:00.000Z");
    });

    it("空文字は無視するべき (graceful)", () => {
      saveLastSeenAt("");
      expect(loadLastSeenAt()).toBeNull();
    });
  });

  describe("countUnread", () => {
    const items = [
      { occurredAt: "2026-05-10T14:00:00.000Z" },
      { occurredAt: "2026-05-10T13:00:00.000Z" },
      { occurredAt: "2026-05-10T12:00:00.000Z" },
    ];

    it("lastSeen が null なら全件未読", () => {
      expect(countUnread(items, null)).toBe(3);
    });

    it("lastSeen より新しい行のみ未読", () => {
      expect(countUnread(items, "2026-05-10T13:30:00.000Z")).toBe(1);
    });

    it("lastSeen が最新と同値なら未読 0", () => {
      expect(countUnread(items, "2026-05-10T14:00:00.000Z")).toBe(0);
    });

    it("空配列なら 0", () => {
      expect(countUnread([], null)).toBe(0);
    });
  });
});
