import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSession,
  loadSession,
  type ParticipantSession,
  STORAGE_KEY,
  saveSession,
} from "../../src/auth/storage";

const sample = (): ParticipantSession => ({
  sessionToken: "abc.def.ghi",
  teamId: "team-1",
  teamName: "Team Alpha",
  eventId: "event-1",
  issuedAt: 1_700_000_000_000,
  expiresAt: Date.now() + 60_000,
  teamNameSetByCompetitor: true,
});

describe("storage", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  describe("loadSession", () => {
    it("should return null in initial state", () => {
      expect(loadSession()).toBeNull();
    });

    it("should restore a valid saved session", () => {
      const s = sample();
      saveSession(s);
      const loaded = loadSession();
      expect(loaded).not.toBeNull();
      expect(loaded?.teamId).toBe("team-1");
      expect(loaded?.sessionToken).toBe("abc.def.ghi");
    });

    it("should return null and delete the key when expiresAt is in the past", () => {
      const s: ParticipantSession = { ...sample(), expiresAt: Date.now() - 1 };
      saveSession(s);
      expect(loadSession()).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("should return null and delete when invalid JSON is stored", () => {
      localStorage.setItem(STORAGE_KEY, "not-a-json");
      expect(loadSession()).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("should return null and delete on schema violation (missing required fields)", () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ sessionToken: "x", teamId: "y" }), // 多くのフィールドが欠落
      );
      expect(loadSession()).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      // 旧 shape 残存 / 手動編集の原因特定用に diag log を残しているか
      expect(warnSpy).toHaveBeenCalledWith(
        "[portal] session schema violation, clearing",
        expect.objectContaining({ issues: expect.any(Array) }),
      );
    });

    it("should return null and delete when expiresAt is a string (type violation)", () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...sample(), expiresAt: "later" }));
      expect(loadSession()).toBeNull();
    });

    it("should return null (not throw) when localStorage access is blocked (= private window)", () => {
      // Safari private mode 等では getItem 自体が SecurityError を投げる。 session 復元の
      // ために portal を落とさず 「未ログイン扱い」 = null に倒すのが正しい防御挙動。
      const blockedStorage = {
        getItem: vi.fn(() => {
          throw new Error("SecurityError: localStorage is disabled");
        }),
      };
      expect(loadSession(blockedStorage)).toBeNull();
      expect(blockedStorage.getItem).toHaveBeenCalledWith(STORAGE_KEY);
    });

    it("should be stored in `localStorage` and survive closing the tab (= even when sessionStorage is empty)", () => {
      saveSession(sample());
      sessionStorage.clear(); // tab を閉じた相当
      const loaded = loadSession();
      expect(loaded?.teamId).toBe("team-1");
    });
  });

  describe("saveSession", () => {
    it("should save to `localStorage` when schema is satisfied", () => {
      saveSession(sample());
      const stored = localStorage.getItem(STORAGE_KEY);
      expect(stored).not.toBeNull();
      if (stored === null) {
        throw new Error("session が保存されるべき");
      }
      const parsed = JSON.parse(stored);
      expect(parsed.teamName).toBe("Team Alpha");
    });

    it("should not save to `sessionStorage` (= contract that it persists across reload)", () => {
      saveSession(sample());
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });

  describe("clearSession", () => {
    it("should delete a stored session", () => {
      saveSession(sample());
      clearSession();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(loadSession()).toBeNull();
    });

    it("should not throw when nothing is stored", () => {
      expect(() => clearSession()).not.toThrow();
    });
  });
});
