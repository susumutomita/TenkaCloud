import { describe, expect, it } from "vitest";
import { INITIAL_HASH } from "../src/sha256/constants";
import { blockToWords, padMessage } from "../src/sha256/padding";
import {
  compressRound,
  expandSchedule,
  labelState,
  sha256Hex,
  stateToDigest,
  traceSha256,
} from "../src/sha256/trace";
import { toHex32, utf8Encode } from "../src/sha256/word";

/** RFC 6234 / NIST の既知テストベクタ。 */
const KNOWN_VECTORS: readonly (readonly [string, string])[] = [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ["abd", "a52d159f262b2c6ddb724a61840befc36eb30c88877a4030b65cbe86298449c9"],
  ["hello world", "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"],
  ["a".repeat(55), "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318"],
  ["a".repeat(56), "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a"],
  ["a".repeat(64), "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb"],
  ["天下クラウド", "0095b9331d3b21999a68b0e0fccf054f3649e1ae68ee4f69a648c1f258b642fa"],
];

describe("SHA-256 reference trace", () => {
  it.each(KNOWN_VECTORS)("should hash %j to the published digest", (input, digest) => {
    expect(sha256Hex(input)).toBe(digest);
  });

  it("should expose the padded message and its bit length", () => {
    const trace = traceSha256("abc");
    expect(trace.input).toBe("abc");
    expect(Array.from(trace.message)).toEqual([0x61, 0x62, 0x63]);
    expect(trace.messageBitLength).toBe(24);
    expect(trace.padded).toHaveLength(64);
    expect(trace.blocks).toHaveLength(1);
  });

  it("should count bytes, not characters, for multi-byte input", () => {
    const trace = traceSha256("天下クラウド");
    expect(trace.message).toHaveLength(18);
    expect(trace.messageBitLength).toBe(144);
  });

  it("should chain the hash state across blocks", () => {
    const trace = traceSha256("a".repeat(64));
    expect(trace.blocks).toHaveLength(2);
    expect(trace.blocks[0]?.hashBefore).toEqual([...INITIAL_HASH]);
    expect(trace.blocks[1]?.hashBefore).toEqual(trace.blocks[0]?.hashAfter);
    expect(trace.hash).toEqual(trace.blocks[1]?.hashAfter);
  });

  it("should derive W16 and W17 for abc as the schedule specifies", () => {
    const { words, steps } = expandSchedule(blockToWords(padMessage(utf8Encode("abc"))));
    expect(words).toHaveLength(64);
    expect(steps).toHaveLength(48);
    expect(toHex32(words[16] ?? 0)).toBe("61626380");
    expect(toHex32(words[17] ?? 0)).toBe("000f0000");
    expect(toHex32(words[63] ?? 0)).toBe("12b1edeb");
  });

  it("should expose every input of a schedule step", () => {
    const { steps } = expandSchedule(blockToWords(padMessage(utf8Encode("abc"))));
    const first = steps[0];
    expect(first?.index).toBe(16);
    expect(first?.wMinus16).toBe(0x61626380);
    expect(first?.wMinus15).toBe(0);
    expect(first?.wMinus7).toBe(0);
    expect(first?.wMinus2).toBe(0);
    expect(first?.sigma0).toBe(0);
    expect(first?.sigma1).toBe(0);
    expect(first?.result).toBe(0x61626380);
    expect(steps[steps.length - 1]?.index).toBe(63);
  });

  it("should refuse a block that is not exactly 16 words", () => {
    expect(() => expandSchedule([])).toThrow("exactly 16 words");
    expect(() => expandSchedule(new Array(17).fill(0))).toThrow("exactly 16 words");
  });

  it("should expand an all-zero block to an all-zero schedule", () => {
    const { words } = expandSchedule(new Array(16).fill(0));
    expect(words).toHaveLength(64);
    expect(words.every((w) => w === 0)).toBe(true);
  });

  it("should expose T1, T2 and the shifted state of round 0 for abc", () => {
    const trace = traceSha256("abc");
    const round = trace.blocks[0]?.rounds[0];
    expect(round?.index).toBe(0);
    expect(round?.before).toEqual([...INITIAL_HASH]);
    expect(toHex32(round?.k ?? 0)).toBe("428a2f98");
    expect(toHex32(round?.w ?? 0)).toBe("61626380");
    expect(toHex32(round?.bigSigma1 ?? 0)).toBe("3587272b");
    expect(toHex32(round?.ch ?? 0)).toBe("1f85c98c");
    expect(toHex32(round?.t1 ?? 0)).toBe("54da50e8");
    expect(toHex32(round?.bigSigma0 ?? 0)).toBe("ce20b47e");
    expect(toHex32(round?.maj ?? 0)).toBe("3a6fe667");
    expect(toHex32(round?.t2 ?? 0)).toBe("08909ae5");
    expect(toHex32(round?.after[0] ?? 0)).toBe("5d6aebcd");
    expect(toHex32(round?.after[4] ?? 0)).toBe("fa2a4622");
  });

  it("should shift b..d and f..h down by one register each round", () => {
    const trace = traceSha256("abc");
    const round = trace.blocks[0]?.rounds[7];
    const before = round?.before ?? [];
    const after = round?.after ?? [];
    expect(after[1]).toBe(before[0]);
    expect(after[2]).toBe(before[1]);
    expect(after[3]).toBe(before[2]);
    expect(after[5]).toBe(before[4]);
    expect(after[6]).toBe(before[5]);
    expect(after[7]).toBe(before[6]);
  });

  it("should run 64 rounds per block and chain each round to the next", () => {
    const trace = traceSha256("abc");
    const rounds = trace.blocks[0]?.rounds ?? [];
    expect(rounds).toHaveLength(64);
    for (let i = 1; i < rounds.length; i += 1) {
      expect(rounds[i]?.before).toEqual(rounds[i - 1]?.after);
    }
  });

  it("should allow a round constant override for a hand-built round", () => {
    const round = compressRound([...INITIAL_HASH], 0, 0, 0);
    expect(round.k).toBe(0);
    expect(round.w).toBe(0);
  });

  it("should treat a short state as zeros so a partial hand-built state is inspectable", () => {
    const round = compressRound([], 0, 0, 0);
    expect(round.t1).toBe(0);
    expect(round.t2).toBe(0);
    expect(round.after).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("should render the final state as 64 hex characters", () => {
    expect(stateToDigest(traceSha256("abc").hash)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(stateToDigest([])).toBe("");
  });

  it("should label the eight state words a..h", () => {
    const labelled = labelState(traceSha256("abc").hash);
    expect(labelled.map((entry) => entry.label)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    expect(toHex32(labelled[0]?.word ?? 0)).toBe("ba7816bf");
  });

  it("should fill absent state words with zero when labelling", () => {
    expect(labelState([]).every((entry) => entry.word === 0)).toBe(true);
  });
});
