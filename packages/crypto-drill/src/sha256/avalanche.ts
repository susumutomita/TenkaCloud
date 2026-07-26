/**
 * Avalanche Effect の観察用に、2 つの 16 進ダイジェストの差を数える。
 *
 * 「1 bit 変えたら出力の約半分が変わる」を主張だけで終わらせず、実際に何 bit 変わったかを
 * 数えて見せるための最小道具。UI 側の桁ハイライトも同じ関数から作る (表示と数値が
 * 別経路になると、色が付いている桁数と「N bit 変化」が食い違う)。
 */

const HEX_DIGIT = /^[0-9a-f]$/;

/** 16 進 1 桁の中で立っている bit 数。 */
function popcountNibble(digit: string): number {
  return Number.parseInt(digit, 16).toString(2).replace(/0/g, "").length;
}

/** 長さの違う入力は比較しない (=ダイジェスト同士の比較しか意味がない)。 */
function assertComparable(left: string, right: string): void {
  if (left.length !== right.length) {
    throw new Error("hex digests must have the same length to compare");
  }
  for (const digit of left + right) {
    if (!HEX_DIGIT.test(digit)) throw new Error(`not a lowercase hex digest: ${digit}`);
  }
}

/** 桁ごとに「異なるか」を返す (UI のハイライト用)。 */
export function nibbleDiffFlags(left: string, right: string): readonly boolean[] {
  assertComparable(left, right);
  return Array.from(left, (digit, index) => digit !== right[index]);
}

export interface DigestDiff {
  readonly totalBits: number;
  readonly differingBits: number;
  readonly differingNibbles: number;
}

/** 2 つのダイジェストの差を bit 単位と 16 進桁単位で数える。 */
export function digestDiff(left: string, right: string): DigestDiff {
  assertComparable(left, right);
  let differingBits = 0;
  let differingNibbles = 0;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (a === b) continue;
    differingNibbles += 1;
    differingBits += popcountNibble((Number.parseInt(a, 16) ^ Number.parseInt(b, 16)).toString(16));
  }
  return { totalBits: left.length * 4, differingBits, differingNibbles };
}
