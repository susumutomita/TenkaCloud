const PREVIEW_ORIGIN = "https://feat-cloud-master-game.tenkacloud-www.pages.dev";
const PRODUCTION_HOSTS = new Set([
  "tenkacloud.com",
  "www.tenkacloud.com",
  "tenkacloud-www.pages.dev",
]);
export function buildShare(state, currentLocation) {
  const hostname = currentLocation.hostname;
  const production = PRODUCTION_HOSTS.has(hostname);
  const preview = /^[a-z0-9-]+\.tenkacloud-www\.pages\.dev$/u.test(hostname);
  const url = `${production || preview ? `https://${hostname}` : PREVIEW_ORIGIN}/cloud-master/`;
  const score = Number.isFinite(state.score) ? Math.max(0, Math.floor(state.score)) : 0;
  const text = `目指せクラウドマスター\nAWSリクエスト検知 / ${score} pt\n正しい検知 ${state.correct}・正常通過 ${state.passed}${state.study ? "（時間なし）" : ""}${production ? "" : "（プレビュー）"}\n架空のイベントを使う練習記録`;
  const intent = new URL("https://x.com/intent/tweet");
  intent.searchParams.set("text", text);
  intent.searchParams.set("url", url);
  intent.searchParams.set("lang", "ja");
  return { text, url, intent: intent.href, copy: `${text}\n${url}` };
}
