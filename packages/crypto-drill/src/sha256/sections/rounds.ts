/**
 * 節 10〜12: 1 ラウンド → 64 ラウンド → 最終ハッシュ。
 *
 * 部品が揃ったので組み立てる区間。ここまでの節を全部通していれば、節 12 は
 * 「既知テストベクタが全部通る SHA-256 実装が手元にある」状態になる。
 */

import { answerCase, hint, loc } from "../../drill/authoring";
import type { DrillSection } from "../../drill/types";
import { ROUND_CONSTANTS } from "../constants";
import {
  BOUNDARY_55_INPUT,
  BOUNDARY_55_TRACE,
  BOUNDARY_56_INPUT,
  BOUNDARY_56_TRACE,
  EMPTY_TRACE,
  HELLO_INPUT,
  HELLO_TRACE,
  PRIMARY_BLOCK,
  PRIMARY_INPUT,
  PRIMARY_TRACE,
  TWO_BLOCK_INPUT,
  TWO_BLOCK_TRACE,
  UTF8_INPUT,
  UTF8_TRACE,
} from "../fixtures";
import { stateToDigest } from "../trace";
import { roundsVisual, wordRow } from "../visuals";
import { toHex32 } from "../word";

const ROUND0 = PRIMARY_BLOCK.rounds[0];
const ROUND1 = PRIMARY_BLOCK.rounds[1];
const ROUND31 = PRIMARY_BLOCK.rounds[31];
const LAST_ROUND = PRIMARY_BLOCK.rounds[63];

/** 節 10: 1 ラウンド。 */
export const singleRoundSection: DrillSection = {
  id: "single-round",
  order: 10,
  title: loc("圧縮ラウンドを 1 回だけ回す", "Run exactly one compression round"),
  goal: loc(
    "T1 と T2 を計算し、a〜h の 8 レジスタがどう更新されるかを追えるようにする。",
    "Compute T1 and T2 and follow how the eight registers a..h are updated.",
  ),
  reading: [
    loc(
      "圧縮関数は 8 個の 32 bit レジスタ a, b, c, d, e, f, g, h を持つ。1 ラウンドで行うのは、2 つの一時値 T1 / T2 を作り、レジスタを 1 つ後ろへずらしながら 2 か所へ足し込むことである。",
      "The compression function holds eight 32-bit registers a, b, c, d, e, f, g, h. A round builds two temporaries T1 and T2, then shifts the registers down by one while adding into two positions.",
    ),
    loc(
      "T1 = h + Σ1(e) + Ch(e, f, g) + K[i] + W[i]、T2 = Σ0(a) + Maj(a, b, c)。加算はすべて mod 2^32 である。K[i] はラウンド定数で、素数の立方根の小数部から決まる固定表である。",
      "T1 = h + Σ1(e) + Ch(e, f, g) + K[i] + W[i] and T2 = Σ0(a) + Maj(a, b, c), with every addition modulo 2^32. K[i] is a round constant from a fixed table derived from the cube roots of primes.",
    ),
    loc(
      "更新は h←g, g←f, f←e, e←d+T1, d←c, c←b, b←a, a←T1+T2。つまり 6 個のレジスタは単に隣へ移動するだけで、実際に新しい値が入るのは a と e の 2 か所だけである。",
      "The update is h←g, g←f, f←e, e←d+T1, d←c, c←b, b←a, a←T1+T2. Six registers merely move to their neighbour; only a and e receive genuinely new values.",
    ),
    loc(
      "この「ずらす」構造のおかげで、あるラウンドで作った値は 8 ラウンドかけて h まで移動し、その間ずっと Ch や Maj の入力として使われ続ける。",
      "Thanks to that shifting structure, a value produced in one round takes eight rounds to travel down to h, and it keeps feeding Ch and Maj the whole way.",
    ),
  ],
  visual: {
    kind: "words",
    rows: [
      wordRow("W[0]", ROUND0.w),
      wordRow("K[0]", ROUND0.k, loc("ラウンド定数。", "The round constant.")),
      wordRow("Σ1(e)", ROUND0.bigSigma1),
      wordRow("Ch(e, f, g)", ROUND0.ch),
      wordRow(
        "T1",
        ROUND0.t1,
        loc("h + Σ1(e) + Ch + K[0] + W[0]。", "h + Σ1(e) + Ch + K[0] + W[0]."),
      ),
      wordRow("Σ0(a)", ROUND0.bigSigma0),
      wordRow("Maj(a, b, c)", ROUND0.maj),
      wordRow("T2", ROUND0.t2, loc("Σ0(a) + Maj(a, b, c)。", "Σ0(a) + Maj(a, b, c).")),
    ],
  },
  tasks: [
    {
      id: "round-zero",
      kind: "implementation",
      title: loc("`abc` のラウンド 0 を計算する", "Compute round 0 for `abc`"),
      instruction: loc(
        "初期ハッシュ値を a〜h の初期値として、`abc` のラウンド 0 を 1 回だけ回す。K[0] = 0x428a2f98、W[0] は節 3 で求めた値である。",
        "Take the initial hash values as a..h and run exactly one round for `abc`. K[0] = 0x428a2f98 and W[0] is the value from section 3.",
      ),
      starter: [
        "const t1 = toWord(h + S1(e) + ch(e, f, g) + K[0] + W[0]);",
        "const t2 = toWord(S0(a) + maj(a, b, c));",
        "const nextA = toWord(t1 + t2);",
        "const nextE = toWord(d + t1);",
        "console.log(hex(t1), hex(t2), hex(nextA), hex(nextE));",
      ].join("\n"),
      cases: [
        answerCase({
          id: "t1",
          ja: "T1",
          en: "T1",
          expected: toHex32(ROUND0.t1),
          format: "hex",
        }),
        answerCase({
          id: "t2",
          ja: "T2",
          en: "T2",
          expected: toHex32(ROUND0.t2),
          format: "hex",
        }),
        answerCase({
          id: "next-a",
          ja: "更新後の a",
          en: "a after the round",
          expected: toHex32(ROUND0.after[0]),
          format: "hex",
        }),
        answerCase({
          id: "next-e",
          ja: "更新後の e",
          en: "e after the round",
          expected: toHex32(ROUND0.after[4]),
          format: "hex",
        }),
        answerCase({
          id: "next-b",
          ja: "更新後の b",
          en: "b after the round",
          expected: toHex32(ROUND0.after[1]),
          format: "hex",
        }),
      ],
      hints: [
        hint(
          1,
          "更新後の b は計算する必要がない。更新前の a がそのまま入る。",
          "You do not compute b: it simply receives the previous value of a.",
        ),
        hint(
          2,
          "T1 は 5 項の和である。h を足し忘れていないか確認する。",
          "T1 is a sum of five terms — check that you did not forget h.",
        ),
        hint(
          3,
          "e の更新は d + T1 であり、T1 + T2 ではない。a と e で足すものが違う。",
          "e is updated as d + T1, not T1 + T2. The two registers add different things.",
        ),
      ],
    },
    {
      id: "round-one",
      kind: "implementation",
      title: loc("続けてラウンド 1 を回す", "Continue into round 1"),
      instruction: loc(
        "ラウンド 0 の出力を入力として、ラウンド 1 を回す。使う定数と語は K[1] と W[1] に進む。",
        "Feed the output of round 0 into round 1. The constant and word advance to K[1] and W[1].",
      ),
      starter: [
        "// ラウンド 1 回ぶんを関数に切り出し、状態を渡して 2 回呼ぶ",
        "const round = (s, i) => {",
        "  const [a, b, c, d, e, f, g, h] = s;",
        "  const t1 = toWord(h + S1(e) + ch(e, f, g) + K[i] + W[i]);",
        "  const t2 = toWord(S0(a) + maj(a, b, c));",
        "  return [toWord(t1 + t2), a, b, c, toWord(d + t1), e, f, g];",
        "};",
        "console.log(round(round(H0, 0), 1).map(hex));",
      ].join("\n"),
      cases: [
        answerCase({
          id: "k1",
          ja: "K[1] (定数表から)",
          en: "K[1], from the constant table",
          expected: toHex32(ROUND_CONSTANTS[1]),
          format: "hex",
        }),
        answerCase({
          id: "t1",
          ja: "ラウンド 1 の T1",
          en: "T1 in round 1",
          expected: toHex32(ROUND1.t1),
          format: "hex",
        }),
        answerCase({
          id: "next-a",
          ja: "ラウンド 1 更新後の a",
          en: "a after round 1",
          expected: toHex32(ROUND1.after[0]),
          format: "hex",
        }),
      ],
      hints: [
        hint(
          1,
          "`abc` の W[1] は 0 である。それでも T1 は 0 にならない (他の 4 項があるため)。",
          "W[1] is 0 for `abc`, yet T1 is not zero — the other four terms remain.",
        ),
        hint(
          2,
          "ラウンド 1 の h には、ラウンド 0 の g が入っている。レジスタのずれを追う。",
          "In round 1, h holds what was g in round 0. Follow the register shift.",
        ),
      ],
    },
  ],
  explanation: [
    loc(
      "1 ラウンドの中で新しい値が入るのは a と e だけである。にもかかわらず 64 ラウンド回すと 8 個すべてが完全に混ざるのは、a が 8 ラウンドで h まで降りてきて T1 の材料になるためである。",
      "Only a and e get new values in a round. All eight nevertheless end up thoroughly mixed after 64 rounds, because a descends to h within eight rounds and becomes an ingredient of T1.",
    ),
    loc(
      "ラウンド数 64 はこの伝播に十分な余裕を持たせた値である。ラウンドを削った縮小版は解析対象としては存在するが、実運用の SHA-256 は必ず 64 回回す。",
      "The choice of 64 rounds leaves ample margin for that propagation. Reduced-round variants exist as objects of analysis, but production SHA-256 always runs all 64.",
    ),
  ],
  nextStep: loc(
    "1 ラウンドが回った。同じことを 64 回繰り返す。",
    "One round works. Now repeat it 64 times.",
  ),
};

/** 節 11: 64 ラウンド。 */
export const allRoundsSection: DrillSection = {
  id: "all-rounds",
  order: 11,
  title: loc("64 ラウンド回す", "Run all 64 rounds"),
  goal: loc(
    "ループとして 64 ラウンドを回し、任意のラウンドの状態を取り出せるようにする。",
    "Turn the round into a loop over all 64 and be able to read out the state at any round.",
  ),
  reading: [
    loc(
      "節 10 のラウンドを i = 0..63 でループさせるだけである。各ラウンドで K[i] と W[i] が進み、それ以外の手順は変わらない。",
      "This is simply the round from section 10 looped for i = 0..63. K[i] and W[i] advance each time; nothing else changes.",
    ),
    loc(
      "下の表は `abc` の全 64 ラウンドの a〜h である。上へ行くほど初期値に近く、下へ行くほど混ざっている。数ラウンド目までは 0x6a09e667 などの初期値がまだ見えているが、10 ラウンドを過ぎるとどのレジスタも初期値の痕跡を残していない。",
      "The table below lists a..h for all 64 rounds of `abc`. Rows near the top still resemble the initial values; further down they do not. Values such as 0x6a09e667 are still visible for the first few rounds, but past round 10 no register shows any trace of its starting value.",
    ),
    loc(
      "デバッグの実務としては、まずラウンド 0 の状態を合わせ、次にラウンド 63 の状態を合わせるのが速い。途中で食い違い始めたラウンドを二分探索すれば、W か K か Ch か Maj のどこが違うかまで絞れる。",
      "In practice the fastest way to debug is to match round 0 first, then round 63. Bisecting for the first round that diverges narrows the fault down to W, K, Ch, or Maj.",
    ),
  ],
  visual: roundsVisual(PRIMARY_BLOCK.rounds),
  tasks: [
    {
      id: "round-states",
      kind: "implementation",
      title: loc("途中と最後のラウンド状態を答える", "Report the mid and final round states"),
      instruction: loc(
        "`abc` の 64 ラウンドを回し、指定されたラウンド直後の状態を答える。8 語まとめて答える欄は a から h の順に 16 進を連結する (64 桁)。",
        "Run all 64 rounds for `abc` and report the state right after the requested rounds. Where eight words are asked for, concatenate the hex of a through h in order (64 digits).",
      ),
      starter: [
        "let [a, b, c, d, e, f, g, h] = H0;",
        "for (let i = 0; i < 64; i++) {",
        "  const t1 = toWord(h + S1(e) + ch(e, f, g) + K[i] + W[i]);",
        "  const t2 = toWord(S0(a) + maj(a, b, c));",
        "  [a, b, c, d, e, f, g, h] = [toWord(t1 + t2), a, b, c, toWord(d + t1), e, f, g];",
        "}",
      ].join("\n"),
      cases: [
        answerCase({
          id: "a-after-31",
          ja: "ラウンド 31 直後の a",
          en: "a right after round 31",
          expected: toHex32(ROUND31.after[0]),
          format: "hex",
        }),
        answerCase({
          id: "e-after-31",
          ja: "ラウンド 31 直後の e",
          en: "e right after round 31",
          expected: toHex32(ROUND31.after[4]),
          format: "hex",
        }),
        answerCase({
          id: "state-after-63",
          ja: "ラウンド 63 直後の a〜h (64 桁)",
          en: "a..h right after round 63, 64 digits",
          expected: stateToDigest(LAST_ROUND.after),
          format: "hex",
        }),
      ],
      hints: [
        hint(
          1,
          "ラウンド 63 直後の状態は最終ハッシュではない。まだ初期ハッシュ値を足していない。",
          "The state right after round 63 is not the final hash: the initial hash values have not been added back yet.",
        ),
        hint(
          2,
          "8 レジスタの入れ替えを 1 行で書くときは、右辺が全部「更新前」の値を参照していることを確認する。",
          "If you permute the eight registers in one statement, check that every right-hand side reads the pre-update values.",
        ),
        hint(
          3,
          "ラウンド 31 で合わなければ、W[16] 以降の生成 (節 6) を先に検算する。W[0..15] しか使っていないラウンド 15 までは合っていることが多い。",
          "If round 31 is wrong, re-check the schedule from section 6 first: rounds up to 15 often match because they only use W[0..15].",
        ),
      ],
    },
  ],
  explanation: [
    loc(
      "64 ラウンド後の状態は「入力に依存してよく撹拌された 256 bit」だが、まだハッシュではない。ここまでは (K と W が既知なら) ラウンドを逆に回せるので、実は可逆である。",
      "After 64 rounds the state is a well-stirred 256 bits that depends on the input — but it is not yet a hash. Up to here the rounds can be run backwards when K and W are known, so it is actually invertible.",
    ),
    loc(
      "片方向性を作るのは次節の 1 行である。「たくさん混ぜたから戻せない」ではなく、「情報を捨てる操作を最後に置いたから戻せない」が正しい理解である。",
      'What makes it one-way is a single line in the next section. The correct reading is not "it is stirred a lot" but "an information-destroying step is placed at the end".',
    ),
  ],
  nextStep: loc(
    "撹拌が終わった。最後の 1 手で片方向性を作り、ダイジェストを取り出す。",
    "The stirring is done. One last step creates the one-way property and yields the digest.",
  ),
};

/** 節 12: 最終ハッシュ。 */
export const digestSection: DrillSection = {
  id: "final-digest",
  order: 12,
  title: loc("最終ハッシュを取り出す", "Extract the final hash"),
  goal: loc(
    "初期ハッシュ値を足し戻して 256 bit を連結し、既知テストベクタと一致させる。",
    "Add the incoming hash values back, concatenate the 256 bits, and match the published test vectors.",
  ),
  reading: [
    loc(
      "64 ラウンド後の 8 語に、**そのブロックに入る前のハッシュ値** を 1 語ずつ mod 2^32 で足す。これが Davies-Meyer と呼ばれる構成で、ハッシュ関数の片方向性はこの 1 段から来ている。",
      "Add the hash values **as they were before this block** to the eight words from round 63, one by one, modulo 2^32. This is the Davies-Meyer construction, and it is where the one-way property comes from.",
    ),
    loc(
      "block が複数あれば、この結果を次の block の入力ハッシュ値として使い、同じ処理を繰り返す。最後の block の結果が最終ハッシュである。a から h まで 8 語 × 8 桁 = 64 桁の 16 進が、いわゆる SHA-256 の値になる。",
      "With more than one block, the result becomes the incoming hash for the next block and the process repeats. The result after the last block is the final hash: eight words at eight hex digits each, 64 digits in all.",
    ),
    loc(
      "ここまで来たら既知テストベクタで確認する。空文字列と `abc` は仕様書に載っている値で、これが合えば実装はほぼ正しい。56 byte と 64 byte はパディングの block 境界を踏むので、必ず含める。",
      "At this point, check against the published test vectors. The empty string and `abc` appear in the specification, and matching them means the implementation is very likely correct. Always include 56 and 64 bytes, which exercise the padding block boundary.",
    ),
  ],
  visual: {
    kind: "words",
    rows: [
      wordRow(
        "a (round 63)",
        LAST_ROUND.after[0],
        loc("撹拌後の値。", "The value after stirring."),
      ),
      wordRow(
        "H[0] (block 入力)",
        PRIMARY_BLOCK.hashBefore[0],
        loc("この block に入る前のハッシュ値。", "The hash value before this block."),
      ),
      wordRow(
        "H[0] + a",
        PRIMARY_BLOCK.hashAfter[0],
        loc(
          "足し戻した結果 = ダイジェストの先頭 8 桁。",
          "Their sum: the first eight digits of the digest.",
        ),
      ),
    ],
  },
  tasks: [
    {
      id: "digest-of-abc",
      kind: "value",
      title: loc("`abc` のダイジェストを出す", "Produce the digest of `abc`"),
      instruction: loc(
        "ラウンド 63 の状態に初期ハッシュ値を足し戻し、64 桁の 16 進で答える。",
        "Add the initial hash values back to the round-63 state and answer with 64 hex digits.",
      ),
      cases: [
        answerCase({
          id: "first-word",
          ja: "ダイジェストの先頭 8 桁 (H[0] + a)",
          en: "The first eight digits of the digest, H[0] + a",
          expected: toHex32(PRIMARY_TRACE.hash[0]),
          format: "hex",
        }),
        answerCase({
          id: "digest",
          ja: `\`${PRIMARY_INPUT}\` の SHA-256`,
          en: `SHA-256 of \`${PRIMARY_INPUT}\``,
          expected: PRIMARY_TRACE.digest,
          format: "hex",
        }),
      ],
      hints: [
        hint(
          1,
          "足すのは初期ハッシュ値 H[0..7] であって、ラウンド定数 K ではない。",
          "You add the initial hash values H[0..7], not the round constants K.",
        ),
        hint(
          2,
          "先頭 8 桁が `ba7816bf` にならなければ、ラウンド 63 の状態か足し戻しのどちらかが違う。",
          "If the first eight digits are not `ba7816bf`, either the round-63 state or the addition is wrong.",
        ),
      ],
    },
    {
      id: "test-vectors",
      kind: "implementation",
      title: loc("テストベクタを全部通す", "Pass every test vector"),
      instruction: loc(
        "完成した実装で各入力のダイジェストを求め、64 桁の 16 進で答える。境界条件 (空文字・55 byte・56 byte・64 byte)、複数 block、UTF-8 を含む。",
        "Run your finished implementation on each input and answer with 64 hex digits. The set covers the boundaries (empty, 55, 56, 64 bytes), multiple blocks, and UTF-8.",
      ),
      starter: [
        "// 節 1 から 12 で書いた関数を sha256(text) として束ねて回す",
        "const vectors = ['', 'hello world', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), '天下クラウド'];",
        "for (const v of vectors) console.log(JSON.stringify(v), sha256(v));",
        "// 標準ライブラリと突き合わせる (Node.js)",
        "// crypto.createHash('sha256').update(v, 'utf8').digest('hex')",
      ].join("\n"),
      cases: [
        answerCase({
          id: "empty",
          ja: "空文字列 (0 byte)",
          en: "The empty string, 0 bytes",
          expected: EMPTY_TRACE.digest,
          format: "hex",
        }),
        answerCase({
          id: "hello",
          ja: `\`${HELLO_INPUT}\` (11 byte)`,
          en: `\`${HELLO_INPUT}\`, 11 bytes`,
          expected: HELLO_TRACE.digest,
          format: "hex",
        }),
        answerCase({
          id: "boundary-55",
          ja: `\`a\` × 55 (1 block に収まる最後の長さ)`,
          en: "`a` × 55, the last length that fits one block",
          expected: BOUNDARY_55_TRACE.digest,
          format: "hex",
        }),
        answerCase({
          id: "boundary-56",
          ja: `\`a\` × 56 (2 block になる最初の長さ)`,
          en: "`a` × 56, the first length that needs two blocks",
          expected: BOUNDARY_56_TRACE.digest,
          format: "hex",
        }),
        answerCase({
          id: "two-blocks",
          ja: `\`a\` × 64 (ちょうど 1 block ぶんの本文)`,
          en: "`a` × 64, exactly one block of message",
          expected: TWO_BLOCK_TRACE.digest,
          format: "hex",
        }),
        answerCase({
          id: "utf8",
          ja: `\`${UTF8_INPUT}\` (UTF-8 で 18 byte)`,
          en: `\`${UTF8_INPUT}\`, 18 bytes in UTF-8`,
          expected: UTF8_TRACE.digest,
          format: "hex",
        }),
      ],
      hints: [
        hint(
          1,
          `空文字列が通らなければパディングを疑う。本文 0 byte でも block は 1 つ必要である。`,
          "If the empty string fails, suspect the padding: even a 0-byte message needs one block.",
        ),
        hint(
          2,
          `\`${BOUNDARY_56_INPUT.length} byte\` と \`${TWO_BLOCK_INPUT.length} byte\` が通らなければ、block をまたぐループでハッシュ値を引き継いでいない可能性が高い。`,
          `If the ${BOUNDARY_56_INPUT.length}-byte and ${TWO_BLOCK_INPUT.length}-byte cases fail, your block loop most likely does not carry the hash value forward.`,
        ),
        hint(
          3,
          `\`${BOUNDARY_55_INPUT.length} byte\` だけ通って \`${BOUNDARY_56_INPUT.length} byte\` が落ちるなら、パディング長の切り上げが 1 block ぶん足りていない。`,
          `If ${BOUNDARY_55_INPUT.length} bytes passes but ${BOUNDARY_56_INPUT.length} fails, your padding length rounds up one block short.`,
        ),
        hint(
          4,
          "UTF-8 だけ落ちるなら、文字数を byte 数として使っている。",
          "If only the UTF-8 case fails, you are using the character count as the byte count.",
        ),
      ],
    },
  ],
  explanation: [
    loc(
      "最後の足し戻しが片方向性の源である。ラウンド後の状態と入力ハッシュ値を足した結果からは、元の 2 つの値を復元できない (和が同じ組み合わせは 2^32 通りある)。逆算できないのは「複雑だから」ではなく、情報を捨てているからである。",
      "That final addition is the source of one-wayness. From the sum of the post-round state and the incoming hash you cannot recover the two addends — 2^32 pairs share any given sum. Inversion fails not because the function is complicated but because information was discarded.",
    ),
    loc(
      "実装を書き終えたら、必ず標準ライブラリの出力と突き合わせる。自作の暗号実装を本番で使う理由はほとんど無く、ここで書いたコードの価値は「中で何が起きているか説明できるようになったこと」にある。",
      "Once your implementation works, compare it against a standard library. There is almost never a reason to ship a hand-rolled hash; the value of the code you just wrote is being able to explain what happens inside.",
    ),
  ],
  nextStep: loc(
    "実装が完成した。次は入力を 1 bit 変えて、出力がどう変わるかを観察する。",
    "The implementation is complete. Next, flip one input bit and watch what happens to the output.",
  ),
};
