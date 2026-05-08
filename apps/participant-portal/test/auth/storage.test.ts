import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSession,
  loadSession,
  type ParticipantSession,
  saveSession,
} from "../../src/auth/storage";

const STORAGE_KEY = "TenkaCloud.participant.session";

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
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  describe("loadSession", () => {
    it("初期状態では null を返すべき", () => {
      expect(loadSession()).toBeNull();
    });

    it("有効な session が保存されているなら復元できるべき", () => {
      const s = sample();
      saveSession(s);
      const loaded = loadSession();
      expect(loaded).not.toBeNull();
      expect(loaded?.teamId).toBe("team-1");
      expect(loaded?.sessionToken).toBe("abc.def.ghi");
    });

    it("expiresAt が過去の session は null にして key を消すべき", () => {
      const s: ParticipantSession = { ...sample(), expiresAt: Date.now() - 1 };
      saveSession(s);
      expect(loadSession()).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("不正な JSON が入っていたら null + 削除を返すべき", () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      localStorage.setItem(STORAGE_KEY, "not-a-json");
      expect(loadSession()).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("schema 違反 (必須フィールド欠落) なら null + 削除を返すべき", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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

    it("expiresAt が文字列 (型違反) なら null + 削除を返すべき", () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...sample(), expiresAt: "later" }));
      expect(loadSession()).toBeNull();
    });

    it("`localStorage` に保存され、tab を閉じても (= sessionStorage が空でも) 復元できるべき", () => {
      saveSession(sample());
      sessionStorage.clear(); // tab を閉じた相当
      const loaded = loadSession();
      expect(loaded?.teamId).toBe("team-1");
    });
  });

  describe("saveSession", () => {
    it("schema を満たすなら `localStorage` に保存できるべき", () => {
      saveSession(sample());
      const stored = localStorage.getItem(STORAGE_KEY);
      expect(stored).not.toBeNull();
      if (stored === null) {
        throw new Error("session が保存されるべき");
      }
      const parsed = JSON.parse(stored);
      expect(parsed.teamName).toBe("Team Alpha");
    });

    it("`sessionStorage` には保存されないべき (= reload 越しに保たれる契約)", () => {
      saveSession(sample());
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });

  describe("clearSession", () => {
    it("保存済み session を削除できるべき", () => {
      saveSession(sample());
      clearSession();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(loadSession()).toBeNull();
    });

    it("何も保存されていない状態でも例外を出さないべき", () => {
      expect(() => clearSession()).not.toThrow();
    });
  });
});
