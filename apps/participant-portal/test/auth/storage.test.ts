import { afterEach, describe, expect, it } from "vitest";
import {
  clearSession,
  loadSession,
  type ParticipantSession,
  saveSession,
} from "../../src/auth/storage";

const sample = (): ParticipantSession => ({
  sessionToken: "abc.def.ghi",
  teamId: "team-1",
  teamName: "Team Alpha",
  eventId: "event-1",
  issuedAt: 1_700_000_000_000,
  expiresAt: Date.now() + 60_000,
});

describe("storage", () => {
  afterEach(() => sessionStorage.clear());

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
      expect(sessionStorage.getItem("TenkaCloud.participant.session")).toBeNull();
    });

    it("不正な JSON が入っていたら null + 削除を返すべき", () => {
      sessionStorage.setItem("TenkaCloud.participant.session", "not-a-json");
      expect(loadSession()).toBeNull();
      expect(sessionStorage.getItem("TenkaCloud.participant.session")).toBeNull();
    });

    it("schema 違反 (必須フィールド欠落) なら null + 削除を返すべき", () => {
      sessionStorage.setItem(
        "TenkaCloud.participant.session",
        JSON.stringify({ sessionToken: "x", teamId: "y" }), // 多くのフィールドが欠落
      );
      expect(loadSession()).toBeNull();
      expect(sessionStorage.getItem("TenkaCloud.participant.session")).toBeNull();
    });

    it("expiresAt が文字列 (型違反) なら null + 削除を返すべき", () => {
      sessionStorage.setItem(
        "TenkaCloud.participant.session",
        JSON.stringify({ ...sample(), expiresAt: "later" }),
      );
      expect(loadSession()).toBeNull();
    });
  });

  describe("saveSession", () => {
    it("schema を満たすなら保存できるべき", () => {
      saveSession(sample());
      const stored = sessionStorage.getItem("TenkaCloud.participant.session");
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored!);
      expect(parsed.teamName).toBe("Team Alpha");
    });

    it("schema を満たさない値を保存しようとしたら throw するべき", () => {
      // teamId 欠落
      const bad = { ...sample(), teamId: "" };
      expect(() => saveSession(bad as ParticipantSession)).toThrow();
    });
  });

  describe("clearSession", () => {
    it("保存済み session を削除できるべき", () => {
      saveSession(sample());
      clearSession();
      expect(sessionStorage.getItem("TenkaCloud.participant.session")).toBeNull();
      expect(loadSession()).toBeNull();
    });

    it("何も保存されていない状態でも例外を出さないべき", () => {
      expect(() => clearSession()).not.toThrow();
    });
  });
});
