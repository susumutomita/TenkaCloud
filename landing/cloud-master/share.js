import { tr } from "./i18n.js?v=7ace2d323a";
import { formatSurvival } from "./time.js?v=7ace2d323a";

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
  let text = tr(
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
  if (state.end?.reason === "measurement-limit") {
    const record = state.end.measurement;
    text += `\n${tr(
      "測定上限到達 Lv{level} / 判定間隔 {frame}ms / {width}×{height}（端末条件付き）",
      {
        level: record.level,
        frame: Number(record.limitingFrameMs).toFixed(1),
        width: record.context.width ?? "?",
        height: record.context.height ?? "?",
      },
      locale,
    )}`;
  }
  const intent = new URL("https://x.com/intent/tweet");
  intent.searchParams.set("text", text);
  intent.searchParams.set("url", url);
  intent.searchParams.set("lang", locale);
  return { text, url, intent: intent.href, copy: `${text}\n${url}` };
}
