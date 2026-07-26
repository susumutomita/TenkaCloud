/**
 * 節 4〜6: ROTR / SHR → σ 関数 → message schedule。
 *
 * この 3 節で「16 語を 64 語へ伸ばす」までを自力で計算できる状態にする。SHA-256 の
 * 実装バグはここに集中する: ROTR と SHR の混同、σ と Σ の取り違え、W[i-16] と W[i-15] の
 * 添字ずれ。いずれも最終ハッシュだけが合わない形で現れ、原因が見えにくい。
 */

import { answerCase, hint, loc } from "../../drill/authoring";
import type { DrillSection } from "../../drill/types";
import { PRIMARY_BLOCK, TWO_BLOCK_TRACE } from "../fixtures";
import { smallSigma0, smallSigma1 } from "../functions";
import { wordRow } from "../visuals";
import { rotr32, shr32, toHex32 } from "../word";

/** 節で共通に使う練習用の語。SHA-256 の初期ハッシュ値と `abc` の W[0]。 */
const SAMPLE = 0x6a09e667;
const W0 = PRIMARY_BLOCK.words[0];
const FIRST_STEP = PRIMARY_BLOCK.scheduleSteps[0];
const SECOND_BLOCK_STEP = TWO_BLOCK_TRACE.blocks[1].scheduleSteps[0];

/** 節 4: ROTR と SHR。 */
export const rotateShiftSection: DrillSection = {
  id: "rotate-and-shift",
  order: 4,
  title: loc("Rotate と Shift の違い", "Rotate versus shift"),
  goal: loc(
    "ROTR (回す) と SHR (捨てる) の違いを、同じ入力に対する出力の差で理解する。",
    "Understand ROTR (wrap around) versus SHR (discard) by comparing their output on the same input.",
  ),
  reading: [
    loc(
      "ROTR^n(x) は x の bit を右へ n 桁ずらし、右端からあふれた n bit を左端へ回り込ませる。情報は 1 bit も失われないので、ROTR は可逆である (ROTR^n の逆は ROTR^(32-n))。",
      "ROTR^n(x) shifts the bits of x right by n and wraps the n bits that fall off the right edge back around to the left. No information is lost, so ROTR is invertible: the inverse of ROTR^n is ROTR^(32-n).",
    ),
    loc(
      "SHR^n(x) は右へ n 桁ずらすが、あふれた n bit を捨て、左端は 0 で埋める。こちらは情報が失われるので可逆でない。",
      "SHR^n(x) also shifts right by n, but the overflowing bits are discarded and the left edge is filled with zeros. Information is lost, so it is not invertible.",
    ),
    loc(
      "多くの言語で `>>>` が SHR に相当するが、ROTR に相当する演算子は無い。`(x >>> n) | (x << (32 - n))` のように 2 回ずらして重ねる。JavaScript ではさらに `>>> 0` で 32 bit 符号なしへ畳み戻す必要がある (`<<` の結果が符号付きになるため)。",
      "Most languages spell SHR as `>>>` but have no rotate operator; you build it from two shifts, `(x >>> n) | (x << (32 - n))`. In JavaScript you must also fold the result back to unsigned with `>>> 0`, because `<<` yields a signed value.",
    ),
  ],
  visual: {
    kind: "words",
    rows: [
      wordRow("x", SAMPLE, loc("元の語。", "The original word.")),
      wordRow(
        "ROTR^7(x)",
        rotr32(SAMPLE, 7),
        loc("下位 7 bit が最上位へ回り込む。", "The low 7 bits wrap around to the top."),
      ),
      wordRow(
        "SHR^7(x)",
        shr32(SAMPLE, 7),
        loc(
          "下位 7 bit は捨てられ、上位は 0 になる。",
          "The low 7 bits are discarded and the top becomes zero.",
        ),
      ),
    ],
  },
  tasks: [
    {
      id: "rotr-shr",
      kind: "implementation",
      title: loc("ROTR と SHR を実装する", "Implement ROTR and SHR"),
      instruction: loc(
        "手元で ROTR と SHR を書き、各入力に対する出力を 8 桁の 16 進で答える。6 問すべてに手計算で答えるより、関数を書いて回した方が速い。",
        "Write ROTR and SHR locally and answer each output as 8 hex digits. Writing the functions is faster than doing all six by hand.",
      ),
      starter: [
        "const toWord = (x) => x >>> 0;",
        "const rotr = (x, n) => toWord((x >>> n) | (x << (32 - n)));",
        "const shr = (x, n) => toWord(x >>> n);",
        "const hex = (x) => toWord(x).toString(16).padStart(8, '0');",
        "console.log(hex(rotr(0x6a09e667, 7)), hex(shr(0x6a09e667, 3)));",
      ].join("\n"),
      cases: [
        answerCase({
          id: "rotr7",
          ja: "ROTR^7(0x6a09e667)",
          en: "ROTR^7(0x6a09e667)",
          expected: toHex32(rotr32(SAMPLE, 7)),
          format: "hex",
        }),
        answerCase({
          id: "rotr18",
          ja: "ROTR^18(0x6a09e667)",
          en: "ROTR^18(0x6a09e667)",
          expected: toHex32(rotr32(SAMPLE, 18)),
          format: "hex",
        }),
        answerCase({
          id: "shr3",
          ja: "SHR^3(0x6a09e667)",
          en: "SHR^3(0x6a09e667)",
          expected: toHex32(shr32(SAMPLE, 3)),
          format: "hex",
        }),
        answerCase({
          id: "rotr17-w0",
          ja: `ROTR^17(0x${toHex32(W0)})`,
          en: `ROTR^17(0x${toHex32(W0)})`,
          expected: toHex32(rotr32(W0, 17)),
          format: "hex",
        }),
        answerCase({
          id: "shr10-w0",
          ja: `SHR^10(0x${toHex32(W0)})`,
          en: `SHR^10(0x${toHex32(W0)})`,
          expected: toHex32(shr32(W0, 10)),
          format: "hex",
        }),
        answerCase({
          id: "rotr1-one",
          ja: "ROTR^1(0x00000001)",
          en: "ROTR^1(0x00000001)",
          expected: toHex32(rotr32(1, 1)),
          format: "hex",
        }),
      ],
      hints: [
        hint(
          1,
          "ROTR^1(0x00000001) は 0 にならない。最下位の 1 bit が最上位へ回り込む。",
          "ROTR^1(0x00000001) is not zero: the single low bit wraps to the top.",
        ),
        hint(
          2,
          "JavaScript の `<<` は符号付き 32 bit を返す。`>>> 0` を忘れると負値が出る。",
          "In JavaScript `<<` returns a signed 32-bit value; forget `>>> 0` and you get a negative number.",
        ),
        hint(
          3,
          "SHR^n では上位 n bit が必ず 0 になる。答えの先頭の桁を見て検算できる。",
          "After SHR^n the top n bits are always zero, so the leading digits of your answer are a built-in check.",
        ),
      ],
    },
  ],
  explanation: [
    loc(
      "ROTR だけを重ねた関数は bit の個数を変えない (全単射) が、SHR を混ぜると情報が落ちる。SHA-256 は両方を意図的に混ぜており、これが「元の入力へ戻せない」性質に寄与している。",
      "A function built only from ROTR preserves the number of set bits (it is a bijection); mixing in SHR loses information. SHA-256 deliberately mixes both, which contributes to the one-way property.",
    ),
    loc(
      "ROTR を SHR で書き間違えた実装は、テストベクタを 1 本通した時点で必ず落ちる。逆に σ と Σ の取り違え (次節以降) も同じように落ちるため、実装の順序としては「小さい関数を単体で検算してから組み上げる」が最短である。",
      "An implementation that writes SHR where ROTR belongs fails on the very first test vector. Mixing up σ and Σ (coming next) fails the same way, so the shortest path is to verify each small function on its own before composing them.",
    ),
  ],
  nextStep: loc(
    "ROTR と SHR が書けたので、これらを 3 つ重ねた σ 関数へ進む。",
    "With ROTR and SHR in hand, next come the σ functions that stack three of them.",
  ),
};

/** 節 5: σ0 / σ1。 */
export const smallSigmaSection: DrillSection = {
  id: "small-sigma",
  order: 5,
  title: loc("σ0 と σ1 (message schedule 用)", "σ0 and σ1, for the message schedule"),
  goal: loc(
    "σ0 = ROTR^7 ⊕ ROTR^18 ⊕ SHR^3、σ1 = ROTR^17 ⊕ ROTR^19 ⊕ SHR^10 を自分で計算できるようにする。",
    "Be able to compute σ0 = ROTR^7 ⊕ ROTR^18 ⊕ SHR^3 and σ1 = ROTR^17 ⊕ ROTR^19 ⊕ SHR^10 yourself.",
  ),
  reading: [
    loc(
      "σ0 と σ1 は、前節の ROTR を 2 回と SHR を 1 回、XOR で重ねただけの関数である。σ0(x) = ROTR^7(x) ⊕ ROTR^18(x) ⊕ SHR^3(x)、σ1(x) = ROTR^17(x) ⊕ ROTR^19(x) ⊕ SHR^10(x)。",
      "σ0 and σ1 simply XOR together two ROTRs and one SHR from the previous step: σ0(x) = ROTR^7(x) ⊕ ROTR^18(x) ⊕ SHR^3(x) and σ1(x) = ROTR^17(x) ⊕ ROTR^19(x) ⊕ SHR^10(x).",
    ),
    loc(
      "XOR で重ねる意味は「1 つの bit の変化を複数の桁へ散らす」ことである。ある 1 bit を変えると、ROTR の 2 回で 2 か所、SHR で最大 1 か所に影響が出る。これを 48 回繰り返すのが次節の message schedule で、入力 1 bit の変化が block 全体へ広がっていく。",
      "XOR-ing them spreads a change in one bit across several positions: flip one bit and it lands in two places through the rotations and up to one more through the shift. The next section repeats this 48 times, which is how a single input bit spreads across the whole block.",
    ),
    loc(
      "小文字の σ は message schedule 専用で、圧縮ラウンドで使う大文字の Σ とは回転量が違う (節 9 で扱う)。名前が似ているだけの別関数である。",
      "Lowercase σ belongs to the message schedule only. The uppercase Σ used inside the compression rounds has different rotation amounts (section 9). They are different functions with similar names.",
    ),
  ],
  visual: {
    kind: "words",
    rows: [
      wordRow("x", SAMPLE),
      wordRow("ROTR^7(x)", rotr32(SAMPLE, 7)),
      wordRow("ROTR^18(x)", rotr32(SAMPLE, 18)),
      wordRow("SHR^3(x)", shr32(SAMPLE, 3)),
      wordRow(
        "σ0(x)",
        smallSigma0(SAMPLE),
        loc("上の 3 行を XOR した結果。", "The XOR of the three rows above."),
      ),
    ],
  },
  tasks: [
    {
      id: "sigma-values",
      kind: "implementation",
      title: loc("σ0 / σ1 を実装する", "Implement σ0 and σ1"),
      instruction: loc(
        "ROTR と SHR を組み合わせて σ0 / σ1 を書き、各入力に対する出力を答える。中間の 3 語を表示させると検算しやすい。",
        "Compose ROTR and SHR into σ0 and σ1 and answer each output. Printing the three intermediate words makes checking easier.",
      ),
      starter: [
        "const s0 = (x) => toWord(rotr(x, 7) ^ rotr(x, 18) ^ shr(x, 3));",
        "const s1 = (x) => toWord(rotr(x, 17) ^ rotr(x, 19) ^ shr(x, 10));",
        "console.log(hex(s0(0x6a09e667)), hex(s1(0x6a09e667)));",
      ].join("\n"),
      cases: [
        answerCase({
          id: "sigma0-sample",
          ja: "σ0(0x6a09e667)",
          en: "σ0(0x6a09e667)",
          expected: toHex32(smallSigma0(SAMPLE)),
          format: "hex",
        }),
        answerCase({
          id: "sigma1-sample",
          ja: "σ1(0x6a09e667)",
          en: "σ1(0x6a09e667)",
          expected: toHex32(smallSigma1(SAMPLE)),
          format: "hex",
        }),
        answerCase({
          id: "sigma0-w0",
          ja: `σ0(0x${toHex32(W0)})`,
          en: `σ0(0x${toHex32(W0)})`,
          expected: toHex32(smallSigma0(W0)),
          format: "hex",
        }),
        answerCase({
          id: "sigma1-w0",
          ja: `σ1(0x${toHex32(W0)})`,
          en: `σ1(0x${toHex32(W0)})`,
          expected: toHex32(smallSigma1(W0)),
          format: "hex",
        }),
        answerCase({
          id: "sigma0-zero",
          ja: "σ0(0x00000000)",
          en: "σ0(0x00000000)",
          expected: toHex32(smallSigma0(0)),
          format: "hex",
        }),
        answerCase({
          id: "sigma1-ones",
          ja: "σ1(0xffffffff)",
          en: "σ1(0xffffffff)",
          expected: toHex32(smallSigma1(0xffffffff)),
          format: "hex",
        }),
      ],
      hints: [
        hint(
          1,
          "σ0(0) は 0 である。0 をいくら回してもずらしても 0 のままだから。",
          "σ0(0) is 0: rotating or shifting zero leaves zero.",
        ),
        hint(
          2,
          "σ1(0xffffffff) は 0xffffffff にならない。全 1 の入力では ROTR^17 と ROTR^19 がどちらも全 1 になり、XOR で打ち消し合って 0 になる。残るのは SHR^10(0xffffffff) だけで、上位 10 bit が 0、1 が立つのは下位 22 bit である。",
          "σ1(0xffffffff) is not 0xffffffff: for an all-ones input both ROTR^17 and ROTR^19 are also all ones, so they cancel to zero under XOR. Only SHR^10(0xffffffff) survives, leaving the top 10 bits zero and the ones in the low 22 bits.",
        ),
        hint(
          3,
          "回転量を取り違えていないか確認する。σ0 は 7 / 18 / 3、σ1 は 17 / 19 / 10 である。",
          "Check your rotation amounts: σ0 uses 7 / 18 / 3 and σ1 uses 17 / 19 / 10.",
        ),
      ],
    },
  ],
  explanation: [
    loc(
      "回転量 (7, 18, 3) と (17, 19, 10) は設計者が解析の上で選んだ値で、任意に変えると拡散が悪くなる。写し間違えても実装は動くが、出力は SHA-256 ではない別のハッシュ関数になる。",
      "The rotation amounts (7, 18, 3) and (17, 19, 10) were chosen by analysis; changing them weakens diffusion. Copy one wrong and the code still runs — it simply computes a different hash function that is not SHA-256.",
    ),
    loc(
      "だから暗号の実装では「動いた」は品質保証にならない。既知テストベクタとの一致が最低条件である。",
      'This is why "it runs" is not a quality signal in cryptographic code. Matching the known test vectors is the minimum bar.',
    ),
  ],
  nextStep: loc(
    "σ が書けたので、16 語を 64 語へ伸ばす message schedule を組み立てる。",
    "With σ written, next we assemble the message schedule that grows 16 words into 64.",
  ),
};

/** 節 6: message schedule。 */
export const scheduleSection: DrillSection = {
  id: "message-schedule",
  order: 6,
  title: loc("message schedule で 64 語へ伸ばす", "Grow to 64 words with the message schedule"),
  goal: loc(
    "W[16] 〜 W[63] を漸化式で作り、添字の対応を間違えずに実装できるようにする。",
    "Build W[16] through W[63] from the recurrence and get the indices right.",
  ),
  reading: [
    loc(
      "圧縮関数は 64 ラウンド回るので、語も 64 個必要になる。block から取れるのは 16 語なので、残り 48 語は既存の語から作る。",
      "The compression function runs 64 rounds, so it needs 64 words. The block only supplies 16, so the remaining 48 are derived from the ones already there.",
    ),
    loc(
      "漸化式は W[i] = W[i-16] + σ0(W[i-15]) + W[i-7] + σ1(W[i-2]) (mod 2^32)。加算はすべて 2^32 での剰余、つまり 32 bit であふれた分を捨てる足し算である。",
      "The recurrence is W[i] = W[i-16] + σ0(W[i-15]) + W[i-7] + σ1(W[i-2]) (mod 2^32). Every addition is modulo 2^32 — overflow past 32 bits is dropped.",
    ),
    loc(
      "添字の組み合わせを覚える必要はないが、**σ が付くのは i-15 と i-2 の 2 つだけ** という対応は覚える価値がある。ここを i-16 と i-7 に付けてしまうのが典型的な誤りで、W[16] だけを検算すれば即座に気づける。",
      "You need not memorise the index set, but it is worth remembering that **only i-15 and i-2 pass through σ**. Applying σ to i-16 or i-7 instead is the classic mistake, and checking W[16] alone catches it immediately.",
    ),
    loc(
      "`abc` の場合、W[1] から W[14] がすべて 0 なので W[16] = W[0] + 0 + 0 + 0 = W[0] になる。偶然の一致だが、実装の第一歩の検算にはちょうどよい。",
      "For `abc`, W[1] through W[14] are all zero, so W[16] = W[0] + 0 + 0 + 0 = W[0]. It is a coincidence, but a convenient first check for a fresh implementation.",
    ),
  ],
  visual: {
    kind: "words",
    rows: [
      wordRow(`W[${FIRST_STEP.index - 16}]`, FIRST_STEP.wMinus16),
      wordRow(`σ0(W[${FIRST_STEP.index - 15}])`, FIRST_STEP.sigma0),
      wordRow(`W[${FIRST_STEP.index - 7}]`, FIRST_STEP.wMinus7),
      wordRow(`σ1(W[${FIRST_STEP.index - 2}])`, FIRST_STEP.sigma1),
      wordRow(
        `W[${FIRST_STEP.index}]`,
        FIRST_STEP.result,
        loc("4 行を mod 2^32 で足した値。", "The four rows added modulo 2^32."),
      ),
    ],
  },
  tasks: [
    {
      id: "schedule-words",
      kind: "implementation",
      title: loc("W[16] 以降を生成する", "Generate W[16] and beyond"),
      instruction: loc(
        "`abc` のパディング済み block から 64 語を生成し、指定された語を答える。最後の 1 問は 64 byte 入力の **2 番目の** block から生成した語である (block ごとに schedule を作り直すことの確認)。",
        "Generate all 64 words from the padded `abc` block and answer the requested ones. The last case comes from the **second** block of a 64-byte input, confirming that each block gets its own schedule.",
      ),
      starter: [
        "const W = blockWords.slice(); // 16 語",
        "for (let i = 16; i < 64; i++) {",
        "  W.push(toWord(W[i - 16] + s0(W[i - 15]) + W[i - 7] + s1(W[i - 2])));",
        "}",
        "console.log(hex(W[16]), hex(W[17]), hex(W[63]));",
      ].join("\n"),
      cases: [
        answerCase({
          id: "w16",
          ja: "`abc` の W[16]",
          en: "W[16] for `abc`",
          expected: toHex32(PRIMARY_BLOCK.words[16]),
          format: "hex",
        }),
        answerCase({
          id: "w17",
          ja: "`abc` の W[17]",
          en: "W[17] for `abc`",
          expected: toHex32(PRIMARY_BLOCK.words[17]),
          format: "hex",
        }),
        answerCase({
          id: "w18",
          ja: "`abc` の W[18]",
          en: "W[18] for `abc`",
          expected: toHex32(PRIMARY_BLOCK.words[18]),
          format: "hex",
        }),
        answerCase({
          id: "w63",
          ja: "`abc` の W[63]",
          en: "W[63] for `abc`",
          expected: toHex32(PRIMARY_BLOCK.words[63]),
          format: "hex",
        }),
        answerCase({
          id: "second-block-w16",
          ja: "64 byte 入力の 2 番目の block の W[16]",
          en: "W[16] of the second block of a 64-byte input",
          expected: toHex32(SECOND_BLOCK_STEP.result),
          format: "hex",
        }),
      ],
      hints: [
        hint(
          1,
          "W[16] が W[0] と一致しなければ、σ を付ける添字を間違えている可能性が高い。",
          "If W[16] does not equal W[0], you have most likely applied σ to the wrong indices.",
        ),
        hint(
          2,
          "加算は mod 2^32 である。JavaScript なら足したあとに `>>> 0` を付ける。",
          "The additions are modulo 2^32; in JavaScript append `>>> 0` after summing.",
        ),
        hint(
          3,
          "message schedule は block ごとに作り直す。2 番目の block では W[0..15] がその block の byte から取り直される。",
          "The schedule is rebuilt per block: for the second block, W[0..15] come from that block's own bytes.",
        ),
      ],
    },
  ],
  explanation: [
    loc(
      "message schedule の役目は、512 bit の入力を 64 ラウンド分へ「薄く伸ばして混ぜる」ことである。単に W[i mod 16] を使い回す設計にすると、入力の 1 bit が影響する範囲が狭くなり、差分攻撃の足場になる。",
      "The schedule's job is to stretch and mix 512 input bits across 64 rounds. Simply reusing W[i mod 16] would confine the influence of each input bit and hand differential attacks a foothold.",
    ),
    loc(
      "SHA-1 が破られた原因の一部も schedule の拡散不足にある。SHA-256 は σ を 2 種類挟むことで、同じ 16 語から作る 48 語の独立性を高めている。",
      "Part of why SHA-1 fell was insufficient diffusion in its schedule. SHA-256 interleaves two different σ functions to make the 48 derived words less related to the original 16.",
    ),
  ],
  nextStep: loc(
    "64 語が揃った。次は圧縮ラウンドが使う 2 つの選択関数 Ch と Maj に入る。",
    "With all 64 words ready, next come the two selection functions the rounds use: Ch and Maj.",
  ),
};
