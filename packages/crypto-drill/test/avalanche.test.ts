import { describe, expect, it } from "vitest";
import { digestDiff, nibbleDiffFlags } from "../src/sha256/avalanche";
import { sha256Hex } from "../src/sha256/trace";

const ABC = sha256Hex("abc");
const ABD = sha256Hex("abd");

describe("digest diff", () => {
  it("should report no difference for identical digests", () => {
    expect(digestDiff(ABC, ABC)).toEqual({
      totalBits: 256,
      differingBits: 0,
      differingNibbles: 0,
    });
  });

  it("should count roughly half the bits as changed for a one-character change", () => {
    const diff = digestDiff(ABC, ABD);
    expect(diff.totalBits).toBe(256);
    expect(diff.differingBits).toBe(122);
    expect(diff.differingNibbles).toBe(58);
  });

  it("should count fewer differing digits than differing bits", () => {
    const diff = digestDiff(ABC, ABD);
    expect(diff.differingNibbles).toBeLessThan(diff.differingBits);
  });

  it("should count every bit when one digest is all zeros and the other all ones", () => {
    expect(digestDiff("0", "f")).toEqual({ totalBits: 4, differingBits: 4, differingNibbles: 1 });
  });

  it("should flag exactly the differing hex digits", () => {
    expect(nibbleDiffFlags("abcd", "abce")).toEqual([false, false, false, true]);
    expect(nibbleDiffFlags(ABC, ABC).every((flag) => !flag)).toBe(true);
    expect(nibbleDiffFlags(ABC, ABD).filter(Boolean)).toHaveLength(58);
  });

  it("should refuse inputs that are not comparable lowercase hex", () => {
    expect(() => digestDiff("abc", "abcd")).toThrow("same length");
    expect(() => nibbleDiffFlags("abc", "abcd")).toThrow("same length");
    expect(() => digestDiff("abg", "abc")).toThrow("not a lowercase hex digest");
    expect(() => digestDiff("ABC", "abc")).toThrow("not a lowercase hex digest");
  });
});
