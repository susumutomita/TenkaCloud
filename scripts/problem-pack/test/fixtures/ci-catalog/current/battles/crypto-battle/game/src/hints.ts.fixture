import { advancedHints } from "./advanced-hints.ts";
import { vigenereGuide } from "./vigenere-guide.ts";
import { rotorGuide } from "./rotor-guide.ts";
import { rsaGuide } from "./rsa-guide.ts";
/**
 * [Issue #659 §9/§13] The hint ladder: what a team may buy when an Order is in
 * front of them and they do not know how to start.
 *
 * ## Why a Battle needs one at all
 *
 * Every other move in this game is a TRADE against another team. LEAK buys
 * five minutes and pays for it with a published pair; ROTATE buys safety and
 * pays for it with a batch. None of them EXPLAIN anything — a team that does
 * not know how a masked subtotal is built learns nothing from leaking it, and
 * the Order after that one is the same wall.
 *
 * #659 §9 names that gap when it picks the booster (「ヒントを開いても減点なし」)
 * as the handicap for the last-place team, over the two alternatives it
 * rejects: 「下位に自動計算機を配る」 skips the calculation, so 「一番学ぶ必要の
 * あるチームが計算を飛ばす」. A hint is the only aid on the list that leaves the
 * player doing the work. That is what makes it the right handicap, and it is
 * also why the mechanism has to exist BEFORE the item that waives its price —
 * §13's ordering, 「ヒント機構の新設 → ブースター / ライトニング」.
 *
 * ## Why the text lives here and not in the Portal
 *
 * Every other participant-facing string in this Battle lives in the Portal's
 * locale tables (see `portal/orderTask.ts`). A hint cannot: the Portal bundle
 * is delivered to the browser in full, so a hint compiled into it is readable
 * in devtools by anyone willing to look, and its price — the entire mechanism —
 * would apply only to players who did not think to look. Priced content has to
 * be withheld by the side that holds the state, so hint text ships on the
 * projection, and only for the levels a team has actually opened
 * (`projectForTeam`). Both locales travel together because `projectForTeam` has
 * no locale to choose by; the Portal picks.
 *
 * ## What a hint may and may not say
 *
 * [Issue #712] A hint is rendered against the Order in front of the reader
 * ({@link HintContext}): the public payload, the reader's own private inputs
 * (which their projection already shows them), and their own vault. The owner's
 * bar, set on a live run: a reader with junior-high maths and no vocabulary must
 * be able to open the rungs and complete the Order. So the rungs climb
 * **what this is → how it works → the formula, with a one-digit example → this
 * Order's numbers, one line at a time**, and the last rung ends where the
 * reader writes the answer. That is not a leak: everything the last rung quotes
 * is on the same screen already.
 *
 * What a hint must never carry is ANOTHER team's material, and the context
 * makes that structural -- nothing about other teams is in it. `hints.test.ts`
 * renders every rung in a field big enough for a substring search to mean
 * something and checks no other team's secret or un-leaked share appears.
 */

import { handWorkSteps } from "./commitment.ts";
import type { SubmissionMethod } from "./methods.ts";
import type { OrderTaskKind, OrderTaskProjection, VaultProjection } from "./types.ts";

/**
 * [Issue #712] What a hint may read when it is rendered: the Order in front of
 * the reader -- INCLUDING the private inputs their own projection already
 * carries (an MPC office's number, a ladder key) -- and the reader's own vault.
 *
 * Everything here is already on the projection handed to this team, so a hint
 * that quotes it reveals nothing the screen does not. What it must never
 * contain is another team's material, and it cannot: nothing about other
 * teams is in this context, and `hints.test.ts` projects a hint in a field
 * large enough for a substring search to be meaningful and checks that no
 * other team's secret or un-leaked share appears in any rendered rung.
 */
export interface HintContext {
  readonly task: OrderTaskProjection;
  readonly vault: VaultProjection;
  /** The match's modulus, as the Order shows it. */
  readonly prime: string;
  readonly threshold: number;
  readonly shareCount: number;
  readonly allowedMethods: readonly SubmissionMethod[];
  /** Distinct, already-public indices from only this team and generation. */
  readonly exposedShareIndices: readonly number[];
}

/** The two locales this Battle ships copy in (see `portal/orderTask.ts`). */
export type HintLocale = "ja" | "en";

export type HintText = Readonly<Record<HintLocale, string>>;

export interface HintSpec {
  /**
   * Stable identifier, `<task kind>/<level+1>`. Carried on the projection so an
   * operator reading a raw payload — or a replay — can tell which hint a team
   * bought without diffing prose.
   */
  readonly id: string;
  /**
   * [Issue #712] Rendered against the Order the reader is looking at, so the
   * last rung can walk the calculation with THEIR numbers. A rung that needs no
   * numbers simply ignores its argument.
   */
  readonly text: (ctx: HintContext) => HintText;
}

/**
 * How many hints every Order carries.
 *
 * Fixed across task kinds on purpose. A team choosing between two Orders is
 * already weighing points, deadline, privacy rule and method; "and this one has
 * more help available than that one" is a fifth axis that buys nothing and
 * makes the price of a hint depend on which Order you are looking at.
 * `hints.test.ts` pins every ladder to this length, and pins
 * `ScoreRules.hintCosts` to it too — a level with no price is a free hint.
 */
export const HINT_LEVELS = 3;

/**
 * The ladders, by task kind. Level order is array order: 0 is opened first.
 *
 * [Issue #712] Each ladder climbs the same three rungs -- what this is and how
 * it works, the formula with a one-digit example, this Order's own numbers one
 * line at a time -- and the last rung stops at the final expression the reader
 * evaluates themselves. That is the owner's bar from a live run: a reader with
 * junior-high maths and no vocabulary must be able to open the rungs and finish
 * the Order. Twelve junior-high-role readers answered 12/12 real Orders from
 * these rungs alone (three seeds x four kinds) before this landed.
 */
export const HINT_LADDER: Readonly<Record<OrderTaskKind, readonly HintSpec[]>> = {
  "ssm-decrypt": ([0, 1, 2] as const).map(level => ({id: `ssm-decrypt/${level+1}`, text: (ctx: HintContext) => {
    const hint = advancedHints(ctx, level);
    if (!hint || ctx.task.kind !== "ssm-decrypt") throw new Error("Wrong task for ssm-decrypt hint");
    return hint;
  }})),
  "enigma-encrypt": ([0, 1, 2] as const).map(level => ({id: `enigma-encrypt/${level+1}`, text: (ctx: HintContext) => {
    const hint = advancedHints(ctx, level);
    if (!hint || ctx.task.kind !== "enigma-encrypt") throw new Error("Wrong task for enigma-encrypt hint");
    return hint;
  }})),
  "rsa-decrypt": ([0, 1, 2] as const).map(level => ({id: `rsa-decrypt/${level+1}`, text: (ctx: HintContext) => {
    const hint = advancedHints(ctx, level);
    if (!hint || ctx.task.kind !== "rsa-decrypt") throw new Error("Wrong task for rsa-decrypt hint");
    return hint;
  }})),
  "ecdsa-sign": ([0, 1, 2] as const).map(level => ({id: `ecdsa-sign/${level+1}`, text: (ctx: HintContext) => {
    const hint = advancedHints(ctx, level);
    if (!hint || ctx.task.kind !== "ecdsa-sign") throw new Error("Wrong task for ecdsa-sign hint");
    return hint;
  }})),
  "anamorphic-rejection": ([0, 1, 2] as const).map(level => ({id: `anamorphic-rejection/${level+1}`, text: (ctx: HintContext) => {
    const hint = advancedHints(ctx, level);
    if (!hint || ctx.task.kind !== "anamorphic-rejection") throw new Error("Wrong task for anamorphic-rejection hint");
    return hint;
  }})),
  "stark-trace": ([0, 1, 2] as const).map(level => ({id: `stark-trace/${level+1}`, text: (ctx: HintContext) => {
    const hint = advancedHints(ctx, level);
    if (!hint || ctx.task.kind !== "stark-trace") throw new Error("Wrong task for stark-trace hint");
    return hint;
  }})),
  "io-equivalence": ([0, 1, 2] as const).map(level => ({id: `io-equivalence/${level+1}`, text: (ctx: HintContext) => {
    const hint = advancedHints(ctx, level);
    if (!hint || ctx.task.kind !== "io-equivalence") throw new Error("Wrong task for io-equivalence hint");
    return hint;
  }})),
  "snark-constraints": ([0, 1, 2] as const).map(level => ({id: `snark-constraints/${level+1}`, text: (ctx: HintContext) => {
    const hint = advancedHints(ctx, level);
    if (!hint || ctx.task.kind !== "snark-constraints") throw new Error("Wrong task for snark-constraints hint");
    return hint;
  }})),
  "ec-add": ([0, 1, 2] as const).map(level => ({id: `ec-add/${level+1}`, text: (ctx: HintContext) => {
    const hint = advancedHints(ctx, level);
    if (!hint || ctx.task.kind !== "ec-add") throw new Error("Wrong task for ec-add hint");
    return hint;
  }})),

  /**
   * The share Order is the one place where the hint is about the GAME rather
   * than the arithmetic: LEAK is one click while PROVE uses the four-cell sudoku scaffold, and the whole difficulty
   * is knowing what each one costs you later.
   *
   * [Issue #702] Level 1 used to open with the decision -- "hand it over or
   * answer without doing so" -- which is the second question, not the first. A
   * live player read all three levels (-14) and came back with 「Share って
   * そもそもなに？」 and 「このヒントが全く解ける状態じゃない」. A hint that
   * assumes the noun is not a hint for the person who bought it. Level 1 now
   * names the thing and names the move; the card carries the same definition
   * for free (`shareWhat` in FastMovePanel.tsx), so a player who never buys a
   * hint is not the one left out.
   */
  "rps-duel": [
    { id: "rps-duel/1", text: () => ({
      ja: "相手とじゃんけんをします。先に手を言うと相手に勝つ手を選ばれるので、手に『隠す数』を混ぜた数字だけを先に出します。この数字をコミットメントと呼びます。自分の数字を出したら、相手を待たずに手と隠す数を審判へ非公開で渡せます。審判は数字が一致するか確かめ、両方の開封がそろってから同時に公開します。隠す数は毎回くじで選び直します。",
      en: "Play rock-paper-scissors. Announcing your hand first would let your opponent counter it. First send a number combining your hand with a hiding number: a commitment. After sealing your number, give the judge your hand and hiding number privately without waiting for the opponent. The judge checks them, holds each opening privately, and publishes both together. Draw a fresh hiding number every round.",
    }) },
    { id: "rps-duel/2", text: () => ({
      ja: "手の番号 m はグー 1・チョキ 2・パー 3。隠す数 r は 0〜10 のくじから毎回選びます。封じる数字 c は『4 を m 回掛けた数 × 9 を r 回掛けた数』を 23 で割った余り。4^m × 9^r mod 23 と書き、0 回掛ける場合は 1 とします。例：m=1、r=1 なら 4×9=36、36−23=13。まず 13 だけ送り、あとで (1,1) を渡します。この小さな数では別の開け方も探せるため、審判が両開封を同時公開して後出しを防ぎます。commit-reveal は『先に封じて後で開く』手順で、それだけでゼロ知識証明になるわけではありません。",
      en: "m is rock 1, scissors 2, paper 3. Draw r uniformly from 0–10. Multiply m factors of 4 and r factors of 9, then multiply those results and keep the remainder after division by 23: c = 4^m × 9^r mod 23. A zeroth power is 1. For m=1, r=1: 4×9=36; 36−23=13. Send 13, then open with (1,1). Tiny numbers permit alternative openings, so the judge publishes both together to prevent adapting after seeing the other hand. Commit-reveal is not itself a zero-knowledge proof.",
    }) },
    { id: "rps-duel/3", text: () => ({
      ja: `「手の番号」と「隠す数」を選び、紙に控えます。表から 4^m と 9^r をそれぞれ 23 で割った余りを読み、掛けて 23 で割った余りを「封じる数字」に入れます。審判はあなたの選択をまだ知らないため、見本 m=2・r=2 で行を追います。\n${handWorkSteps(2, 2).join('\n').replaceAll('mod 23', '23 で割った余り')}\n自分の値で計算して「数字を封じる」。相手を待たず、控えた手と隠す数を入れて「手を審判へ渡す」。待ち表示なら相手の操作待ちです。`,
      en: `Choose and write down your hand and hiding number. Read the remainders of 4^m and 9^r after division by 23 from the table, multiply, and enter the remainder after division by 23 in Sealed number. The judge does not know your choice yet, so this is a sample m=2, r=2:\n${handWorkSteps(2, 2).join('\n')}\nCalculate with your choice and press Seal the number. Without waiting for the opponent, use your notes and press Give my opening to the judge. A waiting message means the opponent must act.`,
    }) },
  ],
  "reveal-share": [
    {
      id: "reveal-share/1",
      // [Issue #740] A disclosure Order accepts LEAK alone. Its rungs must not
      // sell a PROVE route the button row does not offer: the last paragraph of
      // rung 1 and the whole of rung 3 branch on what the Order accepts.
      text: (ctx) => ({
        ja: `かけら (share) は、シェアとも呼ぶ、秘密を分けて持つ「番号と数」の組です。自分の保管庫に${ctx.shareCount}個あります。\n同じ世代（同じ秘密から作った一組）の異なる番号が ${ctx.threshold} 個あれば秘密を戻せます。${ctx.threshold-1}個以下では、全 ${ctx.prime} 通りの秘密が候補に残ります。\nLEAKは指定されたシェアを公開して答える操作です。${ctx.allowedMethods.includes("prove")?"この保存試合のPROVEは、別の秘密である数独の解を使い、シェアを公開せずに答える方法です。":"このお題は公開が条件なので、答え方はLEAKだけです。計算や数値入力はありません。"}`,
        en: `A share is an index/value pair used to split a secret. Your vault holds ${ctx.shareCount} shares.\nCollect ${ctx.threshold} different indices from one generation (one set made from the same secret) to recover it. ${ctx.threshold-1} or fewer do not narrow the secret.\nLEAK publishes the requested shares to answer. ${ctx.allowedMethods.includes("prove")?"PROVE in this saved match uses a separate sudoku solution without publishing the share.":"This Order requires publication, so LEAK is the only method. No calculation or numeric input is needed."}`,
      }),
    },
    {
      id: "reveal-share/2",
      text: (ctx) => {
        if (!ctx.allowedMethods.includes("prove")) return {
          ja: `例：同じ世代の #1 と #2 が公開済みなら 2 個です。#3 を LEAK すると 2 + 1 = 3 個。同じ #2 をもう一度出すなら 2 + 0 = 2 個です。数えるのは異なる番号です。この試合では ${ctx.threshold} 個で秘密を戻せます。未回答で期限切れにすると公開数は増えず、失効の減点を受けます。公開済みの情報は相手が読み続けられるため、公開する前に増える番号を確認します。`,
          en: `Example: public #1 and #2 from one generation count as 2 shares. LEAK #3: 2 + 1 = 3. Publish #2 again: 2 + 0 = 2. Count distinct indices. This match needs ${ctx.threshold} shares to recover the secret. Leaving the Order unanswered adds no exposure but incurs its expiry penalty. Published information remains readable by opponents, so check which new index will be exposed before publishing.`,
        };

        const termsJa = Array.from({ length: ctx.threshold - 1 }, (_, i) => `係数${i + 1} × ${Array(i + 1).fill("番号").join(" × ")}`);
        const termsEn = Array.from({ length: ctx.threshold - 1 }, (_, i) => `coefficient${i + 1} × ${Array(i + 1).fill("index").join(" × ")}`);
        return {
          ja: `この試合の式は「かけら = 秘密${termsJa.length ? " + " + termsJa.join(" + ") : ""}」を ${ctx.prime} で割った余りです。係数は内緒で選ぶ『掛ける数』で、${ctx.threshold - 1} 個使います。番号 0 を入れると、秘密以外の項は全部 0 になります。
ここからは『3 個で戻る・割る数 7』の小さい例です。本番の設定 (${ctx.threshold} 個・割る数 ${ctx.prime}) とは区別してください。秘密 1、係数 0 と 1 なら、式は 1 + 0 × 番号 + 1 × 番号 × 番号。#1: 1 + 1 = 2、#2: 1 + 4 = 5、#3: 1 + 9 = 10、7 を引いて 3。これを 10 mod 7 = 3 と書き、mod は『割った余り』の意味です。
例の秘密を戻すと、3 × 2 − 3 × 5 + 3 = −6、7 を足して 1。これは『番号 1・2・3』専用の戻し方です。係数に掛かる数が 3 × 1 − 3 × 2 + 3 = 0 と、3 × 1 − 3 × 4 + 9 = 0 になり、秘密だけ残ります。
2 個だけではなぜ足りないか。秘密 2、係数 2 と 5 でも、#1 は 2 + 2 + 5 = 9 → 2、#2 は 2 + 4 + 20 = 26 → 5 と同じです。無料の『秘密のかけら』解説には、0〜6 の全候補に対応する係数の表があります。`,
          en: `This match uses share = secret${termsEn.length ? " + " + termsEn.join(" + ") : ""}, taking the remainder after dividing by ${ctx.prime}. A coefficient is a privately chosen multiplier; this setting uses ${ctx.threshold - 1} of them. At index 0 every term except the secret disappears.
The following small example uses a THREE-share setting and divisor 7, separate from this match's ${ctx.threshold}-share setting and divisor ${ctx.prime}. Secret 1, coefficients 0 and 1: 1 + 0 × index + 1 × index × index. #1: 1 + 1 = 2; #2: 1 + 4 = 5; #3: 1 + 9 = 10 → 10 − 7 = 3. Write this as 10 mod 7 = 3; mod means remainder.
Recover the example secret: 3 × 2 − 3 × 5 + 3 = −6 → −6 + 7 = 1. This shortcut is ONLY for indices 1, 2, 3. The coefficient multipliers cancel: 3 × 1 − 3 × 2 + 3 = 0 and 3 × 1 − 3 × 4 + 9 = 0, leaving only the secret.
Why not two shares? Secret 2 with coefficients 2 and 5 gives #1: 2 + 2 + 5 = 9 → 2 and #2: 2 + 4 + 20 = 26 → 5: the same two shares. The free Secret shares explanation lists the coefficients for every possible secret 0–6.`,
        };
      },
    },
    {
      id: "reveal-share/3",
      text: (ctx) => {
        if (ctx.task.kind !== "reveal-share") throw new Error("reveal-share/3 needs a share Order");
        const indices = [...new Set(ctx.task.shareIndices)];
        const cards = indices.map((index) => {
          const share = ctx.vault.shares.find((piece) => piece.index === index);
          if (!share) throw new Error(`missing own share #${index}`);
          return `#${index} = ${share.value}`;
        }).join(", ");
        const exposed = new Set(ctx.exposedShareIndices);
        const added = indices.filter((index) => !exposed.has(index)).length;
        const after = exposed.size + added;
        const canLeak = ctx.allowedMethods.includes("leak");
        const canProve = ctx.allowedMethods.includes("prove");
        // [Issue #740] The disclosure Order: LEAK alone, so rung 3 walks that
        // one action and the choice around it (ROTATE first, or not), instead
        // of a PROVE procedure the button row does not offer.
        if (canLeak && !canProve) {
          const reaches = after >= ctx.threshold;
          return {
            ja: `この Order は公開が条件です。求められているシェアは ${cards}（世代 ${ctx.vault.generation}）。
① まだ押さず、公開する値と次の公開数を確認します。
② 公開数を数える：${exposed.size} + ${added} = ${after} 個（公開済み + 新しい番号。同じ番号は重ねて数えない）。${reaches ? `必要な ${ctx.threshold} 個に達し、相手はあなたの秘密を戻せるようになります。` : `秘密を戻す ${ctx.threshold} 個にはまだ届きません。`}
③ 公開してよければ「公開して答える (LEAK)」を押します。完了・得点・公開記録への追加を確認します。公開しない場合は、このお題が期限切れになったときの減点を確認します。`,
            en: `This Order requires publication. Requested shares: ${cards} (generation ${ctx.vault.generation}).
(1) Before pressing, check the values and the resulting exposure below.
(2) Count your public shares: ${exposed.size} + ${added} = ${after} distinct indices (already public + new; duplicates count once). ${reaches ? `That reaches the ${ctx.threshold} an opponent needs to recover your secret.` : `Still below the ${ctx.threshold} needed for recovery.`}
(3) To publish, press "Publish to answer (LEAK)". Check completion, points and the public record. If you choose not to publish, check the penalty for letting this Order expire.`,
          };
        }
        return {
          ja: `選んだこの1題を終えてから、次のお題のヒントへ進みます。
求められているかけらは ${cards}（世代 ${ctx.vault.generation}）。
${canLeak ? `LEAK：この値を公開して完了。公開数は ${exposed.size} + ${added} = ${after} 個（公開済み + 新しい番号）。同じ番号は重ねて数えません。${after >= ctx.threshold ? `必要な ${ctx.threshold} 個に達し、相手が秘密を戻せます。` : `秘密を戻す ${ctx.threshold} 個には未到達です。`}` : "この Order は LEAK を受け付けません。"}
${canProve ? `PROVE：かけらの代わりに、自分の数独の解を使います。① 自動で用意された「今回の置き換え」を見る。矢印は元の数字→替える数字です。② 右の空欄と同じ位置を左の解で探し、表の矢印をたどる。例：元が2で表が2→1なら1を入れる。③ 同じ表で4 マスを埋め、SUBMIT。得点と公開された1組が出れば完了です。表の再使用は解を戻される手がかりになります。` : "この Order には PROVE はありません。"}`,
          en: `Finish this selected Order before opening hints for the next one.
Requested shares: ${cards} (generation ${ctx.vault.generation}).
${canLeak ? `LEAK: publish these values to complete it. ${exposed.size} already public + ${added} new = ${after} distinct indices. Duplicates count once. ${after >= ctx.threshold ? `This reaches the ${ctx.threshold} needed to recover your secret.` : `Still below the ${ctx.threshold} needed for recovery.`}` : "This Order does not accept LEAK."}
${canProve ? `PROVE: use your sudoku solution instead of these shares. (1) Check the automatically assigned unused relabelling table. An arrow means original digit → replacement. (2) Find each right-hand hole's position in your solution on the left; follow the table's arrow. Example: original 2 with 2→1 means enter 1. (3) Fill four holes using the same table and press SUBMIT. A score and one opened group confirm completion. Reusing a table can help others recover your solution.` : "This Order does not accept PROVE."}`,
        };
      },
    },
  ],
  "homomorphic-sum": [
    {
      id: "homomorphic-sum/1",
      text: () => ({
        ja: "暗号文は、中身を隠した「左・右」の数の組です。右には、中身と隠す数が足されています。\n右どうしを足すと「中身の合計＋隠す数の合計」になります。判定側は各入力の鍵を持つので、隠す数の合計を引いて答え合わせできます。あなたは鍵を使わず、暗号文のまま足します。\nこれが準同型暗号の足し算の考え方です。FHE（完全準同型暗号）は掛け算も扱いますが、このお題は足し算の模型です。",
        en: "A ciphertext is a pair, left and right, hiding an original number. The right combines the content and a hiding number.\nAdding the rights combines both the contents and the hiding numbers. The judge holds each input’s key and subtracts the hiding total to check the content total. You add without using a key or opening the ciphertexts.\nThis models additive homomorphic encryption. FHE (fully homomorphic encryption) also handles multiplication; this task models addition only.",
      }),
    },
    {
      id: "homomorphic-sum/2",
      text: () => ({
        ja: "式：左の答え = 左の値の合計をpで割った余り。右の答え = 右の値の合計をpで割った余り。2組なら (r1+r2 mod p, y1+y2 mod p)。rは左、yは右、modは割った余りです。\n例：割る数p=7、暗号文は(2,5)と(3,6)。\n① 左どうし：2 + 3 = 5 → 7未満なので5。\n② 右どうし：5 + 6 = 11 → 11 − 7 = 4。\n③ 答えの暗号文は(5,4)。左の欄に5、右の欄に4を入れます。\n「7で割った余り」をmod 7と書きます。中身を復号する計算は不要です。",
        en: "Rule: sum all left values and take the remainder by p; do the same for the right values. For two pairs: (r1+r2 mod p, y1+y2 mod p). r is left, y is right; mod means remainder.\nExample: divisor p=7, ciphertexts (2,5) and (3,6).\n① Lefts: 2 + 3 = 5 → below 7, keep 5.\n② Rights: 5 + 6 = 11 → 11 − 7 = 4.\n③ Result (5,4): put 5 in the left field and 4 in the right field.\nThe remainder after division by 7 is written mod 7. No decryption is required.",
      }),
    },
    {
      id: "homomorphic-sum/3",
      text: (ctx) => {
        if (ctx.task.kind !== "homomorphic-sum") {
          throw new Error(`homomorphic-sum/3 rendered against a ${ctx.task.kind} Order`);
        }
        const p = ctx.prime;
        const inputs = ctx.task.inputs;
        const listJa = inputs.map((c, i) => `暗号文 ${i + 1} = (${c.r}, ${c.y})`).join("、");
        const listEn = inputs.map((c, i) => `ciphertext ${i + 1} = (${c.r}, ${c.y})`).join(", ");
        const rs = inputs.map((c) => c.r).join(" + ");
        const ys = inputs.map((c) => c.y).join(" + ");
        return {
          ja: `この Order の数で。${listJa}。p (割る数) = ${p}。\n① 左の値: ${rs} = ？ 結果が ${p} 以上なら ${p} を繰り返し引く。その数を「答え: 左の値」の箱に入れる。\n② 右の値: ${ys} = ？ 結果が ${p} 以上なら ${p} を繰り返し引く。その数を「答え: 右の値」の箱に入れる。\n③ どちらの箱も ${p} より小さい数になっていることを確かめて、「暗号文を提出」を押す。暗号文を開ける必要はなく、鍵も使いません。足して余りをとるだけで、判定側が中身の合計を確かめます。`,
          en: `With this Order's numbers. ${listEn}. p (the divisor) = ${p}.\n(1) Left value: ${rs} = ? If the result is ${p} or more, subtract ${p} repeatedly. Type that number into the "your answer: left part" box.\n(2) Right value: ${ys} = ? If the result is ${p} or more, subtract ${p} repeatedly. Type that number into the "your answer: right part" box.\n(3) Check that both boxes hold a number smaller than ${p}, then press SUBMIT CIPHERTEXT. You never open a ciphertext and never use a key. You only add and take the remainder; the judge checks the content total.`,
        };
      },
    },
  ],
  "masked-total": [
    {
      id: "masked-total/1",
      text: (ctx) => {
        if (ctx.task.kind !== "masked-total") throw new Error("masked-total/1 rendered against a " + ctx.task.kind + " Order");
        const n = ctx.task.partyCount;
        return {
          ja: `${n}社の拠点が、自分の数を隠したまま合計を出します。「覆面」は2社だけで共有する隠す数です。
一方が足し、もう一方が同じ数を引くため、全社の小計を足すと覆面だけが消えます。
あなたが提出するのは、自分の数を覆面で隠した小計です。`,
          en: `${n} offices total their numbers without publishing each input. A mask is a hiding number shared privately by two offices.
One adds it and the other subtracts it, so masks cancel when all subtotals are added.
Submit a subtotal that masks your own input.`,
        };
      },
    },
    {
      id: "masked-total/2",
      text: () => ({
        ja: "式：小計 = 自分の数 + 受け取った覆面の合計 − 送った覆面の合計。この結果をpで割った余りにします。\n例：自分の数3、受け取った覆面1と2、送った覆面6と5。割る数p=7。\n① 足す数：1 + 2 = 3。\n② 引く数：6 + 5 = 11。\n③ 小計：3 + 3 − 11 = −5。\n④ 負なら7を足す：−5 + 7 = 2。答えは2。\n0〜6に入るまで、負なら7を足し、7以上なら7を引きます。この「割った余り」をmodと書きます。",
        en: "Formula: subtotal = input + received mask total − sent mask total. Take the remainder after division by p.\nExample: input 3, received masks 1 and 2, sent masks 6 and 5; divisor p=7.\n① Received total: 1 + 2 = 3.\n② Sent total: 6 + 5 = 11.\n③ Subtotal: 3 + 3 − 11 = −5.\n④ Negative: add 7. −5 + 7 = 2. Answer: 2.\nAdd 7 if negative, subtract 7 if at least 7, until within 0–6. This remainder operation is written mod.",
      }),
    },
    {
      id: "masked-total/3",
      text: (ctx) => {
        if (ctx.task.kind !== "masked-total") throw new Error("masked-total/3 rendered against a " + ctx.task.kind + " Order");
        const p = BigInt(ctx.prime);
        const received = ctx.task.incomingMasks.map(BigInt);
        const sent = ctx.task.outgoingMasks.map(BigInt);
        const sum = (xs: readonly bigint[]) => xs.reduce((acc, x) => acc + x, 0n);
        const R = sum(received);
        const S = sum(sent);
        const my = ctx.task.myInput;
        return {
          ja: `この Order の数で計算します。割る数 p = ${p}。\n① 受け取った覆面を全部足します: ${received.join(" + ") || "0"} = ${R}。\n② 送った覆面を全部足します: ${sent.join(" + ") || "0"} = ${S}。\n③ 自分の数 ${my} に ① を足して ② を引きます: ${my} + ${R} − ${S} = ？\n④ 出た数が 0 未満なら ${p} を足します (まだ 0 未満ならもう一度足す)。${p} 以上なら ${p} を引きます (まだ ${p} 以上ならもう一度引く)。0 以上 ${p - 1n} 以下に入った数が答えです。\n⑤ その数を「公開する小計」の欄に入力して「小計を提出」を押します。自分の数をそのまま写すのでなく、計算した小計を提出します。覆面が打ち消し合えば、結果が自分の数と同じになる場合もあります。`,
          en: `Now with this Order's numbers. Divisor p = ${p}.\n(1) Add up every mask you received: ${received.join(" + ") || "0"} = ${R}.\n(2) Add up every mask you sent: ${sent.join(" + ") || "0"} = ${S}.\n(3) Take your own number ${my}, add (1) and subtract (2): ${my} + ${R} − ${S} = ?\n(4) If the result is below 0, add ${p} (if it is still below 0, add ${p} again). If it is ${p} or more, subtract ${p} (if it is still ${p} or more, subtract ${p} again). The number that lands between 0 and ${p - 1n} (both included) is your answer.\n(5) Type it into the "your masked subtotal" field and press SUBMIT SUBTOTAL. Submit the calculated subtotal, not an unworked copy of your input; cancelling masks can legitimately make those two numbers equal.`,
        };
      },
    },
  ],
  /**
   * [Issue #709] The ZK sudoku Order. Same three steps as the others -- what
   * the pieces are, the rule, the first move -- and it stops short of doing
   * the relabelling, which is the team's own work.
   */
  "zk-sudoku": [
    {
      id: "zk-sudoku/1",
      text: () => ({
        ja: "ZK（ゼロ知識証明）は、答えそのものを相手に教えず、答えを持っていると示す考え方です。ここでは 4×4 の数独を使います。どの行・列・太枠の 2×2 の箱にも 1〜4 が 1 回ずつ入るのがルールです。\n自分の完成した解を数字の読み替え表で隠し、相手には読み替え後の 1 組だけを見せます。数字の名前を一対一に替えても、同じ数字が重ならない性質は残るからです。ゲームの審判は元の解を持って全体を検査します。本来の ZK は審判にも解を渡しませんが、ここはその考え方を体験する仕組みです。",
        en: "ZK (zero-knowledge proof) means showing you hold an answer without teaching another person the answer itself. Here a 4×4 sudoku has 1–4 once each in every row, column and outlined 2×2 box.\nHide your completed solution with a digit-renaming table and show others one renamed group. A one-to-one renaming preserves the once-each rule. The trusted game judge knows your original solution and checks the whole grid; a full ZK protocol also hides the solution from its verifier. This is a teaching model of that idea.",
      }),
    },
    {
      id: "zk-sudoku/2",
      text: () => ({
        ja: "一桁の例で見ます。表を 1→3、2→1、3→4、4→2 と選びます。矢印は左の数字を右の数字に読み替える意味です。\n元の行が 2・1・3・4 なら、2→1、1→3、3→4、4→2 と替えて 1・3・4・2 になります。1〜4 を一度ずつ使う性質は同じです。\n表の右側で同じ数字を 2 回使うと、一つの行にも同じ数字が 2 回出てしまいます。だから 1〜4 を右側にちょうど 1 回ずつ使い、全マスに同じ表を使います。",
        en: "One-digit example: choose 1→3, 2→1, 3→4, 4→2. An arrow means rename its left digit to its right digit.\nOriginal row 2,1,3,4 becomes 1,3,4,2: apply 2→1, 1→3, 3→4, 4→2 in order. It still contains 1–4 once each.\nIf two original digits share a replacement, a row repeats that replacement. That is why the table must use each of 1–4 exactly once on the right and be applied identically to every cell.",
      }),
    },
    {
      id: "zk-sudoku/3",
      text: (ctx) => {
        const rows = Array.from({ length: 4 }, (_, i) => ctx.vault.sudokuSolution.slice(i * 4, i * 4 + 4).join(" "));
        const used = ctx.vault.usedPermutations.map((table) => table.map((digit, i) => `${i + 1}→${digit}`).join(" ")).join(" / ");
        return {
          ja: `① 証明の入力欄を開き（すでに開いていればそのまま）、自動で用意された「今回の置き換え」を確認します。世代は同じ秘密や解を使う一組のことです。この世代で使った表は ${used || "まだありません"}。使用済みの表は避けます。\n② 左の自分の解は、上から ${rows.join(" / ")} です。右は 12 マスが見本、4 マスが空欄です。\n③ 空欄と同じ位置を左で探します。その数字から、今回の表の矢印の先へ読み替えて右に入力します。例の 2→1 なら、元が 2 の空欄に 1 を入れるということです。残りも同じ表で埋めます。\n④ 4 マスを入れたら「答えを送る」を押します。審判は完成した 16 マスを検査し、通れば得点と、公開された 1 行・1 列・1 箱のどれか 1 組が表示されます。\n同じ表を再使用すると公開された組をつなげられます。HUNT は相手が秘密の答えを当てて得点する攻撃です。解が一つに絞られると HUNT されるので、次も新しい表が自動で用意されます。`,
          en: `(1) Open the proof input area if it is not already open, and check the automatically prepared relabelling table. A generation is one set using the same secret and solution. Tables already used this generation: ${used || "none"}. Avoid a used table.\n(2) Your solution's rows, top to bottom: ${rows.join(" / ")}. The right grid has twelve worked cells and four holes.\n(3) Find each hole's position on the left. Take that original digit through your chosen table's arrow, then enter its replacement on the right. For example, 2→1 means enter 1 in a hole whose original digit was 2. Use the same table for the remaining holes.\n(4) Fill four holes and press SUBMIT. The judge checks all sixteen cells; success shows the score and one opened row, column or box.\nReusing a table lets others connect opened groups. HUNT is an attack that scores by recovering another team’s secret answer. A uniquely determined solution can be HUNTed. A fresh table is prepared next time too.`,
        };
      },
    },
  ],
  "rotor-encrypt": ([0, 1, 2] as const).map(rung => ({ id: `rotor-encrypt/${rung + 1}`, text: (ctx: HintContext) => {
    if (ctx.task.kind !== "rotor-encrypt") throw new Error("Rotor hint on another task");
    return rotorGuide(ctx.task, rung);
  } })),
  "rsa-encrypt": ([0, 1, 2] as const).map(rung => ({ id: `rsa-encrypt/${rung + 1}`, text: (ctx: HintContext) => {
    if (ctx.task.kind !== "rsa-encrypt") throw new Error("RSA hint on another task");
    return rsaGuide(ctx.task, rung);
  } })),
  "caesar-shift": [
    {
      id: "caesar-shift/1",
      text: (ctx) => ctx.task.kind === "caesar-shift" && ctx.task.rung === "vigenere" ? vigenereGuide(ctx.task, 0) : ({
        ja: "目的：元の記号の列（平文）を、別の列（暗号文）へ変えます。記号を輪に並べ、全部を同じ数だけ先へずらすシーザー暗号です。ずらす数が秘密の『鍵』。最後の次は先頭に戻ります。\n同じ数だけ逆へ戻せば平文に戻ります。方式は公開され、秘密は鍵だけです。元と後の記号を1組知られると、その間を何個進むか数えて鍵を求められます。\nまずこの1題の3段だけ読み、計算して提出します。",
        en: "Goal: change the original row (plaintext) into an encrypted row (ciphertext). Caesar encryption arranges symbols in a circle and shifts every symbol forward by the same number: the secret key. After the last symbol, wrap to the first.\nShifting back by that key recovers the plaintext. The method is public; only the key is secret. One known original/encrypted pair reveals the shift by counting steps.\nRead this Order's three rungs, calculate and submit before moving to another Order.",
      }),
    },
    {
      id: "caesar-shift/2",
      text: (ctx) => ctx.task.kind === "caesar-shift" && ctx.task.rung === "vigenere" ? vigenereGuide(ctx.task, 1) : ({
        ja: "式：記号の並び順に0から番号をつけます。サイコロの面1〜6なら、計算用の番号は0〜5です。\n暗号の番号 = (元の番号 + 鍵) を記号の種類数で割った余り。この『割った余り』を mod と書きます。鍵も0〜種類数−1なので、足した数が種類数以上なら種類数を1回引けば足ります。\n一桁の例：5種類・鍵3・元の番号4,1なら、4+3=7→7−5=2、1+3=4。答えの番号は2,4です。本番は次の段の種類数と鍵を使います。",
        en: "Formula: number symbols from 0 in their displayed order. Die faces 1–6 have calculation values 0–5.\nEncrypted value = (original value + key), taking the remainder after dividing by the number of symbols. We write remainder as mod. The key is also between 0 and symbol-count−1, so subtracting the count once suffices whenever the sum reaches it.\nOne-digit example: 5 symbols, key 3, originals 4,1. 4+3=7→7−5=2; 1+3=4. The answer is 2,4. For your Order use the count and key in the next rung.",
      }),
    },
    {
      id: "caesar-shift/3",
      text: (ctx) => {
        if (ctx.task.kind !== "caesar-shift") throw new Error("caesar-shift/3 rendered against a non-caesar Order");
        if (ctx.task.rung === "vigenere") return vigenereGuide(ctx.task, 2);
        const n = ctx.task.symbols.length;
        const key = ctx.task.myKey;
        const values = ctx.task.plaintext;
        const jaLines = values.map((v, i) => `${i + 1} 番目: ${v} + ${key} = ？`).join("\n");
        const enLines = values.map((v, i) => `Position ${i + 1}: ${v} + ${key} = ?`).join("\n");
        const jaZero = key === 0 ? "\n鍵が 0 なので、足しても番号は変わりません。それでも正しい答えです。" : "";
        const enZero = key === 0 ? "\nYour key is 0, so adding it changes nothing. That is still the correct answer." : "";
        return {
          ja: `選んだこの1題を提出してから、次のお題のヒントへ進みます。\n自分の値：${n} 種類（番号0〜${n - 1}）・鍵 ${key}・平文の番号 ${values.join(", ")}。画面の「記号の並び順」の下の数と対応します。\n① 左から鍵を足す：\n${jaLines}\n② ${n} 以上の結果から ${n} を引く。${jaZero}\n③ できた ${values.length} 個の番号を空白区切りで「暗号にした列」へ入力し、CIPHER。受理されて得点が増えれば完了です。`,
          en: `Submit this selected Order before opening hints for the next one.\nYour values: ${n} symbols (0–${n - 1}), key ${key}, plaintext ${values.join(", ")}, matching the numbers under "the symbols, in order".\n(1) Add the key, left to right:\n${enLines}\n(2) Subtract ${n} from results of ${n} or more.${enZero}\n(3) Enter the ${values.length} numbers separated by spaces in "your encrypted row" and press CIPHER. Acceptance and a score increase confirm completion.`,
        };
      },
    },
  ],
};

/** The ladder for a task kind, including saved-match exercise variants. */
export function hintsFor(kind: OrderTaskKind): readonly HintSpec[] {
  return HINT_LADDER[kind];
}

/**
 * What the `level`-th hint costs, given the match's configured prices.
 *
 * Returns `undefined` for a level the price list does not cover, rather than
 * `NaN`-ing a team's score the way an out-of-range index would: a config that
 * has fewer prices than a ladder has levels is a misconfiguration, and the
 * reducer refuses the op instead of charging an unknown amount. `hints.test.ts`
 * pins `DEFAULT_CONFIG` against that ever being the shipped case.
 */
export function hintCostAt(costs: readonly number[], level: number): number | undefined {
  if (!Number.isInteger(level) || level < 0) return undefined;
  return costs[level];
}
