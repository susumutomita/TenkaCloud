import { describe, expect, it } from "vitest";
import {
  blockToWords,
  paddedLength,
  padMessage,
  splitBlocks,
  zeroPaddingLength,
} from "../src/sha256/padding";
import { bytesToHex, toHex32, utf8Encode } from "../src/sha256/word";

describe("SHA-256 padding", () => {
  it("should round every length up to a multiple of 64 bytes", () => {
    expect(paddedLength(0)).toBe(64);
    expect(paddedLength(3)).toBe(64);
    expect(paddedLength(55)).toBe(64);
    expect(paddedLength(56)).toBe(128);
    expect(paddedLength(64)).toBe(128);
    expect(paddedLength(119)).toBe(128);
    expect(paddedLength(120)).toBe(192);
  });

  it("should treat 55 bytes as the last length that fits in one block", () => {
    expect(zeroPaddingLength(55)).toBe(0);
    expect(zeroPaddingLength(56)).toBe(63);
    expect(zeroPaddingLength(0)).toBe(55);
  });

  it("should append 0x80, then zeros, then the 64-bit big-endian bit length", () => {
    const padded = padMessage(utf8Encode("abc"));
    expect(padded).toHaveLength(64);
    expect(bytesToHex(padded)).toBe(
      "6162638000000000000000000000000000000000000000000000000000000000" +
        "0000000000000000000000000000000000000000000000000000000000000018",
    );
  });

  it("should pad the empty message to a single block of only padding", () => {
    const padded = padMessage(new Uint8Array());
    expect(padded[0]).toBe(0x80);
    expect(padded[63]).toBe(0);
    expect(padded.slice(1).every((b) => b === 0)).toBe(true);
  });

  it("should record the length in bits, not bytes", () => {
    const padded = padMessage(utf8Encode("a".repeat(56)));
    expect(padded).toHaveLength(128);
    // 56 byte = 448 bit = 0x01c0。
    expect(padded[126]).toBe(0x01);
    expect(padded[127]).toBe(0xc0);
  });

  it("should keep the upper length bytes at zero for drill-sized inputs", () => {
    const padded = padMessage(utf8Encode("abc"));
    expect(Array.from(padded.slice(56, 62))).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("should split the padded message into 64-byte blocks", () => {
    const blocks = splitBlocks(padMessage(utf8Encode("a".repeat(64))));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toHaveLength(64);
    expect(blocks[1]).toHaveLength(64);
  });

  it("should read a block as 16 big-endian words", () => {
    const words = blockToWords(padMessage(utf8Encode("abc")));
    expect(words).toHaveLength(16);
    expect(toHex32(words[0] ?? 0)).toBe("61626380");
    expect(words[15]).toBe(0x18);
  });
});
