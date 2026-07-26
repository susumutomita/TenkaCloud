import {
  emptyProgress,
  recordAttempt,
  SHA256_DRILL,
  serializeProgress,
} from "@tenkacloud/crypto-drill";
import { describe, expect, it } from "vitest";
import { drillStorageKey, loadDrillProgress, saveDrillProgress } from "./crypto-drill-storage";

function memoryStorage(initial: Readonly<Record<string, string>> = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
}

function throwingStorage() {
  return {
    getItem: () => {
      throw new Error("private window");
    },
    setItem: () => {
      throw new Error("quota exceeded");
    },
  };
}

describe("crypto drill progress storage", () => {
  it("should scope the storage key per drill", () => {
    expect(drillStorageKey("sha256")).toBe("TenkaCloud.participant.cryptoDrillProgress:sha256");
    expect(drillStorageKey("hmac")).not.toBe(drillStorageKey("sha256"));
  });

  it("should return empty progress when nothing has been saved", () => {
    expect(loadDrillProgress("sha256", memoryStorage())).toEqual({
      progress: emptyProgress("sha256"),
      persisted: true,
    });
  });

  it("should round-trip saved progress", () => {
    const storage = memoryStorage();
    const progress = recordAttempt(emptyProgress(SHA256_DRILL.id), "utf8-hex", true);
    expect(saveDrillProgress(progress, storage)).toBe(true);
    expect(storage.entries.get(drillStorageKey(SHA256_DRILL.id))).toBe(serializeProgress(progress));
    expect(loadDrillProgress(SHA256_DRILL.id, storage)).toEqual({ progress, persisted: true });
  });

  it("should report a corrupted or foreign value as readable storage with empty progress", () => {
    // storage 自体は読めているので `persisted: true`: 今後の保存は効く。
    const corrupted = memoryStorage({ [drillStorageKey("sha256")]: "{not json" });
    expect(loadDrillProgress("sha256", corrupted)).toEqual({
      progress: emptyProgress("sha256"),
      persisted: true,
    });

    const foreign = memoryStorage({
      [drillStorageKey("sha256")]: serializeProgress(emptyProgress("hmac")),
    });
    expect(loadDrillProgress("sha256", foreign)).toEqual({
      progress: emptyProgress("sha256"),
      persisted: true,
    });
  });

  it("should report that storage is unusable instead of failing silently", () => {
    const storage = throwingStorage();
    expect(loadDrillProgress("sha256", storage)).toEqual({
      progress: emptyProgress("sha256"),
      persisted: false,
    });
    expect(saveDrillProgress(emptyProgress("sha256"), storage)).toBe(false);
  });

  it("should keep the drill usable when storage is unusable, rather than throwing", () => {
    const storage = throwingStorage();
    expect(() => loadDrillProgress("sha256", storage)).not.toThrow();
    expect(() => saveDrillProgress(emptyProgress("sha256"), storage)).not.toThrow();
  });

  it("should default to the browser localStorage when no storage is injected", () => {
    const progress = recordAttempt(emptyProgress("sha256"), "utf8-hex", true);
    expect(saveDrillProgress(progress)).toBe(true);
    expect(loadDrillProgress("sha256")).toEqual({ progress, persisted: true });
    window.localStorage.clear();
  });
});
