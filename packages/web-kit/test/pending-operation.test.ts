import { describe, expect, it } from "vitest";
import { PendingOperation } from "../src/pending-operation";

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
