// Optional next step after play; no event, deployment or account is created here.
export function buildMailShare(run, counts, lang) {
  if (!["results", "ended", "timed-out"].includes(run.phase)) return null;
  const target = Number.isInteger(counts.target) && counts.target > 0 ? counts.target : 0;
  if (!target) return null;
  const found = Math.max(
    0,
    Math.min(target, Number.isFinite(counts.found) ? Math.floor(counts.found) : 0),
  );
  const reviewed = Math.max(
    0,
    Math.min(target - found, Number.isFinite(counts.reviewed) ? Math.floor(counts.reviewed) : 0),
  );
  const mistakes = Number.isFinite(counts.mistakes)
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(counts.mistakes)))
    : 0;
  const maxScore = Number.isFinite(counts.maxScore)
    ? Math.max(0, Math.floor(counts.maxScore))
    : 100;
  const score = Number.isFinite(counts.score)
    ? Math.max(0, Math.min(maxScore, Math.floor(counts.score)))
    : 0;
  const timeouts = Number.isFinite(counts.timeouts) ? Math.max(0, Math.floor(counts.timeouts)) : 0;
  const lastLevel = run.startLevel + run.index;
  const levelText = `Lv${run.startLevel}${lastLevel === run.startLevel ? "" : `–${lastLevel}`}`;
  const status =
    lang === "en"
      ? { results: "Finished", ended: "Stopped early", "timed-out": "Time expired" }[run.phase]
      : { results: "終了", ended: "途中終了", "timed-out": "時間切れ" }[run.phase];
  const text =
    lang === "en"
      ? `Mail Detective | ${status} · ${levelText}\nScore: ${score}/${maxScore} · Mistakes: ${mistakes} · Timed-out rounds: ${timeouts}\nFound myself: ${found}/${target} · Reviewed: ${reviewed}/${target}\nA fictional email practice, not a certification.`
      : `メールの間違いさがし。｜${status}・${levelText}\n得点 ${score}/${maxScore}・ミス ${mistakes}・時間切れ ${timeouts}\n自分で発見 ${found}/${target}・答えを見て確認 ${reviewed}/${target}\n架空メールでの練習記録です。`;
  const url = `https://tenkacloud.com/mail-detective/?lang=${lang === "en" ? "en" : "ja"}`;
  const intent = new URL("https://x.com/intent/tweet");
  intent.searchParams.set("text", text);
  intent.searchParams.set("url", url);
  return { text, url, intent: intent.href };
}
export function createMailShareLink(lang, run, counts) {
  const share = buildMailShare(run, counts, lang);
  if (!share) return document.createDocumentFragment();
  const link = document.createElement("a");
  link.id = "share-result";
  link.href = share.intent;
  link.textContent = lang === "en" ? "Share result on X" : "結果を X で共有";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}
export function createNextStep(lang) {
  const section = document.createElement("section");
  section.className = "mail-review";
  section.id = "next-practice";
  const title = document.createElement("h2");
  title.textContent = lang === "en" ? "Explore the same theme" : "同じテーマを、もう一歩。";
  const note = document.createElement("p");
  note.textContent =
    lang === "en"
      ? "Email is one part of social engineering. Related hands-on practice is in preparation. Explore other themes or the guides whenever you want to go further."
      : "メールはソーシャルエンジニアリングの一部。同テーマの実践問題は準備中です。深めたくなったら、テーマ一覧やガイドへ。";
  section.append(title, note);
  const links = [
    [
      `../portal-demo/?demo=1&goto=${encodeURIComponent(`/problems?lang=${lang}#social-practice`)}`,
      lang === "en" ? "Explore themes and practice" : "テーマと実践問題を見る",
    ],
    [
      `../docs/manual/participant/${lang === "en" ? "index.en.html" : ""}`,
      lang === "en" ? "Join with an organizer's invitation" : "主催者の招待から参加する",
    ],
    [
      `../docs/manual/organizer/${lang === "en" ? "index.en.html" : ""}`,
      lang === "en"
        ? "Try or host it yourself (setup guide)"
        : "自分で試す・開催する（準備ガイド）",
    ],
  ];
  for (const [href, label] of links) {
    const line = document.createElement("p"),
      link = document.createElement("a");
    link.href = href;
    link.textContent = label;
    line.append(link);
    section.append(line);
  }
  return section;
}
