import type { RsaTask } from "./rsa.ts";

/** Paid explanations are rendered by the judge, only after a rung is opened. */
export function rsaGuide(task: RsaTask, rung: 0 | 1 | 2): { readonly ja: string; readonly en: string } {
  const { n, e, plaintext: m } = task;
  if (rung === 0) return {
    ja: "目的：元の数（平文）を、別の数（暗号文）へ変えます。RSAは、誰でも知ってよい暗号化用の公開鍵と、元へ戻すための秘密鍵を分ける方式です。今回は公開鍵を使う側です。\n同じ数を繰り返し掛け、途中で割った余りを取ると、大きな数を抱えず計算できます。CIPHERは答えを審判だけへ送り、LEAKは審判が代わりに計算して元の数と答えを公開します。",
    en: "Goal: turn an original number (plaintext) into an encrypted number (ciphertext). RSA separates the public key, which anyone may use to encrypt, from a private key used to recover the original. This Order uses the public key.\nRepeated multiplication with remainders keeps intermediate numbers manageable. CIPHER sends your answer only to the judge. LEAK asks the judge to calculate and publish the original and encrypted numbers.",
  };
  if (rung === 1) return {
    ja: "式：暗号文 c = m^e を n で割った余り。mは元の数、nとeは公開鍵です。右上のeは、mをe個掛ける意味です。割った余りをmodとも書きます。\n2乗の余りr2、4乗の余りr4を作ります。e=3ならr2×m、e=5ならr4×m、e=7ならr4×r2×m。掛けるたびにnの余りを取ってかまいません。\n別の一桁例：3³を7で割るなら、3²=9→余り2、2×3=6→余り6。これは余りの練習例で、7がRSAの鍵という意味ではありません。",
    en: "Formula: c is the remainder of m^e divided by n. m is the original; n and e are the public key. The superscript e means multiplying e copies of m. Remainder is also written mod.\nCompute the square remainder r2 and fourth-power remainder r4. For e=3 use r2×m; e=5 uses r4×m; e=7 uses r4×r2×m. You may take the remainder after every multiplication.\nSeparate one-digit example: 3³ divided by 7. 3²=9 leaves 2; 2×3=6 leaves 6. This is a remainder example, not an RSA key with n=7.",
  };
  const jaEnd = e === 3 ? `r2×${m}` : e === 5 ? `r4×${m}` : `r4×r2の余りをtとし、t×${m}`;
  const enEnd = e === 3 ? `r2×${m}` : e === 5 ? `r4×${m}` : `r4×r2, save its remainder as t, then calculate t×${m}`;
  return {
    ja: `この1題を計算してから次のお題へ進みます。自分の値：m=${m}、n=${n}、e=${e}。\n① ${m}×${m}を計算し、${n}で割った余りを紙にr2と書く。${e === 3 ? "" : `\n② r2×r2を計算し、${n}で割った余りを紙にr4と書く。`}\n最後に${jaEnd}を計算し、${n}で割った余りを出します。\n提出：最後の余り1個だけを暗号文の回答欄へ入れ、CIPHERを押します。r2・r4は途中計算のメモで、入力欄ではありません。未入力・範囲外は誤答に数えません。正しく完了した表示を確認。先に誤答していた場合は0点で完了します。`,
    en: `Finish this one Order before moving on. Your values: m=${m}, n=${n}, e=${e}.\n(1) Calculate ${m}×${m}; write the remainder after division by ${n} on paper as r2.${e === 3 ? "" : `\n(2) Calculate r2×r2; write its remainder after division by ${n} on paper as r4.`}\nFinally calculate ${enEnd}, taking the remainder after each multiplication. Enter the final single remainder in CIPHER. Empty/out-of-range input does not count as a wrong answer. Check the completed verdict; after an earlier wrong answer, completion earns 0 points.`,
  };
}
