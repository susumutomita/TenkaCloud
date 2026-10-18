import { cipherKeyAt } from "./ladder.ts";
import type { OrderTaskProjection } from "./types.ts";

type Task = Extract<OrderTaskProjection, { kind: "caesar-shift" }>;
/** Purchased hints only; live instructions reach the browser through projectHints. */
export function vigenereGuide(task: Task | undefined, level: 0 | 1 | 2): { readonly ja: string; readonly en: string } {
  if (task !== undefined && task.rung !== "vigenere") throw new Error("vigenereGuide: wrong rung");
  if (level === 0) return {
    ja: "目的：元の記号（平文）を、鍵でずらした記号（暗号文）へ変えます。Vigenère（ヴィジュネル）暗号は、ずらす数を3個用意し、鍵1→鍵2→鍵3→鍵1…と順に繰り返します。この繰り返す長さを周期と呼び、ここでは3であることを公開しています。\nこのお題は長い列の1位置だけを切り出したものです。CIPHERは計算した答えを審判へ非公開で送り、LEAKは元と答えの組を公開します。同じ世代では同じ3個の鍵を使います。公開された位置の鍵は引き算で分かり、異なる3位置が揃うと全鍵を回収されます。\n長い列を1組公開して3位置すべてを含めれば、それだけで全鍵が分かります。鍵を繰り返すこの方式は現代の安全な暗号ではありません。",
    en: "Goal: turn an original symbol (plaintext) into a shifted symbol (ciphertext). Vigenère encryption uses three secret shifts: key 1 → key 2 → key 3 → key 1, repeating. This repeat length is the period; here the period 3 is public.\nThis Order is one position cut from a longer row. CIPHER sends your calculated answer privately to the judge. LEAK publishes the original and answer. The same generation reuses the same three keys. Subtraction reveals the key at a published position; all three distinct positions reveal the entire key.\nA single long pair covering all three positions would already reveal all the keys. This repeated-key method is not a modern secure cipher.",
  };
  if (level === 1) return {
    ja: "式：サイコロの面1〜6を、計算用に0〜5と番号づけます。元の番号を a、暗号の番号を b、使う鍵を k とすると、b = (a + k) を6で割った余り。この『割った余り』を mod と書きます。鍵も0〜5なので、和が6以上なら6を1回引きます。\n一般の列では鍵1・鍵2・鍵3を左から順に繰り返します。一桁例：鍵が1,2,3、平文が4,5,1,0なら、4+1=5、5+2=7→1、1+3=4、0+1=1。答えは5,1,4,1です。\n公開から戻す式は k = (b − a) を6で割った余り。例の鍵2は1−5=−4→6を足して2。鍵1の公開だけを何個集めても、鍵2・鍵3は決まりません。",
    en: "Formula: die faces 1–6 use calculation values 0–5. Let original value be a, encrypted value b, and the shift for that position k. b is (a + k), taking the remainder after dividing by 6, written mod. Both the original value and the key are 0–5, so subtract 6 once if their sum reaches 6.\nFor a general row, repeat keys 1, 2, 3 from left to right. One-digit example: keys 1,2,3 and originals 4,5,1,0 give 4+1=5; 5+2=7→1; 1+3=4; 0+1=1. Answer: 5,1,4,1.\nRecover a published position with k = (b − a), taking the remainder after dividing by 6. Example key 2: 1−5=−4; add 6 to get 2. Repeated records for key 1 alone cannot determine keys 2 and 3.",
  };
  if (!task) throw new Error("vigenereGuide: own values require an Order");
  const position = (task.keyPosition ?? 0) + 1;
  const key = cipherKeyAt(task.myKey, position - 1);
  return {
    ja: `自分の値：鍵の列 ${typeof task.myKey === "number" ? task.myKey : task.myKey.join(", ")}。今回使うのは鍵${position}、値は ${key}。元の番号は ${task.plaintext.join(", ")} です。\n① ${task.plaintext[0]} + ${key} = ？ を計算します。\n② 6以上なら6を1回引きます。\n③ できた番号1個を「暗号にした列」へ入力し、CIPHER。正解の表示で完了です。得点は提出ボタンの表示どおりで、以前に誤答したこのお題は0点です。LEAKを選ぶと今回の鍵${position}だけが公開から分かるようになります。次のお題では鍵の位置を読み直します。`,
    en: `Your values: key cycle ${typeof task.myKey === "number" ? task.myKey : task.myKey.join(", ")}. This Order uses key ${position}, value ${key}. Original value: ${task.plaintext.join(", ")}.\n(1) Calculate ${task.plaintext[0]} + ${key} = ?.\n(2) Subtract 6 once if the sum reaches 6.\n(3) Enter the one number in "your encrypted row" and press CIPHER. A correct verdict confirms completion. The button shows the reward; this Order pays 0 if you previously answered it incorrectly. Choosing LEAK makes this position's key ${position} recoverable from the record. Read the key position again on the next Order.`,
  };
}
