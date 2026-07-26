import { describe, expect, it } from "vitest";
import { bigSigma0, bigSigma1, ch, maj, smallSigma0, smallSigma1 } from "../src/sha256/functions";
import { rotr32, shr32, toBinary32, toHex32 } from "../src/sha256/word";

describe("SHA-256 bit functions", () => {
  it("should let Ch pick y where x is 1 and z where x is 0", () => {
    expect(ch(0xffffffff, 0xaaaaaaaa, 0x55555555)).toBe(0xaaaaaaaa);
    expect(ch(0x00000000, 0xaaaaaaaa, 0x55555555)).toBe(0x55555555);
    expect(toHex32(ch(0x510e527f, 0x9b05688c, 0x1f83d9ab))).toBe("1f85c98c");
  });

  it("should let Maj take the per-bit majority", () => {
    expect(maj(0xffffffff, 0xffffffff, 0x00000000)).toBe(0xffffffff);
    expect(maj(0xffffffff, 0x00000000, 0x00000000)).toBe(0x00000000);
    expect(toHex32(maj(0x6a09e667, 0xbb67ae85, 0x3c6ef372))).toBe("3a6fe667");
  });

  it("should make Maj independent of argument order", () => {
    const [x, y, z] = [0x12345678, 0x9abcdef0, 0x0f0f0f0f];
    expect(maj(x, y, z)).toBe(maj(z, y, x));
    expect(maj(x, y, z)).toBe(maj(y, x, z));
  });

  it("should compute the message-schedule sigmas with one SHR term", () => {
    expect(toHex32(smallSigma0(0x6a09e667))).toBe("ba0cf582");
    expect(toHex32(smallSigma1(0x6a09e667))).toBe("cfe5da3c");
    expect(smallSigma0(0)).toBe(0);
    expect(smallSigma1(0)).toBe(0);
  });

  it("should compute the compression sigmas from three rotations", () => {
    expect(toHex32(bigSigma0(0x6a09e667))).toBe("ce20b47e");
    expect(toHex32(bigSigma1(0x510e527f))).toBe("3587272b");
  });

  it("should differ between the small and big sigma of the same input", () => {
    const x = 0x6a09e667;
    expect(smallSigma0(x)).not.toBe(bigSigma0(x));
    expect(smallSigma1(x)).not.toBe(bigSigma1(x));
  });

  it("should keep the big sigmas bijective on all-ones, unlike the small ones", () => {
    // ROTR のみで作る Σ は 1 の個数を保つ。 SHR を含む σ は上位 bit を捨てるので保たない。
    expect(bigSigma0(0xffffffff)).toBe(0xffffffff);
    expect(bigSigma1(0xffffffff)).toBe(0xffffffff);
    expect(smallSigma0(0xffffffff)).not.toBe(0xffffffff);
    expect(smallSigma1(0xffffffff)).not.toBe(0xffffffff);
  });

  it("should reduce σ1 of all-ones to SHR^10 alone, leaving ones only in the low 22 bits", () => {
    // 節 5 のヒント 2 が説明している導出そのもの: 全 1 では ROTR^17 と ROTR^19 が
    // どちらも全 1 なので XOR で消え、 SHR^10 だけが残る。 ヒントの記述が逆向きに
    // なっていないことをここで固定する (教材の誤りは学習者の検算を狂わせる)。
    expect(rotr32(0xffffffff, 17)).toBe(0xffffffff);
    expect(rotr32(0xffffffff, 19)).toBe(0xffffffff);
    expect(smallSigma1(0xffffffff)).toBe(shr32(0xffffffff, 10));
    expect(toHex32(smallSigma1(0xffffffff))).toBe("003fffff");
    expect(toBinary32(smallSigma1(0xffffffff))).toBe("00000000001111111111111111111111");
  });
});
