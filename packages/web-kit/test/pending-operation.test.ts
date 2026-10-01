import { afterEach, describe, expect, it, vi } from "vitest";
import { newOperationKey, PendingOperation } from "../src/pending-operation";

describe("PendingOperation", () => {
  const operation = () => {
    let next = 0;
    return new PendingOperation(() => `operation-${++next}`);
  };
  it("retains a key for an unacknowledged retry but gives an intentional next submission a new key", () => {
    const pending = operation();
    const key = pending.keyFor("team-a", { answer: "wrong" });
    expect(pending.keyFor("team-a", { answer: "wrong" })).toBe(key);
    pending.acknowledge(key);
    expect(pending.keyFor("team-a", { answer: "wrong" })).not.toBe(key);
  });
  it("does not reuse an operation for changed content or another environment/team", () => {
    const pending = operation();
    const first = pending.keyFor("team-a", { answer: "one" });
    const edited = pending.keyFor("team-a", { answer: "two" });
    const switched = pending.keyFor("team-b", { answer: "two" });
    expect(new Set([first, edited, switched]).size).toBe(3);
    pending.acknowledge(first);
    expect(pending.keyFor("team-b", { answer: "two" })).toBe(switched);
  });
  it("never persists operation identity and rejects an unserializable payload", () => {
    const pending = operation();
    expect(() => pending.keyFor("scope", undefined)).toThrow("JSON serializable");
    expect(pending.keyFor("scope", {})).toBe("operation-1");
  });
});

describe("browser operation key generation", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("works when HTTP LAN crypto exposes getRandomValues but no randomUUID", () => {
    const random = vi.fn((bytes: Uint8Array) => {
      for (let i = 0; i < bytes.length; i++) bytes[i] = i;
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues: random });
    expect(newOperationKey()).toBe("000102030405060708090a0b0c0d0e0f");
    expect(new PendingOperation().keyFor("team", {})).toMatch(/^[a-f0-9]{32}$/u);
    expect(random).toHaveBeenCalledTimes(2);
    expect(random.mock.calls[0]?.[0].byteLength).toBe(16);
  });
  it("uses the browser's secure randomness and does not reuse a generated key", () => {
    const first = newOperationKey();
    expect(first).toMatch(/^[a-f0-9]{32}$/u);
    expect(newOperationKey()).not.toBe(first);
  });
  it("fails rather than using weak randomness when the browser RNG is missing", () => {
    vi.stubGlobal("crypto", {});
    expect(() => newOperationKey()).toThrow();
  });
});
