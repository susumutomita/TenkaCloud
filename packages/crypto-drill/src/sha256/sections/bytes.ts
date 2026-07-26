/**
 * 節 1〜3: 文字列 → byte 列 → パディング → 32 bit 語。
 *
 * ここまでは「まだ暗号らしい計算をしていない」区間だが、ハッシュが合わない原因の大半は
 * この区間 (文字と byte の混同、パディング桁数、エンディアン) にある。
 */

import { answerCase, hint, loc } from "../../drill/authoring";
import type { DrillSection } from "../../drill/types";
import { PRIMARY_BLOCK, PRIMARY_TRACE, UTF8_INPUT, UTF8_TRACE } from "../fixtures";
import { paddedLength, zeroPaddingLength } from "../padding";
import { bitLane, wordRow } from "../visuals";
import { bytesToBinary, bytesToHex, toHex32 } from "../word";

const primaryHex = bytesToHex(PRIMARY_TRACE.message);
const paddedHex = bytesToHex(PRIMARY_TRACE.padded);

/** 節 1: 文字列を byte 列として見る。 */
export const stringToBytesSection: DrillSection = {
  id: "string-to-bytes",
  order: 1,
  title: loc("文字列を byte 列にする", "Turn text into bytes"),
  goal: loc(
    "SHA-256 の入力は文字ではなく byte 列であることを、UTF-8 変換の手ざわりで確認する。",
    "See first-hand that SHA-256 takes bytes, not characters, by encoding text as UTF-8.",
  ),
  reading: [
    loc(
      "SHA-256 は「文字列」を知らない。受け取るのは byte 列だけで、文字列をどう byte にするかはハッシュ関数の外側の決めごとである。TenkaCloud も Web の慣習に従って UTF-8 を使う。",
      "SHA-256 knows nothing about text. It consumes a byte sequence, and how text becomes bytes is decided outside the hash function. Like the rest of the web, we use UTF-8.",
    ),
    loc(
      "ASCII の範囲では 1 文字 = 1 byte なので、`abc` は 3 byte になる。日本語はそうならない。UTF-8 では漢字やカタカナが 3 byte を占めるため、文字数と byte 数が一致しない。同じ文字列でも別のエンコーディングを使えば別のハッシュになる。",
      "Inside ASCII one character is one byte, so `abc` is 3 bytes. Japanese is not like that: in UTF-8 kanji and katakana take 3 bytes each, so the character count and the byte count differ. The same text under a different encoding produces a different hash.",
    ),
    loc(
      "16 進表示は 1 byte を 2 桁で表す人間向けの書き方で、2 進表示は同じ byte を 8 桁で表したものである。どちらも同じ byte の別の見た目にすぎない。",
      "Hex shows one byte as two digits for human eyes; binary shows the same byte as eight digits. Both are just different views of the same byte.",
    ),
  ],
  visual: {
    kind: "bit-lanes",
    groupSize: 8,
    lanes: [
      bitLane(
        "abc (UTF-8)",
        bytesToBinary(PRIMARY_TRACE.message),
        loc("3 byte = 24 bit。", "3 bytes = 24 bits."),
      ),
      bitLane(
        `${UTF8_INPUT} (UTF-8)`,
        bytesToBinary(UTF8_TRACE.message),
        loc("6 文字だが 18 byte = 144 bit。", "6 characters but 18 bytes = 144 bits."),
      ),
    ],
  },
  tasks: [
    {
      id: "utf8-hex",
      kind: "value",
      title: loc("UTF-8 の 16 進表示", "UTF-8 as hex"),
      instruction: loc(
        "各文字列を UTF-8 の byte 列に直し、16 進で答える。区切りや `0x` は付けても付けなくてもよい。",
        "Encode each string as UTF-8 bytes and answer in hex. Separators and a `0x` prefix are optional.",
      ),
      cases: [
        answerCase({
          id: "abc",
          ja: "`abc` の UTF-8 byte 列 (16 進)",
          en: "UTF-8 bytes of `abc` (hex)",
          expected: primaryHex,
          format: "hex",
        }),
        answerCase({
          id: "utf8",
          ja: `\`${UTF8_INPUT}\` の UTF-8 byte 列 (16 進)`,
          en: `UTF-8 bytes of \`${UTF8_INPUT}\` (hex)`,
          expected: bytesToHex(UTF8_TRACE.message),
          format: "hex",
        }),
        answerCase({
          id: "utf8-length",
          ja: `\`${UTF8_INPUT}\` の byte 数 (10 進)`,
          en: `Byte length of \`${UTF8_INPUT}\` (decimal)`,
          expected: String(UTF8_TRACE.message.length),
          format: "decimal",
        }),
      ],
      hints: [
        hint(
          1,
          "ASCII の `a` は 0x61 である。連続する 3 文字なら 16 進も 1 ずつ増える。",
          "ASCII `a` is 0x61. Three consecutive letters step the hex value by one each.",
        ),
        hint(
          2,
          "UTF-8 では、漢字とカタカナはどちらも 3 byte を使う。文字数を数えてから 3 倍する。",
          "In UTF-8 both kanji and katakana take 3 bytes. Count the characters, then multiply by three.",
        ),
      ],
    },
    {
      id: "utf8-binary",
      kind: "value",
      title: loc("同じ byte を 2 進で書く", "Write the same bytes in binary"),
      instruction: loc(
        "16 進 1 桁は 4 bit、1 byte は 8 bit である。指定された byte を 2 進で答える。",
        "One hex digit is 4 bits and one byte is 8 bits. Answer the requested bytes in binary.",
      ),
      cases: [
        answerCase({
          id: "a",
          ja: "`a` (1 byte) の 2 進表示",
          en: "Binary of `a` (1 byte)",
          expected: bytesToBinary(PRIMARY_TRACE.message.slice(0, 1)),
          format: "binary",
        }),
        answerCase({
          id: "abc",
          ja: "`abc` (3 byte) の 2 進表示",
          en: "Binary of `abc` (3 bytes)",
          expected: bytesToBinary(PRIMARY_TRACE.message),
          format: "binary",
        }),
      ],
      hints: [
        hint(
          1,
          "0x61 = 0110 0001。16 進の桁ごとに 4 bit へ展開すればよい。",
          "0x61 = 0110 0001. Expand each hex digit into its own 4 bits.",
        ),
        hint(
          2,
          "先頭の 0 を落としてはいけない。1 byte は必ず 8 桁で書く。",
          "Do not drop leading zeros: one byte is always eight digits.",
        ),
      ],
    },
  ],
  explanation: [
    loc(
      "ハッシュが合わない相談で最も多いのが、この段の食い違いである。片方が UTF-8、もう片方が UTF-16 や Shift_JIS で byte 化していれば、以降の計算がすべて正しくてもハッシュは一致しない。",
      'This step is the most common source of "my hash doesn\'t match" reports. If one side encodes UTF-8 and the other UTF-16 or Shift_JIS, the digests differ no matter how correct the rest of the computation is.',
    ),
    loc(
      "したがって「文字列のハッシュ」を仕様に書くときは、必ずエンコーディングを併記する。API のドキュメントで `sha256(payload)` とだけ書かれていたら、それは仕様が不完全である。",
      'So when a spec says "the hash of a string", it must also state the encoding. An API doc that only says `sha256(payload)` is an incomplete spec.',
    ),
  ],
  nextStep: loc(
    "byte 列が手に入った。次は SHA-256 が計算できる形 (512 bit の倍数) へ整える。",
    "Now that we have bytes, the next step shapes them into what SHA-256 can process: a multiple of 512 bits.",
  ),
};

/** 節 2: パディング。 */
export const paddingSection: DrillSection = {
  id: "padding",
  order: 2,
  title: loc("パディングで 512 bit の倍数にする", "Pad to a multiple of 512 bits"),
  goal: loc(
    "1 bit の 1 → 0 埋め → 64 bit の長さ、という 3 段の目的をそれぞれ言えるようにする。",
    "Be able to say why each of the three pieces exists: the single 1 bit, the zero fill, and the 64-bit length.",
  ),
  reading: [
    loc(
      "圧縮関数は 512 bit の block しか処理できない。そこで入力の後ろに詰め物を足して長さを揃える。手順は 3 段で、順序も内容も固定である。",
      "The compression function only handles 512-bit blocks, so we append filler to reach that size. The procedure has three fixed steps.",
    ),
    loc(
      "第 1 段は 1 bit の `1` (byte 単位で見れば `0x80`)。これは「本文はここで終わり」の目印である。これが無いと、末尾に 0 が続く入力と、0 埋めしただけの短い入力が区別できなくなる。",
      "Step one is a single `1` bit — `0x80` at byte granularity. It marks where the message ends. Without it, a message ending in zeros could not be told apart from a shorter message that was merely zero-filled.",
    ),
    loc(
      "第 2 段は 0 埋め。第 3 段の長さ 8 byte が最後にちょうど収まるまで 0 を並べる。第 3 段は元のメッセージの **bit 長** を 64 bit のビッグエンディアンで書く。長さを刻むことで、パディングを剥がしたときに同じに見える入力どうしを区別できる。",
      "Step two fills with zeros until the 8-byte length field fits exactly at the end. Step three writes the original **bit** length as a 64-bit big-endian integer. Recording the length keeps inputs distinguishable that would look identical once the padding is stripped.",
    ),
    loc(
      "0 埋めは最小限しか入れないので、`0x80` と 8 byte の長さを置く余裕が残っていなければ block が 1 つ増える。55 byte が 1 block で収まる最後の長さで、56 byte から 2 block になるのはこの計算の結果である。",
      "The zero fill is minimal, so if there is no room left for `0x80` plus the 8 length bytes, one more block appears. That is why 55 bytes is the last length that fits in one block and 56 bytes needs two.",
    ),
  ],
  visual: {
    kind: "bit-lanes",
    groupSize: 8,
    lanes: [
      bitLane(
        "abc",
        bytesToBinary(PRIMARY_TRACE.message),
        loc("本文 3 byte。", "The 3-byte message."),
      ),
      bitLane(
        "0x80",
        bytesToBinary(PRIMARY_TRACE.padded.slice(3, 4)),
        loc("終端の 1 bit。", "The terminating 1 bit."),
      ),
      bitLane(
        "0x00 x 52",
        bytesToBinary(PRIMARY_TRACE.padded.slice(4, 8)),
        loc(
          "実際は 52 byte 続く (図は先頭 4 byte)。",
          "52 bytes in total; the figure shows the first four.",
        ),
      ),
      bitLane(
        "length",
        bytesToBinary(PRIMARY_TRACE.padded.slice(56)),
        loc(
          "24 bit = 0x18 をビッグエンディアン 64 bit で。",
          "24 bits = 0x18, written big-endian in 64 bits.",
        ),
      ),
    ],
  },
  tasks: [
    {
      id: "padding-shape",
      kind: "value",
      title: loc("`abc` のパディングを組み立てる", "Assemble the padding for `abc`"),
      instruction: loc(
        "`abc` (3 byte) にパディングを施した結果について答える。",
        "Answer the following about `abc` (3 bytes) after padding.",
      ),
      cases: [
        answerCase({
          id: "total",
          ja: "パディング後の総 byte 数 (10 進)",
          en: "Total bytes after padding (decimal)",
          expected: String(PRIMARY_TRACE.padded.length),
          format: "decimal",
        }),
        answerCase({
          id: "zeros",
          ja: "挿入される 0x00 の個数 (10 進)",
          en: "Number of inserted 0x00 bytes (decimal)",
          expected: String(zeroPaddingLength(PRIMARY_TRACE.message.length)),
          format: "decimal",
        }),
        answerCase({
          id: "length-field",
          ja: "末尾 8 byte の長さフィールド (16 進)",
          en: "The trailing 8-byte length field (hex)",
          expected: bytesToHex(PRIMARY_TRACE.padded.slice(56)),
          format: "hex",
        }),
        answerCase({
          id: "padded",
          ja: "パディング後の 64 byte 全体 (16 進)",
          en: "The whole padded block, 64 bytes (hex)",
          expected: paddedHex,
          format: "hex",
        }),
      ],
      hints: [
        hint(
          1,
          "長さフィールドは byte 数ではなく bit 数である。3 byte なら 24。",
          "The length field counts bits, not bytes: 3 bytes means 24.",
        ),
        hint(
          2,
          "0 埋めの個数は 64 - 本文 byte 数 - 1 (0x80) - 8 (長さ) で求まる。",
          "The zero count is 64 minus the message bytes, minus 1 for `0x80`, minus 8 for the length.",
        ),
        hint(
          3,
          "16 進で 24 は 0x18 である。64 bit フィールドなので上位 7 byte は 0 になる。",
          "24 is 0x18 in hex, and in a 64-bit field the upper seven bytes are zero.",
        ),
      ],
    },
    {
      id: "padding-boundary",
      kind: "implementation",
      title: loc("境界条件を計算する", "Compute the boundary cases"),
      instruction: loc(
        "パディング後の byte 数を返す関数を手元で書き、各入力長に対する値を答える。境界で block 数が変わる点を自分の実装で確かめる。",
        "Write a function that returns the padded length, run it locally, and answer for each input length. Confirm the block-count boundary with your own implementation.",
      ),
      starter: [
        "// 手元で実行して結果を貼る (ブラウザ上ではコードを実行しない)",
        "const paddedLength = (n) => Math.ceil((n + 1 + 8) / 64) * 64;",
        "for (const n of [0, 55, 56, 64, 119, 120]) console.log(n, paddedLength(n));",
      ].join("\n"),
      cases: [
        answerCase({
          id: "len-0",
          ja: "0 byte 入力のパディング後 byte 数",
          en: "Padded length for a 0-byte input",
          expected: String(paddedLength(0)),
          format: "decimal",
        }),
        answerCase({
          id: "len-55",
          ja: "55 byte 入力のパディング後 byte 数",
          en: "Padded length for a 55-byte input",
          expected: String(paddedLength(55)),
          format: "decimal",
        }),
        answerCase({
          id: "len-56",
          ja: "56 byte 入力のパディング後 byte 数",
          en: "Padded length for a 56-byte input",
          expected: String(paddedLength(56)),
          format: "decimal",
        }),
        answerCase({
          id: "len-64",
          ja: "64 byte 入力のパディング後 byte 数",
          en: "Padded length for a 64-byte input",
          expected: String(paddedLength(64)),
          format: "decimal",
        }),
        answerCase({
          id: "len-119",
          ja: "119 byte 入力のパディング後 byte 数",
          en: "Padded length for a 119-byte input",
          expected: String(paddedLength(119)),
          format: "decimal",
        }),
        answerCase({
          id: "len-120",
          ja: "120 byte 入力のパディング後 byte 数",
          en: "Padded length for a 120-byte input",
          expected: String(paddedLength(120)),
          format: "decimal",
        }),
      ],
      hints: [
        hint(
          1,
          "本文 + 1 byte + 8 byte を 64 の倍数へ切り上げる、が全部である。",
          "Round message + 1 byte + 8 bytes up to a multiple of 64. That is the whole rule.",
        ),
        hint(
          2,
          "ちょうど 64 byte の入力でも block は 2 つになる。パディングは省略できない。",
          "Even an input of exactly 64 bytes needs two blocks: padding is never skipped.",
        ),
      ],
    },
  ],
  explanation: [
    loc(
      "長さを末尾に刻む設計は Merkle-Damgård 構造の「長さ強化」と呼ばれる。これが無いと、末尾に 0 を足しただけの別入力が同じハッシュになる場合が出てしまう。",
      "Appending the length is called length strengthening in the Merkle-Damgård construction. Without it, some inputs that differ only by trailing zeros would hash to the same value.",
    ),
    loc(
      "パディングは常に 1 byte 以上入る (入力がちょうど 64 byte の倍数でも block が 1 つ増える) という点も重要である。「ちょうど割り切れるならパディング不要」は誤りで、実装するとテストベクタの 64 byte のケースで落ちる。",
      'Padding is also never empty: even when the input is an exact multiple of 64 bytes, one more block appears. "No padding needed when it divides evenly" is wrong, and an implementation that assumes it fails the 64-byte test vector.',
    ),
  ],
  nextStep: loc(
    "512 bit の block が手に入った。次はこれを 32 bit 語 16 個として読む。",
    "With a 512-bit block in hand, the next step reads it as sixteen 32-bit words.",
  ),
};

/** 節 3: block を 16 語へ。 */
export const wordsSection: DrillSection = {
  id: "block-to-words",
  order: 3,
  title: loc("block を 16 個の 32 bit 語にする", "Split the block into sixteen 32-bit words"),
  goal: loc(
    "512 bit を 32 bit 語 16 個として読み、ビッグエンディアンの並びを確認する。",
    "Read 512 bits as sixteen 32-bit words and confirm the big-endian ordering.",
  ),
  reading: [
    loc(
      "SHA-256 の計算はすべて 32 bit 語の上で行われる。512 bit の block はそのまま 32 bit × 16 語になる。",
      "Everything in SHA-256 happens on 32-bit words, and a 512-bit block is exactly sixteen of them.",
    ),
    loc(
      "並べ方はビッグエンディアン、つまり先頭の byte が語の最上位に入る。`61 62 63 80` の 4 byte は `0x61626380` になる。リトルエンディアンで読むと `0x80636261` になり、ここを取り違えると以降の中間値が全部ずれる。",
      "The order is big-endian: the first byte lands in the most significant position. The bytes `61 62 63 80` become `0x61626380`. Read little-endian they would become `0x80636261`, and every later intermediate value would be wrong.",
    ),
    loc(
      "多くの CPU がリトルエンディアンで動くため、`memcpy` で 4 byte をそのまま整数へ写すと逆順になる。ここは明示的に byte を組み立てる必要がある。",
      "Most CPUs are little-endian, so copying 4 raw bytes into an integer flips the order. This is a place where the bytes must be assembled explicitly.",
    ),
  ],
  visual: {
    kind: "words",
    rows: [
      wordRow(
        "W[0]",
        PRIMARY_BLOCK.words[0],
        loc("`61 62 63 80` をビッグエンディアンで読んだ値。", "`61 62 63 80` read big-endian."),
      ),
      wordRow("W[1]", PRIMARY_BLOCK.words[1]),
      wordRow("W[14]", PRIMARY_BLOCK.words[14]),
      wordRow(
        "W[15]",
        PRIMARY_BLOCK.words[15],
        loc("長さフィールドの下位 32 bit = 24。", "The low 32 bits of the length field: 24."),
      ),
    ],
  },
  tasks: [
    {
      id: "words-of-abc",
      kind: "value",
      title: loc("`abc` の block を語に分ける", "Split the `abc` block into words"),
      instruction: loc(
        "パディング済みの 64 byte をビッグエンディアンで 16 語に読み、指定された語を 8 桁の 16 進で答える。",
        "Read the padded 64 bytes big-endian as sixteen words and answer the requested ones as 8 hex digits.",
      ),
      cases: [
        answerCase({
          id: "w0",
          ja: "W[0]",
          en: "W[0]",
          expected: toHex32(PRIMARY_BLOCK.words[0]),
          format: "hex",
        }),
        answerCase({
          id: "w1",
          ja: "W[1]",
          en: "W[1]",
          expected: toHex32(PRIMARY_BLOCK.words[1]),
          format: "hex",
        }),
        answerCase({
          id: "w15",
          ja: "W[15]",
          en: "W[15]",
          expected: toHex32(PRIMARY_BLOCK.words[15]),
          format: "hex",
        }),
      ],
      hints: [
        hint(
          1,
          "W[0] は本文 `abc` の 3 byte と終端の 0x80 で埋まる。",
          "W[0] is filled by the three message bytes of `abc` plus the terminating 0x80.",
        ),
        hint(
          2,
          "8 桁に満たない値は上位を 0 で埋めて書く。24 は `00000018`。",
          "Pad shorter values with leading zeros to eight digits: 24 is `00000018`.",
        ),
      ],
    },
    {
      id: "endianness",
      kind: "value",
      title: loc("エンディアンを取り違えた値", "The value you get with the wrong endianness"),
      instruction: loc(
        "`61 62 63 80` の 4 byte をリトルエンディアンで (最後の byte を最上位として) 読んだ値を 16 進で答える。誤った読み方の結果を一度自分で出しておくと、実装のバグを見分けられるようになる。",
        "Read the four bytes `61 62 63 80` little-endian — last byte most significant — and answer in hex. Producing the wrong value once makes the bug recognisable later.",
      ),
      cases: [
        answerCase({
          id: "little-endian",
          ja: "`61 62 63 80` をリトルエンディアンで読んだ値",
          en: "`61 62 63 80` read little-endian",
          expected: "80636261",
          format: "hex",
        }),
      ],
      hints: [
        hint(1, "byte の並びをそのまま逆にすればよい。", "Simply reverse the order of the bytes."),
      ],
    },
  ],
  explanation: [
    loc(
      "ビッグエンディアンは「人が 16 進で書いたときの見た目と同じ順」である。ダイジェストの出力もビッグエンディアンなので、SHA-256 の中では最初から最後まで並びが一貫している。",
      'Big-endian is "the same order a human writes hex in". The digest is emitted big-endian too, so the byte order stays consistent from start to finish inside SHA-256.',
    ),
    loc(
      "エンディアンの取り違えは、テストベクタを 1 つ通すだけで必ず見つかる種類のバグである。逆に言えば、テストベクタを通していない実装はこの誤りを抱えたまま動いてしまう。",
      "An endianness mistake is the kind of bug a single test vector always catches — which also means an implementation that skips test vectors can ship with it.",
    ),
  ],
  nextStep: loc(
    "語が揃った。次は語を回す・ずらすという 2 つの基本操作に入る。",
    "With the words in place, next come the two basic operations: rotating and shifting.",
  ),
};
