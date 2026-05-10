import { afterEach, describe, expect, it } from "vitest";
import { countUnread, loadLastSeenAt, saveLastSeenAt } from "../../src/lib/notifications-storage";

const KEY_PREFIX = "TenkaCloud.participant.lastSeenNotificationAt";
const EV_A = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
const EV_B = "01HZX0K3M3K9ZQHB3MRQHBA1B3";

afterEach(() => localStorage.clear());

describe("notifications-storage", () => {
  describe("loadLastSeenAt / saveLastSeenAt", () => {
    it("初期状態では null を返すべき", () => {
      expect(loadLastSeenAt(EV_A)).toBeNull();
    });

    it("saveSession した値を loadSession で取り出せる", () => {
      saveLastSeenAt(EV_A, "2026-05-10T14:00:00.000Z");
      expect(loadLastSeenAt(EV_A)).toBe("2026-05-10T14:00:00.000Z");
    });

    it("古い値で上書きしようとしても巻き戻さない (= max 採用)", () => {
      saveLastSeenAt(EV_A, "2026-05-10T14:00:00.000Z");
      saveLastSeenAt(EV_A, "2026-05-10T13:00:00.000Z");
      expect(localStorage.getItem(`${KEY_PREFIX}:${EV_A}`)).toBe("2026-05-10T14:00:00.000Z");
    });

    it("空文字 / 空 eventId は無視するべき (graceful)", () => {
      saveLastSeenAt(EV_A, "");
      expect(loadLastSeenAt(EV_A)).toBeNull();
      saveLastSeenAt("", "2026-05-10T14:00:00.000Z");
      expect(loadLastSeenAt("")).toBeNull();
    });

    it("eventId ごとに独立した key で保存される (event 跨ぎで silent 既読化しない)", () => {
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
