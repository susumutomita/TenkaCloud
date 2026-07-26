/**
 * 節 7〜9: Ch → Maj → Σ。
 *
 * 圧縮ラウンドが使う 4 つの関数のうち 3 つをここで揃える。Ch と Maj は真理値表を自分で
 * 埋めてから語単位で実装し、Σ は σ との回転量の違いを取り違えないことに集中する。
 */

import { answerCase, choice, hint, loc } from "../../drill/authoring";
import type { DrillSection } from "../../drill/types";
import { PRIMARY_BLOCK } from "../fixtures";
import { bigSigma0, bigSigma1, ch, maj, smallSigma0, smallSigma1 } from "../functions";
import { maskTruthOutputs, singleBitTruthRows, truthOutputColumn, wordRow } from "../visuals";
import { toHex32 } from "../word";

const CH_ROWS = singleBitTruthRows(ch);
const MAJ_ROWS = singleBitTruthRows(maj);
const ROUND0 = PRIMARY_BLOCK.rounds[0];
const [A0, B0, C0] = [ROUND0.before[0], ROUND0.before[1], ROUND0.before[2]];
const [E0, F0, G0] = [ROUND0.before[4], ROUND0.before[5], ROUND0.before[6]];
const SAMPLE = 0x6a09e667;

/** 節 7: Ch。 */
export const chSection: DrillSection = {
  id: "ch-function",
  order: 7,
  title: loc("Ch 関数 — bit で選ぶ", "The Ch function: choosing per bit"),
  goal: loc(
    "Ch(x, y, z) = (x AND y) XOR (NOT x AND z) が「x を条件に y と z を選ぶ」ことだと理解する。",
    "Understand that Ch(x, y, z) = (x AND y) XOR (NOT x AND z) selects between y and z using x as the condition.",
  ),
  reading: [
    loc(
      "Ch は choose の略で、定義は Ch(x, y, z) = (x AND y) XOR (NOT x AND z) である。式の見た目は複雑だが、動きは単純で、x の各 bit が 1 なら同じ桁の y を、0 なら同じ桁の z を採る。",
      "Ch stands for choose, and it is defined as Ch(x, y, z) = (x AND y) XOR (NOT x AND z). The formula looks busy but the behaviour is simple: where a bit of x is 1 take that bit of y, where it is 0 take that bit of z.",
    ),
    loc(
      "つまり三項演算子 `x ? y : z` を 32 桁ぶん並列に行う回路である。分岐を使わずに選択を実現しているので、入力によって実行時間が変わらない (タイミング差から秘密を推定されにくい) 利点もある。",
      "In other words it is a 32-wide parallel `x ? y : z`. Because the choice is made without branching, the running time does not depend on the data — one less side channel to leak through timing.",
    ),
    loc(
      "圧縮ラウンドでは Ch(e, f, g) の形で使われ、状態変数 e が「どちらを見るか」を決める役を担う。",
      "Inside the compression rounds it appears as Ch(e, f, g), where the state variable e decides which of the other two to look at.",
    ),
  ],
  visual: {
    kind: "truth-table",
    headers: ["x", "y", "z", "Ch"],
    rows: maskTruthOutputs(CH_ROWS),
  },
  tasks: [
    {
      id: "ch-truth-table",
      kind: "value",
      title: loc("真理値表を埋める", "Fill in the truth table"),
      instruction: loc(
        "上の表の Ch 列を、上の行から順に 8 桁の 2 進で答える (x, y, z = 000, 001, 010, ..., 111 の順)。",
        "Answer the Ch column of the table above as 8 binary digits, top row first (x, y, z = 000, 001, 010, ..., 111).",
      ),
      cases: [
        answerCase({
          id: "column",
          ja: "Ch 列 (8 行ぶん)",
          en: "The Ch column, all eight rows",
          expected: truthOutputColumn(CH_ROWS),
          format: "binary",
        }),
      ],
      hints: [
        hint(
          1,
          "x = 0 の 4 行では出力が z と一致し、x = 1 の 4 行では y と一致する。",
          "In the four rows where x = 0 the output equals z; where x = 1 it equals y.",
        ),
        hint(
          2,
          "行の順は z が最も速く変わる (000, 001, 010, 011, 100, ...)。",
          "z varies fastest across the rows: 000, 001, 010, 011, 100, and so on.",
        ),
      ],
    },
    {
      id: "ch-words",
      kind: "implementation",
      title: loc("語単位で Ch を実装する", "Implement Ch on whole words"),
      instruction: loc(
        "Ch を 32 bit 語に対して実装し、各入力に対する出力を答える。3 問目は `abc` のラウンド 0 で実際に使われる値である。",
        "Implement Ch for 32-bit words and answer each output. The third case is the value actually used in round 0 of `abc`.",
      ),
      starter: [
        "const ch = (x, y, z) => toWord((x & y) ^ (~x & z));",
        "console.log(hex(ch(0xffffffff, 0xaaaaaaaa, 0x55555555)));",
      ].join("\n"),
      cases: [
        answerCase({
          id: "all-ones",
          ja: "Ch(0xffffffff, 0xaaaaaaaa, 0x55555555)",
          en: "Ch(0xffffffff, 0xaaaaaaaa, 0x55555555)",
          expected: toHex32(ch(0xffffffff, 0xaaaaaaaa, 0x55555555)),
          format: "hex",
        }),
        answerCase({
          id: "all-zeros",
          ja: "Ch(0x00000000, 0xaaaaaaaa, 0x55555555)",
          en: "Ch(0x00000000, 0xaaaaaaaa, 0x55555555)",
          expected: toHex32(ch(0, 0xaaaaaaaa, 0x55555555)),
          format: "hex",
        }),
        answerCase({
          id: "round0",
          ja: `Ch(0x${toHex32(E0)}, 0x${toHex32(F0)}, 0x${toHex32(G0)}) — ラウンド 0 の Ch(e, f, g)`,
          en: `Ch(0x${toHex32(E0)}, 0x${toHex32(F0)}, 0x${toHex32(G0)}) — Ch(e, f, g) in round 0`,
          expected: toHex32(ch(E0, F0, G0)),
          format: "hex",
        }),
        answerCase({
          id: "mixed",
          ja: "Ch(0x0f0f0f0f, 0xffffffff, 0x00000000)",
          en: "Ch(0x0f0f0f0f, 0xffffffff, 0x00000000)",
          expected: toHex32(ch(0x0f0f0f0f, 0xffffffff, 0)),
          format: "hex",
        }),
      ],
      hints: [
        hint(
          1,
          "x が全 1 なら結果は y そのもの、全 0 なら z そのものになる。最初の 2 問はこれで即答できる。",
          "When x is all ones the result is exactly y; all zeros gives exactly z. The first two cases follow immediately.",
        ),
        hint(
          2,
          "JavaScript の `~x` は符号付きになる。`& z` の後に `>>> 0` で畳み戻す。",
          "In JavaScript `~x` is signed; fold back with `>>> 0` after the `& z`.",
        ),
      ],
    },
  ],
  explanation: [
    loc(
      "XOR ではなく OR で書いても同じ結果になる (両項が同時に 1 になることはないため) が、仕様は XOR で書かれている。定数時間で動く選択回路として読むのが理解の近道である。",
      "Writing OR instead of XOR gives the same result — the two terms are never 1 at once — but the specification uses XOR. The quickest way to read it is as a constant-time selection circuit.",
    ),
    loc(
      "Ch が「e に依存して f と g のどちらを混ぜるか変える」ことで、ラウンドごとの振る舞いが状態依存になる。ここが線形ではない (= 単純な連立方程式へ落とせない) ことが、逆算を難しくしている要素の 1 つである。",
      "Because Ch lets e decide whether f or g is mixed in, each round's behaviour depends on the state. That non-linearity — it cannot be reduced to a simple linear system — is one of the things that makes inversion hard.",
    ),
  ],
  nextStep: loc(
    "選択の Ch に続いて、多数決の Maj を見る。",
    "After Ch, the chooser, comes Maj, the voter.",
  ),
};

/** 節 8: Maj。 */
export const majSection: DrillSection = {
  id: "maj-function",
  order: 8,
  title: loc("Maj 関数 — bit の多数決", "The Maj function: a per-bit majority"),
  goal: loc(
    "Maj(x, y, z) が桁ごとの多数決であり、引数の順序に依存しないことを確認する。",
    "Confirm that Maj(x, y, z) is a per-bit majority vote and does not depend on argument order.",
  ),
  reading: [
    loc(
      "Maj は majority の略で、Maj(x, y, z) = (x AND y) XOR (x AND z) XOR (y AND z) である。同じ桁の 3 bit のうち 1 が 2 個以上あれば 1、そうでなければ 0 になる。",
      "Maj stands for majority: Maj(x, y, z) = (x AND y) XOR (x AND z) XOR (y AND z). For each bit position it is 1 when at least two of the three bits are 1.",
    ),
    loc(
      "3 つの積項の XOR という書き方は一見わかりにくいが、多数決は必ず 2 項または 3 項が同時に成立する。3 項成立時は XOR で 1 が 3 つ重なって 1 が残るため、結果として多数決と一致する。",
      "The XOR of three AND terms looks opaque, but a majority always makes either exactly two or all three terms true, and XOR-ing three ones still leaves one — so the result matches a majority vote.",
    ),
    loc(
      "Ch と違い、Maj は引数の順序を入れ替えても結果が変わらない (対称関数である)。圧縮ラウンドでは Maj(a, b, c) の形で現れる。",
      "Unlike Ch, Maj is symmetric: permuting the arguments does not change the result. In the compression rounds it appears as Maj(a, b, c).",
    ),
  ],
  visual: {
    kind: "truth-table",
    headers: ["x", "y", "z", "Maj"],
    rows: maskTruthOutputs(MAJ_ROWS),
  },
  tasks: [
    {
      id: "maj-truth-table",
      kind: "value",
      title: loc("真理値表を埋める", "Fill in the truth table"),
      instruction: loc(
        "上の表の Maj 列を、上の行から順に 8 桁の 2 進で答える。",
        "Answer the Maj column of the table above as 8 binary digits, top row first.",
      ),
      cases: [
        answerCase({
          id: "column",
          ja: "Maj 列 (8 行ぶん)",
          en: "The Maj column, all eight rows",
          expected: truthOutputColumn(MAJ_ROWS),
          format: "binary",
        }),
      ],
      hints: [
        hint(
          1,
          "1 が 2 個以上ある行だけ 1 になる。1 が 0 個か 1 個の行は 0 である。",
          "Only rows with two or three ones give 1; rows with zero or one give 0.",
        ),
        hint(
          2,
          "8 行のうち 1 になるのは 4 行である (011, 101, 110, 111)。",
          "Four of the eight rows are 1: 011, 101, 110, and 111.",
        ),
      ],
    },
    {
      id: "maj-words",
      kind: "implementation",
      title: loc("語単位で Maj を実装する", "Implement Maj on whole words"),
      instruction: loc(
        "Maj を 32 bit 語に対して実装し、各入力に対する出力を答える。最後の 2 問は引数の順序を入れ替えた同じ組で、対称性の確認になる。",
        "Implement Maj for 32-bit words and answer each output. The last two cases are the same triple in a different order — a check on symmetry.",
      ),
      starter: [
        "const maj = (x, y, z) => toWord((x & y) ^ (x & z) ^ (y & z));",
        "console.log(hex(maj(0x6a09e667, 0xbb67ae85, 0x3c6ef372)));",
      ].join("\n"),
      cases: [
        answerCase({
          id: "round0",
          ja: `Maj(0x${toHex32(A0)}, 0x${toHex32(B0)}, 0x${toHex32(C0)}) — ラウンド 0 の Maj(a, b, c)`,
          en: `Maj(0x${toHex32(A0)}, 0x${toHex32(B0)}, 0x${toHex32(C0)}) — Maj(a, b, c) in round 0`,
          expected: toHex32(maj(A0, B0, C0)),
          format: "hex",
        }),
        answerCase({
          id: "two-of-three",
          ja: "Maj(0xffffffff, 0xffffffff, 0x00000000)",
          en: "Maj(0xffffffff, 0xffffffff, 0x00000000)",
          expected: toHex32(maj(0xffffffff, 0xffffffff, 0)),
          format: "hex",
        }),
        answerCase({
          id: "one-of-three",
          ja: "Maj(0xffffffff, 0x00000000, 0x00000000)",
          en: "Maj(0xffffffff, 0x00000000, 0x00000000)",
          expected: toHex32(maj(0xffffffff, 0, 0)),
          format: "hex",
        }),
        answerCase({
          id: "swapped",
          ja: `Maj(0x${toHex32(C0)}, 0x${toHex32(B0)}, 0x${toHex32(A0)}) — 引数を逆順にしたもの`,
          en: `Maj(0x${toHex32(C0)}, 0x${toHex32(B0)}, 0x${toHex32(A0)}) — the arguments reversed`,
          expected: toHex32(maj(C0, B0, A0)),
          format: "hex",
        }),
      ],
      hints: [
        hint(
          1,
          "2 つが全 1 なら結果は全 1、1 つだけ全 1 なら結果は全 0 になる。",
          "Two all-ones arguments give all ones; a single all-ones argument gives all zeros.",
        ),
        hint(
          2,
          "最後の 2 問の答えが違ったら、実装が対称になっていない (項の書き落としがある)。",
          "If the last two answers differ, your implementation is not symmetric — a term is missing.",
        ),
      ],
    },
  ],
  explanation: [
    loc(
      "Maj は a, b, c という 3 世代前までの状態を 1 語へ畳み込む。ラウンドごとに状態が 1 つずつ後ろへずれていく構造 (次節以降) と組み合わさることで、過去の状態が長く影響し続ける。",
      "Maj folds three generations of state — a, b, c — into one word. Combined with the per-round shift of the state registers (next sections), it keeps older state influencing the computation for a long time.",
    ),
    loc(
      "Ch が「状態に応じて選ぶ」非線形性を、Maj が「過去を混ぜる」拡散を担っている。この 2 つは役割が違うので、片方だけ実装しても最終ハッシュは一致しない。",
      "Ch supplies state-dependent non-linearity while Maj supplies diffusion of past state. They play different roles, so getting only one right still yields the wrong digest.",
    ),
  ],
  nextStep: loc(
    "選択と多数決が揃った。次は圧縮ラウンド用の Σ 関数で、σ との違いに注意する。",
    "With choose and majority in place, next are the Σ functions for the rounds — watch the difference from σ.",
  ),
};

/** 節 9: Σ0 / Σ1。 */
export const bigSigmaSection: DrillSection = {
  id: "big-sigma",
  order: 9,
  title: loc("Σ0 と Σ1 — σ との違い", "Σ0 and Σ1, and how they differ from σ"),
  goal: loc(
    "Σ が ROTR 3 回だけで作られ、σ (ROTR 2 回 + SHR 1 回) とは別関数であることを確認する。",
    "Confirm that Σ is built from three ROTRs alone, making it a different function from σ (two ROTRs plus one SHR).",
  ),
  reading: [
    loc(
      "Σ0(x) = ROTR^2(x) ⊕ ROTR^13(x) ⊕ ROTR^22(x)、Σ1(x) = ROTR^6(x) ⊕ ROTR^11(x) ⊕ ROTR^25(x)。σ と違い SHR を含まず、3 つとも回転である。",
      "Σ0(x) = ROTR^2(x) ⊕ ROTR^13(x) ⊕ ROTR^22(x) and Σ1(x) = ROTR^6(x) ⊕ ROTR^11(x) ⊕ ROTR^25(x). Unlike σ there is no SHR — all three terms are rotations.",
    ),
    loc(
      "この差には意味がある。message schedule では入力を「薄く伸ばす」ため情報を落とす SHR が混ざっているが、圧縮ラウンドでは状態を撹拌するのが目的で、bit を捨てる必要がない。",
      "The difference is meaningful. The schedule stretches the input thin, so discarding information with SHR is acceptable; the rounds stir the state, where there is no reason to throw bits away.",
    ),
    loc(
      "実装上の落とし穴は、σ と Σ で回転量を混同することである。名前も似ていて引数の形も同じなので、コード上では取り違えても文法エラーにならない。最終ハッシュだけが一致しないという症状で現れる。",
      "The practical trap is swapping the rotation amounts between σ and Σ. The names are similar and the signatures identical, so the mistake is not a syntax error — it shows up only as a wrong final digest.",
    ),
  ],
  visual: {
    kind: "words",
    rows: [
      wordRow("x", SAMPLE),
      wordRow(
        "σ0(x)",
        smallSigma0(SAMPLE),
        loc("ROTR^7 / ROTR^18 / SHR^3。", "ROTR^7 / ROTR^18 / SHR^3."),
      ),
      wordRow(
        "Σ0(x)",
        bigSigma0(SAMPLE),
        loc("ROTR^2 / ROTR^13 / ROTR^22。", "ROTR^2 / ROTR^13 / ROTR^22."),
      ),
      wordRow("σ1(x)", smallSigma1(SAMPLE)),
      wordRow("Σ1(x)", bigSigma1(SAMPLE)),
    ],
  },
  tasks: [
    {
      id: "big-sigma-values",
      kind: "implementation",
      title: loc("Σ0 / Σ1 を実装する", "Implement Σ0 and Σ1"),
      instruction: loc(
        "Σ0 / Σ1 を実装し、各入力に対する出力を答える。最後の 2 問は `abc` のラウンド 0 で実際に使われる値である。",
        "Implement Σ0 and Σ1 and answer each output. The last two cases are the values actually used in round 0 of `abc`.",
      ),
      starter: [
        "const S0 = (x) => toWord(rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22));",
        "const S1 = (x) => toWord(rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25));",
        "console.log(hex(S0(0x6a09e667)), hex(S1(0x510e527f)));",
      ].join("\n"),
      cases: [
        answerCase({
          id: "sigma0-sample",
          ja: "Σ0(0x6a09e667)",
          en: "Σ0(0x6a09e667)",
          expected: toHex32(bigSigma0(SAMPLE)),
          format: "hex",
        }),
        answerCase({
          id: "sigma1-sample",
          ja: "Σ1(0x6a09e667)",
          en: "Σ1(0x6a09e667)",
          expected: toHex32(bigSigma1(SAMPLE)),
          format: "hex",
        }),
        answerCase({
          id: "sigma0-ones",
          ja: "Σ0(0xffffffff)",
          en: "Σ0(0xffffffff)",
          expected: toHex32(bigSigma0(0xffffffff)),
          format: "hex",
        }),
        answerCase({
          id: "sigma0-a",
          ja: `Σ0(0x${toHex32(A0)}) — ラウンド 0 の Σ0(a)`,
          en: `Σ0(0x${toHex32(A0)}) — Σ0(a) in round 0`,
          expected: toHex32(bigSigma0(A0)),
          format: "hex",
        }),
        answerCase({
          id: "sigma1-e",
          ja: `Σ1(0x${toHex32(E0)}) — ラウンド 0 の Σ1(e)`,
          en: `Σ1(0x${toHex32(E0)}) — Σ1(e) in round 0`,
          expected: toHex32(bigSigma1(E0)),
          format: "hex",
        }),
      ],
      hints: [
        hint(
          1,
          "Σ0(0xffffffff) は 0xffffffff になる。ROTR は 1 の個数を変えず、全 1 を 3 回 XOR すると全 1 が残る。",
          "Σ0(0xffffffff) is 0xffffffff: ROTR preserves the set bits, and XOR-ing all-ones three times leaves all ones.",
        ),
        hint(
          2,
          "σ0 と同じ値が出たら回転量が 7 / 18 / 3 のままになっている。Σ0 は 2 / 13 / 22 である。",
          "If you get the same value as σ0, you are still using 7 / 18 / 3. Σ0 uses 2 / 13 / 22.",
        ),
      ],
    },
    {
      id: "sigma-vs-big-sigma",
      kind: "choice",
      multi: true,
      title: loc("σ と Σ の違いを選ぶ", "Pick the differences between σ and Σ"),
      instruction: loc(
        "σ (小文字) と Σ (大文字) について正しい記述をすべて選ぶ。",
        "Select every statement that is true about σ (lowercase) and Σ (uppercase).",
      ),
      choices: [
        choice({
          id: "sigma-has-shr",
          ja: "σ は SHR を 1 つ含むが、Σ は ROTR だけで作られる",
          en: "σ contains one SHR, while Σ is built from ROTR only",
          correct: true,
          rationaleJa: "σ0 は ROTR^7 / ROTR^18 / SHR^3、Σ0 は ROTR^2 / ROTR^13 / ROTR^22 である。",
          rationaleEn: "σ0 is ROTR^7 / ROTR^18 / SHR^3; Σ0 is ROTR^2 / ROTR^13 / ROTR^22.",
        }),
        choice({
          id: "sigma-in-schedule",
          ja: "σ は message schedule で、Σ は圧縮ラウンドで使われる",
          en: "σ is used in the message schedule and Σ inside the compression rounds",
          correct: true,
          rationaleJa: "使われる場所が違うので、片方を他方で代用することはできない。",
          rationaleEn: "They are used in different places, so one cannot substitute for the other.",
        }),
        choice({
          id: "same-rotations",
          ja: "σ と Σ は回転量が同じで、名前だけが違う",
          en: "σ and Σ use the same rotation amounts and differ only in name",
          correct: false,
          rationaleJa:
            "回転量は 7/18/3 と 2/13/22 のように別である。取り違えると最終ハッシュが合わない。",
          rationaleEn:
            "The amounts differ — 7/18/3 versus 2/13/22. Swap them and the final digest is wrong.",
        }),
        choice({
          id: "sigma-loses-bits",
          ja: "Σ は情報を落とさないが、σ は SHR で一部の bit を捨てる",
          en: "Σ loses no information, whereas σ discards some bits through SHR",
          correct: true,
          rationaleJa: "ROTR のみの Σ は全単射で、SHR を含む σ はそうでない。",
          rationaleEn: "Built from ROTR alone Σ is a bijection; σ, which includes SHR, is not.",
        }),
      ],
      hints: [
        hint(
          1,
          "定義式を並べて、SHR が出てくるのがどちらかを確認する。",
          "Put the definitions side by side and see which one mentions SHR.",
        ),
      ],
    },
  ],
  explanation: [
    loc(
      "Σ が全単射である一方、圧縮ラウンド全体は全単射ではない。最後に「入力状態を足す」段があり (節 12)、そこで情報が落ちる。片方向性はラウンド関数そのものではなく、この足し込みから来ている。",
      "Σ is a bijection, but the compression function as a whole is not: a final step adds the input state back in (section 12) and information is lost there. The one-way property comes from that addition, not from the round function itself.",
    ),
    loc(
      "つまり「回して XOR しているから戻せない」わけではない。どこで情報が落ちているのかを指せるかが、ハッシュ関数を理解しているかの分かれ目である。",
      'So it is not "you cannot invert it because it rotates and XORs". Being able to point at where information is actually lost is what separates understanding from hand-waving.',
    ),
  ],
  nextStep: loc(
    "4 つの関数が揃った。次はこれらを組んで 1 ラウンドを回す。",
    "All four functions are ready. Next we assemble them into a single round.",
  ),
};
