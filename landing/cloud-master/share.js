import { tr } from "./i18n.js?v=9d632ed0b9";
import { formatSurvival } from "./time.js?v=9d632ed0b9";

const PREVIEW_ORIGIN = "https://feat-cloud-master-game.tenkacloud-www.pages.dev";
const PRODUCTION_HOSTS = new Set([
  "tenkacloud.com",
  "www.tenkacloud.com",
  "tenkacloud-www.pages.dev",
]);
export function buildShare(state, currentLocation, locale = "ja") {
  const hostname = currentLocation.hostname;
  const production = PRODUCTION_HOSTS.has(hostname);
  const preview = /^[a-z0-9-]+\.tenkacloud-www\.pages\.dev$/u.test(hostname);
  const url = `${production || preview ? `https://${hostname}` : PREVIEW_ORIGIN}/cloud-master/${locale === "en" ? "?lang=en" : ""}`;
  const score = Number.isFinite(state.score) ? Math.max(0, Math.floor(state.score)) : 0;
  const survival = formatSurvival(state.elapsed, locale);
  const text = tr(
    "APIの番人。｜目指せクラウドマスター\n生存 {time} / {score} pt\n正しい検知 {correct}・正常通過 {passed}{preview}\n架空のイベントを使う練習記録",
    {
      time: survival,
      score,
      correct: state.correct,
      passed: state.passed,
      preview: production ? "" : tr("（プレビュー）", {}, locale),
    },
    locale,
  );
  const intent = new URL("https://x.com/intent/tweet");
  intent.searchParams.set("text", text);
  intent.searchParams.set("url", url);
  intent.searchParams.set("lang", locale);
  return { text, url, intent: intent.href, copy: `${text}\n${url}` };
}
