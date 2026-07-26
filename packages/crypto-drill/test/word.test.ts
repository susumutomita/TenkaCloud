import { describe, expect, it } from "vitest";
import {
  add32,
  bytesToBinary,
  bytesToHex,
  byteToBinary,
  byteToHex,
  readWordBE,
  rotr32,
  shr32,
  toBinary32,
  toHex32,
  toWord,
  utf8Encode,
  writeWordBE,
} from "../src/sha256/word";

describe("32 bit word operations", () => {
  it("should fold negative bitwise results back to unsigned", () => {
    expect(toWord(-1)).toBe(0xffffffff);
    expect(toWord(0x80000000)).toBe(0x80000000);
  });

  it("should rotate the low bits around to the top for ROTR", () => {
    expect(toHex32(rotr32(0x6a09e667, 7))).toBe("ced413cc");
    expect(rotr32(0x00000001, 1)).toBe(0x80000000);
  });

  it("should treat a rotation of 0 or 32 as identity", () => {
    expect(rotr32(0x12345678, 0)).toBe(0x12345678);
    expect(rotr32(0x12345678, 32)).toBe(0x12345678);
  });

  it("should discard the low bits for SHR instead of rotating them", () => {
    expect(toHex32(shr32(0x6a09e667, 3))).toBe("0d413ccc");
    expect(shr32(0x00000001, 1)).toBe(0);
  });

  it("should return 0 when SHR shifts the whole word away", () => {
    expect(shr32(0xffffffff, 32)).toBe(0);
    expect(shr32(0xffffffff, 40)).toBe(0);
  });

  it("should add modulo 2^32 rather than overflowing into a float", () => {
    expect(add32(0xffffffff, 1)).toBe(0);
    expect(add32(0xffffffff, 0xffffffff)).toBe(0xfffffffe);
    expect(add32()).toBe(0);
    expect(add32(1, 2, 3, 4, 5)).toBe(15);
  });

  it("should render words zero-padded to their full width", () => {
    expect(toHex32(0x18)).toBe("00000018");
    expect(toBinary32(0x18)).toBe("00000000000000000000000000011000");
    expect(byteToHex(0x8)).toBe("08");
    expect(byteToBinary(0x8)).toBe("00001000");
  });

  it("should mask values wider than a byte when rendering bytes", () => {
    expect(byteToHex(0x1ff)).toBe("ff");
    expect(byteToBinary(0x1ff)).toBe("11111111");
  });

  it("should render byte arrays as concatenated hex and binary", () => {
    const bytes = new Uint8Array([0x61, 0x62, 0x63]);
    expect(bytesToHex(bytes)).toBe("616263");
    expect(bytesToBinary(bytes)).toBe("011000010110001001100011");
  });

  it("should read four bytes big-endian, most significant byte first", () => {
    const bytes = new Uint8Array([0x61, 0x62, 0x63, 0x80]);
    expect(toHex32(readWordBE(bytes, 0))).toBe("61626380");
  });

  it("should read absent trailing bytes as zero", () => {
    expect(toHex32(readWordBE(new Uint8Array([0x61]), 0))).toBe("61000000");
    expect(readWordBE(new Uint8Array(), 0)).toBe(0);
  });

  it("should write a word back as four big-endian bytes", () => {
    const target = new Uint8Array(4);
    writeWordBE(target, 0, 0x61626380);
    expect(Array.from(target)).toEqual([0x61, 0x62, 0x63, 0x80]);
  });

  it("should encode text as UTF-8 bytes, not UTF-16 code units", () => {
    expect(Array.from(utf8Encode("abc"))).toEqual([0x61, 0x62, 0x63]);
    expect(utf8Encode("天").length).toBe(3);
    expect(bytesToHex(utf8Encode("天"))).toBe("e5a4a9");
  });
});
