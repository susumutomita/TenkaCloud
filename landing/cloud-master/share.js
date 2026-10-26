/** Native web intent only. No X SDK, accounts, tokens or automatic submission. */
const PREVIEW_ORIGIN = "https://feat-cloud-master-game.tenkacloud-www.pages.dev";
const PRODUCTION_HOSTS = new Set([
  "tenkacloud.com",
  "www.tenkacloud.com",
  "tenkacloud-www.pages.dev",
]);
export function buildShare(state, currentLocation) {
  const hostname = currentLocation.hostname;
  const production = PRODUCTION_HOSTS.has(hostname);
  const pagesPreview = /^[a-z0-9-]+\.tenkacloud-www\.pages\.dev$/u.test(hostname);
  const origin = production || pagesPreview ? `https://${hostname}` : PREVIEW_ORIGIN;
  const url = `${origin}/cloud-master/`;
  const mode =
    { foundation: "クラウド基礎", http: "HTTP 要求", aws: "AWS API" }[state.mode] ?? "クラウド基礎";
  const score = Number.isFinite(state.score) ? Math.max(0, Math.floor(state.score)) : 0;
  const correct = Number.isFinite(state.correct) ? Math.max(0, Math.floor(state.correct)) : 0;
  const text = `目指せクラウドマスター\n${mode} / ${state.target.label}\n${score} pt・${correct} 正解の練習記録${state.study ? "（時間なし）" : ""}${production ? "" : "（プレビュー）"}`;
  const intent = new URL("https://x.com/intent/tweet");
  intent.searchParams.set("text", text);
  intent.searchParams.set("url", url);
  intent.searchParams.set("lang", "ja");
  return { text, url, intent: intent.href, copy: `${text}\n${url}` };
}
