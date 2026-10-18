import type { RotorTaskProjection } from "./rotor.ts";

/** Paid rungs only. The free surface separately states every needed formula. */
export function rotorGuide(
  task: RotorTaskProjection,
  rung: 0 | 1 | 2,
): { readonly ja: string; readonly en: string } {
  if (rung === 0)
    return {
      ja: "目的：元の数字の列（平文）を、車輪の対応表で別の列（暗号文）へ変えます。車輪は数字を一対一に読み替える表です。2つの表P・Qを通し、1文字出すたびに位置を進めます。同じ数字でも位置が違うと別の数字になります。\n初期位置は自分と審判だけが知ります。同じ世代のお題は毎回同じ初期位置から始まります。CIPHERは答えを審判だけへ送り、LEAKは元の列と答えを公開します。公開1組だけで初期位置が分かる場合もあります。",
      en: "Goal: transform an original row (plaintext) into another row (ciphertext) using wheels. Each wheel assigns one output to each input, with no two inputs sharing an output. Pass through public tables P and Q, then advance their positions after each output. A digit can change differently at different positions.\nOnly your team and the judge know the initial positions. Each Order in the same generation starts from those same positions. CIPHER sends the answer only to the judge; LEAK publishes the original and encrypted rows. One public pair can sometimes reveal the initial positions.",
    };
  if (rung === 1)
    return {
      ja: "式：4で割った余りを mod 4 と書き、負なら4を足して0〜3へ戻します。表の左から0番、1番、2番、3番です。P=[1,3,0,2]、Q=[3,0,2,1]。\nu=(P[(m+a) mod 4]−a) mod 4、c=(Q[(u+b) mod 4]−b) mod 4。mは元の数字、aは速い車輪、bは遅い車輪の今の位置、uは途中の数字、cは出力です。\n別の一桁例：m=3,a=0,b=1ならP[3]=2なのでu=2。Q[3]=1から1を引いてc=0。出力してからaを1へ進め、bは1のまま。aが3→0に戻るときだけbも1進め、bも3の次は0です。",
      en: "Formula: write the remainder after division by 4 as mod 4; if negative, add 4 to return to 0–3. Table entries are numbered 0,1,2,3 from the left. P=[1,3,0,2], Q=[3,0,2,1].\nu=(P[(m+a) mod 4]−a) mod 4; c=(Q[(u+b) mod 4]−b) mod 4. m is the original digit; a and b are the current fast and slow positions; u is the intermediate digit; c is the output.\nSeparate one-digit example: m=3,a=0,b=1 gives P[3]=2, so u=2. Q[3]=1 minus 1 gives c=0. Output first, then advance a to 1; b stays 1. Only when a wraps 3→0 does b advance too, also wrapping 3→0.",
    };
  let {a,b}=task.myInitial;
  const jaRows:string[]=[], enRows:string[]=[];
  task.plaintext.forEach((m,i)=>{
    jaRows.push(`${i+1}文字目：m=${m}、a=${a}、b=${b}\n① ${m}+${a} の4で割った余り → 表Pの位置。\n② その位置のPの値 − ${a} → 4で割った余りをuとする。\n③ u+${b} の4で割った余り → 表Qの位置。\n④ その位置のQの値 − ${b} → 4で割った余りが、この文字の答え。`);
    enRows.push(`Character ${i+1}: m=${m}, a=${a}, b=${b}\n① Remainder of ${m}+${a} divided by 4 → position in P.\n② P at that position minus ${a} → remainder by 4 is u.\n③ Remainder of u+${b} divided by 4 → position in Q.\n④ Q at that position minus ${b} → remainder by 4 is this output.`);
    b=(b+(a===3?1:0))%4;a=(a+1)%4;
  });
  return {
    ja:`表は左から0・1・2・3番。負の数には4を足し、4以上なら4を引いて0〜3にします。\n${jaRows.join("\n\n")}\n最後：各文字の④の答えだけを順に${task.plaintext.length}個、半角スペースで区切り、暗号文の回答欄へ入力してCIPHERを押します。再挑戦も最初の位置から計算します。先に誤答していた場合は0点で完了します。`,
    en:`Table positions are 0,1,2,3 from the left. Add 4 if negative, subtract 4 if at least 4, until within 0–3.\n${enRows.join("\n\n")}\nFinally enter only the ${task.plaintext.length} outputs from step ④, in order, separated by spaces, in the ciphertext answer field and press CIPHER. Retries start from the initial positions. Completion after an earlier wrong answer earns 0 points.`,
  };
}
