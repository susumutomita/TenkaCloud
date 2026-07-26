/**
 * 節 13〜15: Avalanche Effect → ハッシュ関数とは何か → パスワード保存。
 *
 * 実装が終わったあとに置く「使い方を誤らないための節」。SHA-256 を書けるようになった
 * 直後こそ、パスワードを SHA-256 で保存する誤りに踏み込みやすい。
 */

import { answerCase, choice, hint, loc } from "../../drill/authoring";
import type { DrillSection } from "../../drill/types";
import { digestDiff } from "../avalanche";
import { AVALANCHE_INPUT, AVALANCHE_TRACE, PRIMARY_INPUT, PRIMARY_TRACE } from "../fixtures";

const DIFF = digestDiff(PRIMARY_TRACE.digest, AVALANCHE_TRACE.digest);

/** 節 13: Avalanche Effect。 */
export const avalancheSection: DrillSection = {
  id: "avalanche-effect",
  order: 13,
  title: loc("Avalanche Effect — 1 bit の変化", "The avalanche effect: one bit changed"),
  goal: loc(
    "入力 1 bit の変化が出力の約半分を変えることを、実際に数えて確認する。",
    "Confirm by counting that changing one input bit flips about half the output bits.",
  ),
  reading: [
    loc(
      `\`${PRIMARY_INPUT}\` と \`${AVALANCHE_INPUT}\` は最後の 1 文字だけが違う。byte で見ると 0x63 と 0x64 で、2 進では 01100011 と 01100100、つまり 3 bit だけ違う。`,
      `\`${PRIMARY_INPUT}\` and \`${AVALANCHE_INPUT}\` differ only in the last character: 0x63 versus 0x64, which is 01100011 versus 01100100 — three bits apart.`,
    ),
    loc(
      "この 3 bit の差が、message schedule で 64 語へ広がり、64 ラウンドで 8 レジスタ全体へ伝播する。結果として出力 256 bit のうちおよそ半分が変わる。これを Avalanche Effect (雪崩効果) と呼ぶ。",
      "Those three bits spread across 64 schedule words and propagate through all eight registers over 64 rounds. About half of the 256 output bits end up different. This is the avalanche effect.",
    ),
    loc(
      "「半分」は偶然ではなく設計目標である。入力の変化と出力の変化に相関があれば、その相関を使って逆算や衝突探索の足場が作れてしまう。良いハッシュ関数の出力は、入力をわずかに変えるだけで独立な乱数のように見えなければならない。",
      '"About half" is a design goal, not a coincidence. Any correlation between input and output changes would give an attacker a foothold for inversion or collision search. A good hash must look like an independent random value after even a tiny input change.',
    ),
  ],
  visual: {
    kind: "hash-diff",
    rows: [
      { label: PRIMARY_INPUT, hex: PRIMARY_TRACE.digest },
      { label: AVALANCHE_INPUT, hex: AVALANCHE_TRACE.digest },
    ],
  },
  tasks: [
    {
      id: "avalanche-count",
      kind: "implementation",
      title: loc("変化した bit を数える", "Count the changed bits"),
      instruction: loc(
        `2 つのダイジェストを XOR して立っている bit を数える。実装は \`popcount\` を書くだけでよい。`,
        "XOR the two digests and count the set bits. All you need is a popcount.",
      ),
      starter: [
        "const a = BigInt('0x' + digestA);",
        "const b = BigInt('0x' + digestB);",
        "const bits = (a ^ b).toString(2).split('').filter((c) => c === '1').length;",
        "console.log(bits);",
      ].join("\n"),
      cases: [
        answerCase({
          id: "digest-abd",
          ja: `\`${AVALANCHE_INPUT}\` の SHA-256`,
          en: `SHA-256 of \`${AVALANCHE_INPUT}\``,
          expected: AVALANCHE_TRACE.digest,
          format: "hex",
        }),
        answerCase({
          id: "differing-bits",
          ja: "2 つのダイジェストで異なる bit 数 (10 進)",
          en: "Number of differing bits between the two digests (decimal)",
          expected: String(DIFF.differingBits),
          format: "decimal",
        }),
        answerCase({
          id: "differing-nibbles",
          ja: "異なる 16 進桁の数 (10 進、全 64 桁中)",
          en: "Number of differing hex digits, out of 64 (decimal)",
          expected: String(DIFF.differingNibbles),
          format: "decimal",
        }),
      ],
      hints: [
        hint(
          1,
          "256 bit の半分は 128 である。答えはその近く (ちょうど 128 ではない) になる。",
          "Half of 256 is 128, and the answer lands near it — but not exactly on it.",
        ),
        hint(
          2,
          "16 進 1 桁は 4 bit なので、異なる桁数は異なる bit 数より少なくなる (1 桁の中で 1 bit だけ違うこともある)。",
          "One hex digit is 4 bits, so the digit count is lower than the bit count: a digit can differ in only one of its bits.",
        ),
      ],
    },
  ],
  explanation: [
    loc(
      `実測で ${DIFF.differingBits} / ${DIFF.totalBits} bit が変わった。ちょうど半分ではないが、独立なコイン投げ 256 回の結果として自然な範囲である。逆に、常にちょうど 128 bit 変わるなら、それは規則性があるということで、むしろ弱い。`,
      `The measured change is ${DIFF.differingBits} of ${DIFF.totalBits} bits. Not exactly half, but well within what 256 independent coin flips would produce. A hash that always changed exactly 128 bits would be exhibiting structure — and would be weaker for it.`,
    ),
    loc(
      "この性質は運用面でも意味がある。ファイルの 1 byte が壊れたときハッシュは全く違う値になるので、破損を静かに見逃さない。逆に「似た入力なら似たハッシュ」を期待する用途 (類似画像検索など) には SHA-256 は使えない。そこで使うのは perceptual hash のような別種の関数である。",
      "The property matters operationally too: a single corrupted byte changes the digest completely, so corruption is never silently missed. Conversely, SHA-256 is useless where you want similar inputs to hash similarly, such as near-duplicate image search — that needs a different family, like perceptual hashes.",
    ),
  ],
  nextStep: loc(
    "内部が分かったので、ハッシュ関数そのものの性質を整理する。",
    "With the internals understood, let us set out what a hash function is and is not.",
  ),
};

/** 節 14: ハッシュ関数の性質。 */
export const hashConceptSection: DrillSection = {
  id: "what-is-a-hash",
  order: 14,
  title: loc("ハッシュ関数とは何か", "What a hash function is"),
  goal: loc(
    "暗号化との違い、衝突の意味、出力長が一定である理由を説明できるようにする。",
    "Be able to explain how hashing differs from encryption, what a collision is, and why the output length is fixed.",
  ),
  reading: [
    loc(
      "ここまでの計算に「鍵」は 1 つも出てこなかった。SHA-256 は暗号化ではないので、復号という操作が定義されていない。暗号化は鍵で戻せることが前提だが、ハッシュは戻せないことが目的である。",
      "Not once did a key appear in the computation. SHA-256 is not encryption, so decryption is not even defined for it. Encryption exists to be reversible with a key; hashing exists not to be reversible at all.",
    ),
    loc(
      "入力は任意長で、出力は常に 256 bit である。任意長の集合から有限の集合への写像なので、異なる入力が同じ出力になる組 (衝突) は数学的に必ず存在する。SHA-256 が安全と言えるのは「衝突が存在しない」からではなく「見つけるのが現実的でない」からである。",
      "Inputs are arbitrary length and outputs are always 256 bits. Mapping an unbounded set into a finite one guarantees that pairs of inputs share an output — collisions must exist. SHA-256 is called secure not because collisions do not exist but because finding one is not feasible.",
    ),
    loc(
      "「ハッシュを復号する」と称するサイトは、実際には辞書 (よくある入力とそのハッシュの対応表) を引いているだけである。復号しているのではなく、答えを事前に総当たりして持っている。",
      'Sites that claim to "decrypt a hash" are really just consulting a dictionary of common inputs and their digests. They are not reversing anything — they precomputed the answers.',
    ),
  ],
  tasks: [
    {
      id: "not-encryption",
      kind: "choice",
      multi: false,
      title: loc("SHA-256 は復号できるか", "Can SHA-256 be decrypted?"),
      instruction: loc("最も正確な記述を 1 つ選ぶ。", "Choose the single most accurate statement."),
      choices: [
        choice({
          id: "no-decrypt",
          ja: "復号は定義されていない。鍵が無く、計算の途中で情報が捨てられているため元の入力は復元できない",
          en: "Decryption is not defined: there is no key, and information is discarded during the computation, so the input cannot be recovered",
          correct: true,
          rationaleJa:
            "節 12 の足し戻しで情報が落ちる。任意長の入力を 256 bit へ写す時点で情報量が保たれない。",
          rationaleEn:
            "The addition in section 12 destroys information, and mapping arbitrary-length input into 256 bits cannot preserve it either.",
        }),
        choice({
          id: "with-key",
          ja: "専用の鍵があれば復号できる",
          en: "It can be decrypted if you have the right key",
          correct: false,
          rationaleJa:
            "SHA-256 に鍵は存在しない。鍵付きの構成が必要なら HMAC のような別の仕組みを使う。",
          rationaleEn:
            "SHA-256 has no key. If you need a keyed construction, that is what HMAC is for.",
        }),
        choice({
          id: "slow-but-possible",
          ja: "時間はかかるが逆算アルゴリズムは存在する",
          en: "An inversion algorithm exists, it is just slow",
          correct: false,
          rationaleJa: "総当たりは逆算アルゴリズムではない。原像を求める既知の効率的手法は無い。",
          rationaleEn:
            "Brute force is not an inversion algorithm; no efficient preimage method is known.",
        }),
      ],
      hints: [
        hint(
          1,
          "節 12 で「情報が落ちる」と書いた箇所を思い出す。",
          "Recall where section 12 said information is destroyed.",
        ),
      ],
    },
    {
      id: "collisions",
      kind: "choice",
      multi: true,
      title: loc("衝突について正しい記述を選ぶ", "Select the true statements about collisions"),
      instruction: loc(
        "衝突 (collision) に関して正しい記述をすべて選ぶ。",
        "Select every true statement about collisions.",
      ),
      choices: [
        choice({
          id: "must-exist",
          ja: "衝突は必ず存在する (任意長の入力を有限長の出力へ写すため)",
          en: "Collisions must exist, because arbitrary-length inputs map into fixed-length outputs",
          correct: true,
          rationaleJa: "鳩の巣原理そのものである。存在しないハッシュ関数は作れない。",
          rationaleEn: "This is the pigeonhole principle; no hash function can avoid it.",
        }),
        choice({
          id: "hard-to-find",
          ja: "SHA-256 の安全性は「衝突を見つけるのが現実的でない」ことに依る",
          en: "SHA-256's security rests on collisions being infeasible to find",
          correct: true,
          rationaleJa:
            "誕生日攻撃を考えても 2^128 程度の計算が要る。存在の有無ではなく発見の困難さが根拠である。",
          rationaleEn:
            "Even a birthday attack needs on the order of 2^128 work. The basis is difficulty of discovery, not non-existence.",
        }),
        choice({
          id: "sha1-broken",
          ja: "SHA-1 は実際に衝突が構成されたため、新規の用途では使わない",
          en: "SHA-1 has had real collisions constructed, so it should not be used for new work",
          correct: true,
          rationaleJa:
            "2017 年の SHAttered で、意味のある 2 つの PDF が同じ SHA-1 になる例が公開された。",
          rationaleEn:
            "The 2017 SHAttered result published two meaningful PDFs with the same SHA-1.",
        }),
        choice({
          id: "no-collision",
          ja: "SHA-256 は出力が 256 bit あるので、衝突は存在しない",
          en: "Because SHA-256 outputs 256 bits, it has no collisions",
          correct: false,
          rationaleJa: "出力長をいくら伸ばしても、入力が任意長である限り衝突は存在する。",
          rationaleEn: "No output length removes collisions while the input length is unbounded.",
        }),
      ],
      hints: [
        hint(
          1,
          "「存在する」と「見つけられる」を分けて考える。",
          'Separate "exists" from "can be found".',
        ),
      ],
    },
    {
      id: "fixed-length",
      kind: "choice",
      multi: true,
      title: loc("出力長が一定な理由", "Why the output length is fixed"),
      instruction: loc(
        "出力が常に 256 bit である理由・帰結として正しいものをすべて選ぶ。",
        "Select every correct reason for, or consequence of, the fixed 256-bit output.",
      ),
      choices: [
        choice({
          id: "block-chain",
          ja: "block ごとに同じ 8 語の状態を更新し続ける構造なので、入力長に関係なく状態の大きさが変わらない",
          en: "Each block updates the same eight-word state, so the state size never depends on the input length",
          correct: true,
          rationaleJa: "節 12 の繰り返し構造 (Merkle-Damgård) から直接出てくる帰結である。",
          rationaleEn:
            "It follows directly from the iterated structure in section 12 (Merkle-Damgård).",
        }),
        choice({
          id: "storage",
          ja: "保存や比較の実装が簡単になる (固定長の列として扱える)",
          en: "It makes storage and comparison simple, since the value is a fixed-size field",
          correct: true,
          rationaleJa: "固定長は索引やインデックス設計の前提として扱いやすい。",
          rationaleEn: "Fixed-length values are easy to index and compare.",
        }),
        choice({
          id: "leak-length",
          ja: "出力からは元の入力長が分からない",
          en: "The output does not reveal the original input length",
          correct: true,
          rationaleJa:
            "1 byte でも 1 GB でも同じ 64 桁になる。長さを隠したいときの性質として使える。",
          rationaleEn:
            "One byte and one gigabyte both give 64 digits, which is useful when the length should stay hidden.",
        }),
        choice({
          id: "compression",
          ja: "任意のデータを 256 bit へ可逆圧縮できる",
          en: "It losslessly compresses arbitrary data into 256 bits",
          correct: false,
          rationaleJa:
            "可逆圧縮ではない。復元できない写像であり、圧縮アルゴリズムとしては使えない。",
          rationaleEn:
            "It is not compression: the mapping cannot be undone, so it is useless as a codec.",
        }),
      ],
      hints: [
        hint(
          1,
          "節 12 で block をまたぐときに何を引き継いだかを思い出す。",
          "Recall what was carried from block to block in section 12.",
        ),
      ],
    },
  ],
  explanation: [
    loc(
      "ハッシュ関数の用途は、同一性の確認 (ファイルの改ざん検知、Git のオブジェクト ID)、コミットメント (先に値を公開して後で中身を明かす)、データ構造の索引などである。いずれも「戻せない」ことを前提に成り立っている。",
      "Hashes are used for identity checks (tamper detection, Git object IDs), commitments (publish a value now, reveal the content later), and indexing data structures. All of these rely on the value not being reversible.",
    ),
    loc(
      "一方、鍵を使って「この人が計算した」ことを示したい場合はハッシュ単体では足りない。HMAC のような鍵付き構成が必要になる (このドリル形式の次の題材である)。",
      "When you need to show that a specific party computed the value, a bare hash is not enough: you need a keyed construction such as HMAC — the next topic in this drill format.",
    ),
  ],
  nextStep: loc(
    "最後に、SHA-256 を使ってはいけない代表的な用途を 1 つ扱う。",
    "Finally, one prominent job that SHA-256 must not be used for.",
  ),
};

/** 節 15: パスワード保存。 */
export const passwordStorageSection: DrillSection = {
  id: "password-storage",
  order: 15,
  title: loc("パスワード保存に SHA-256 を使わない理由", "Why not to store passwords with SHA-256"),
  goal: loc(
    "SHA-256 が速いことがパスワード保存では欠点になることと、代わりに使う関数を言えるようにする。",
    "Understand that SHA-256's speed is a liability for password storage, and know what to use instead.",
  ),
  reading: [
    loc(
      "ここまで見たとおり SHA-256 は非常に軽い。1 block あたり 64 ラウンドの整数演算だけで、専用ハードウェアなら 1 秒に数十億回計算できる。ファイルの改ざん検知にはこの速さが利点である。",
      "As we have seen, SHA-256 is cheap: 64 rounds of integer arithmetic per block, and dedicated hardware performs billions of them per second. For tamper detection that speed is a feature.",
    ),
    loc(
      "パスワード保存では、それがそのまま欠点になる。攻撃者がハッシュの一覧を手に入れたとき、候補パスワードを次々にハッシュして突き合わせる総当たりが速く回ってしまう。人間が選ぶパスワードの空間は狭いので、辞書と規則変形だけで大半が割れる。",
      "For password storage the same speed works against you. If an attacker obtains the stored hashes, they can hash candidate passwords and compare at the same billions-per-second rate. Human-chosen passwords occupy a small space, so a dictionary plus a few mangling rules recovers most of them.",
    ),
    loc(
      "さらに salt が無ければ、同じパスワードは同じハッシュになる。事前計算した表 (レインボーテーブル) を 1 つ用意すれば全ユーザーに使い回せてしまう。salt を足せばこれは防げるが、総当たりの速さは変わらない。",
      "Without a salt, identical passwords produce identical hashes, so one precomputed table (a rainbow table) serves every user at once. Adding a salt stops that, but it does nothing about the speed of brute force.",
    ),
    loc(
      "パスワード保存に使うべきなのは、計算コストを設定できる関数である。Argon2 / bcrypt / scrypt / PBKDF2 はいずれも「時間」や「メモリ量」をパラメータとして持ち、検証 1 回に意図的に数十〜数百ミリ秒かけられる。正規のログインでは無視できる遅さだが、総当たりの速度は桁で落ちる。",
      "Password storage calls for a function whose cost you can set. Argon2, bcrypt, scrypt, and PBKDF2 all take time and/or memory parameters, letting one verification deliberately take tens to hundreds of milliseconds — negligible for a real login, orders of magnitude slower for brute force.",
    ),
  ],
  tasks: [
    {
      id: "appropriate-functions",
      kind: "choice",
      multi: true,
      title: loc("パスワード保存に適した関数を選ぶ", "Pick the functions fit for password storage"),
      instruction: loc(
        "パスワードの保存 (ハッシュ化して保管し、ログイン時に検証する) に適した関数をすべて選ぶ。",
        "Select every function suited to storing passwords for later verification at login.",
      ),
      choices: [
        choice({
          id: "argon2",
          ja: "Argon2",
          en: "Argon2",
          correct: true,
          rationaleJa: "時間・メモリ・並列度をパラメータに持つ。新規実装の第一候補である。",
          rationaleEn:
            "Takes time, memory, and parallelism parameters. The default choice for new work.",
        }),
        choice({
          id: "bcrypt",
          ja: "bcrypt",
          en: "bcrypt",
          correct: true,
          rationaleJa: "cost パラメータで計算量を上げられる。実績が長く、多くの言語に実装がある。",
          rationaleEn:
            "A cost parameter raises the work factor; long track record and implementations everywhere.",
        }),
        choice({
          id: "scrypt",
          ja: "scrypt",
          en: "scrypt",
          correct: true,
          rationaleJa: "メモリ量を要求することで専用ハードウェアによる並列化を難しくする。",
          rationaleEn: "Demanding memory makes parallel attacks on dedicated hardware harder.",
        }),
        choice({
          id: "pbkdf2",
          ja: "PBKDF2",
          en: "PBKDF2",
          correct: true,
          rationaleJa:
            "反復回数で計算量を上げられる。メモリ硬性は無いが、標準として広く認められている。",
          rationaleEn:
            "Iteration count raises the work factor. It is not memory-hard, but it is a widely accepted standard.",
        }),
        choice({
          id: "sha256",
          ja: "SHA-256 を 1 回",
          en: "A single SHA-256",
          correct: false,
          rationaleJa: "速すぎる。計算コストを調整する手段が無い。",
          rationaleEn: "Far too fast, with no way to tune the cost.",
        }),
        choice({
          id: "sha256-salt",
          ja: "SHA-256(salt + password) を 1 回",
          en: "A single SHA-256(salt + password)",
          correct: false,
          rationaleJa:
            "salt はレインボーテーブルを防ぐが、総当たりの速度は落ちない。コストパラメータが無いのが問題である。",
          rationaleEn:
            "The salt defeats rainbow tables but not brute force. The missing piece is a cost parameter.",
        }),
      ],
      hints: [
        hint(
          1,
          "「計算コストを後から上げられるか」を基準に選ぶ。",
          "Judge by whether the cost can be raised later.",
        ),
        hint(
          2,
          "salt の追加とコストパラメータは別の対策である。片方だけでは足りない。",
          "Salting and cost parameters are different defences; one without the other is not enough.",
        ),
      ],
    },
    {
      id: "why-unsuitable",
      kind: "choice",
      multi: true,
      title: loc("SHA-256 単体が不適な理由", "Why a bare SHA-256 is unsuitable"),
      instruction: loc(
        "`SHA256(password)` でパスワードを保存することの問題点をすべて選ぶ。",
        "Select every problem with storing passwords as `SHA256(password)`.",
      ),
      choices: [
        choice({
          id: "too-fast",
          ja: "計算が速いため、総当たり・辞書攻撃が現実的な時間で回る",
          en: "It is fast, so brute-force and dictionary attacks run in realistic time",
          correct: true,
          rationaleJa:
            "専用ハードで毎秒数十億回計算できる。人が選ぶパスワードの空間はそれに耐えられない。",
          rationaleEn:
            "Dedicated hardware computes billions per second, which the space of human-chosen passwords cannot survive.",
        }),
        choice({
          id: "no-salt",
          ja: "salt が無いため、同じパスワードが同じハッシュになりレインボーテーブルが効く",
          en: "Without a salt, identical passwords give identical hashes and rainbow tables apply",
          correct: true,
          rationaleJa: "1 つの事前計算表を全ユーザーへ使い回せてしまう。",
          rationaleEn: "One precomputed table can be reused against every user.",
        }),
        choice({
          id: "no-cost",
          ja: "計算コストを調整するパラメータが無く、ハードウェアの進歩に追随できない",
          en: "There is no cost parameter, so it cannot keep up as hardware improves",
          correct: true,
          rationaleJa:
            "bcrypt の cost や Argon2 の time/memory に相当する調整点が SHA-256 には無い。",
          rationaleEn:
            "SHA-256 has no equivalent of bcrypt's cost or Argon2's time and memory settings.",
        }),
        choice({
          id: "collision-risk",
          ja: "SHA-256 に既知の衝突があるため、別のパスワードでログインできてしまう",
          en: "Known SHA-256 collisions would let a different password log in",
          correct: false,
          rationaleJa:
            "SHA-256 に実用的な衝突は知られていない。パスワード保存の問題は衝突ではなく速さである。",
          rationaleEn:
            "No practical SHA-256 collision is known. The password problem is speed, not collisions.",
        }),
      ],
      hints: [
        hint(
          1,
          "「衝突」と「総当たり」は別の話である。ここで効いているのはどちらかを考える。",
          "Collisions and brute force are different concerns; work out which one applies here.",
        ),
      ],
    },
  ],
  explanation: [
    loc(
      "用途の違いを一言でまとめると、SHA-256 は「速いことが利点の場面」で使い、パスワード保存は「遅いことが利点の場面」である。同じ道具ではない。",
      "In one line: SHA-256 belongs where speed is a benefit, and password storage is a place where slowness is the benefit. They are not the same tool.",
    ),
    loc(
      "なお、パスワード用の関数の内部でも SHA-256 は使われている (PBKDF2-HMAC-SHA256 など)。SHA-256 が悪いのではなく、コストパラメータ付きの構成で包まずに使うことが誤りである。このドリルで身につけた「内部で何が起きているか」の視点は、そうした構成を読むときにそのまま効く。",
      "Note that SHA-256 does appear inside password functions, for example in PBKDF2-HMAC-SHA256. SHA-256 is not the villain; using it without a cost-parameterised construction around it is the mistake. The habit this drill builds — looking at what happens inside — transfers directly to reading those constructions.",
    ),
  ],
  nextStep: loc(
    "SHA-256 のドリルは以上である。同じ形式で HMAC / PBKDF2 / AES へ進める。",
    "That completes the SHA-256 drill. The same format continues into HMAC, PBKDF2, and AES.",
  ),
};
