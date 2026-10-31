export const COPY = {
  ja: {
    title: "そのお願い、聞いていい？",
    instruction: "こすって、仮面をはがす。偽装を狙って、撃ち抜く。",
    format: "1プレー2分。偽装2つ。正解＋50／誤射−25。",
    safety: "架空のゲームです。実際の送信・ダウンロード・インストールは行いません。",
    games: "ゲーム一覧へ",
    sender: "青葉テック · 採用担当",
    message: "面接前に、この4つをお願いします。",
    reference: "自分で確かめた公式の約束",
    webOnly: "WEBだけ",
    destination: "提出先はここだけ",
    policyDomain: "aoba",
    peel: "はがす",
    peelHint: "↔ こする／タップでも可",
    aim: "狙う",
    fire: "撃ち抜く",
    finish: "調査完了",
    finishHint: "4つの中身を見たら、調査完了。",
    pause: "一時停止",
    resume: "続ける",
    hold: "安全に保留して終える",
    paused: "いったん、手を止めよう。",
    held: "安全に、保留。",
    heldNote: "今回は採点なし。依頼は実行していません。",
    deadline: "返答受付中",
    closing: "まもなく受付終了",
    deadlineEnd: "→ 受付終了",
    score: "得点",
    progress: "偽装",
    unit: "点",
    cleared: "偽装を、撃ち抜いた。",
    complete: "調査、終了。",
    timeout: "今回は、時間切れ。",
    retry: "もう一度、はがす",
    review: "どこが偽装だった？",
    safeNext:
      "不意の実行要求では実行せず、相手が指定した連絡先ではなく自分で調べた公式窓口で確認しましょう。外部サイトやアプリというだけで、常に悪性とは限りません。今回は公式の約束との食い違いが根拠です。",
    more: "安全な次の一手",
    share: "Xで結果を共有",
    shareComplete: "『そのお願い、聞いていい？』偽装{hits}/2、{score}/100点。 #TenkaCloud",
    shareHeld: "『そのお願い、聞いていい？』依頼を安全に保留しました（採点なし）。 #TenkaCloud",
    notices: {
      revealed: "中身が見えた。公式の約束と、見比べよう。",
      aim: "狙いを合わせた。下のボタンで撃つ。",
      hit: "偽装を撃ち抜いた！ ＋50",
      miss: "これは公式の約束と一致。誤射 −25",
    },
    covers: {
      calendar: "日程を選ぶ",
      application: "画面テスト",
      task: "課題を開く",
      upload: "成績を提出",
    },
    actions: { WEB: "ブラウザで開く", APP: "アプリを実行" },
    blocked: "偽装を遮断",
    matched: "公式と一致",
    explanations: {
      application: "『画面テスト』の中身はアプリの実行要求。公式の『WEBだけ』と矛盾します。",
      destination:
        "『成績を提出』の中身はaoba-skills.exampleへの送信。公式はaoba.exampleだけと明記しています。",
      normal:
        "ブラウザで開き、提出先もaoba.example。表示された約束との矛盾はありません。安全性全般の保証ではありません。",
    },
  },
  en: {
    title: "Should I do what they ask?",
    instruction: "Peel off the disguise. Aim at the deception. Fire.",
    format: "2 minutes. Two disguises. Correct +50 / wrong shot −25.",
    safety: "A fictional game. No real messages, downloads or installations.",
    games: "All games",
    sender: "Aoba Tech · Recruiting",
    message: "Please complete these four steps before an interview.",
    reference: "Official rules you checked independently",
    webOnly: "WEB only",
    destination: "Only this destination",
    policyDomain: "aoba",
    peel: "Peel",
    peelHint: "↔ Rub, or tap",
    aim: "Aim",
    fire: "Fire",
    finish: "Finish investigation",
    finishHint: "Reveal all four, then finish the investigation.",
    pause: "Pause",
    resume: "Continue",
    hold: "Put it on hold safely",
    paused: "Take a moment.",
    held: "Safely on hold.",
    heldNote: "Not graded this time. No request was executed.",
    deadline: "Reply window open",
    closing: "Window closing soon",
    deadlineEnd: "→ Window closed",
    score: "Score",
    progress: "Disguises",
    unit: "points",
    cleared: "Disguises defeated.",
    complete: "Investigation complete.",
    timeout: "Time ran out this time.",
    retry: "Peel again",
    review: "What was disguised?",
    safeNext:
      "Do not act on an unexpected execution request. Verify through an official contact you find independently, not one supplied by the sender. External sites and apps are not inherently malicious; the evidence here is a conflict with the explicit official rules.",
    more: "A safe next step",
    share: "Share result on X",
    shareComplete: "Should I do what they ask? Disguises {hits}/2, {score}/100 points. #TenkaCloud",
    shareHeld:
      "Should I do what they ask? Put the request safely on hold (not graded). #TenkaCloud",
    notices: {
      revealed: "Inside revealed. Compare it with the official rules.",
      aim: "Target locked. Use the button below to fire.",
      hit: "Disguise defeated! +50",
      miss: "This matches the official rules. Wrong shot −25",
    },
    covers: {
      calendar: "Choose a date",
      application: "UI test",
      task: "Open the task",
      upload: "Submit results",
    },
    actions: { WEB: "Open in browser", APP: "Run an app" },
    blocked: "Disguise blocked",
    matched: "Matches the rules",
    explanations: {
      application:
        "The ‘UI test’ asks you to run an app. That conflicts with the official ‘WEB only’ rule.",
      destination:
        "‘Submit results’ sends to aoba-skills.example. The official rule explicitly allows only aoba.example.",
      normal:
        "It opens in a browser at aoba.example. It does not conflict with the displayed rules. This is not a general guarantee of safety.",
    },
  },
};
export function shareHref(state, lang, gameUrl, points, found) {
  const t = COPY[lang];
  const text =
    state.outcome === "held"
      ? t.shareHeld
      : t.shareComplete.replace("{hits}", String(found)).replace("{score}", String(points));
  const url = new URL(gameUrl);
  url.search = new URLSearchParams({ lang }).toString();
  url.hash = "";
  return `https://twitter.com/intent/tweet?${new URLSearchParams({ text, url: url.href })}`;
}
