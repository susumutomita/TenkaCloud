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
    expect(loadDrillProgress("sha256", memoryStorage())).toEqual(emptyProgress("sha256"));
  });

  it("should round-trip saved progress", () => {
    const storage = memoryStorage();
    const progress = recordAttempt(emptyProgress(SHA256_DRILL.id), "utf8-hex", true);
    saveDrillProgress(progress, storage);
    expect(storage.entries.get(drillStorageKey(SHA256_DRILL.id))).toBe(serializeProgress(progress));
    expect(loadDrillProgress(SHA256_DRILL.id, storage)).toEqual(progress);
  });

  it("should fall back to empty progress for a corrupted or foreign stored value", () => {
    const corrupted = memoryStorage({ [drillStorageKey("sha256")]: "{not json" });
    expect(loadDrillProgress("sha256", corrupted)).toEqual(emptyProgress("sha256"));

    const foreign = memoryStorage({
      [drillStorageKey("sha256")]: serializeProgress(emptyProgress("hmac")),
    });
    expect(loadDrillProgress("sha256", foreign)).toEqual(emptyProgress("sha256"));
  });

  it("should keep working when storage is unavailable", () => {
    const storage = throwingStorage();
    expect(loadDrillProgress("sha256", storage)).toEqual(emptyProgress("sha256"));
    expect(() => saveDrillProgress(emptyProgress("sha256"), storage)).not.toThrow();
  });

  it("should default to the browser localStorage when no storage is injected", () => {
    const progress = recordAttempt(emptyProgress("sha256"), "utf8-hex", true);
    saveDrillProgress(progress);
    expect(loadDrillProgress("sha256")).toEqual(progress);
    window.localStorage.clear();
  });
});
