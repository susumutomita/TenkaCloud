import { lessonForLevel } from "./curriculum.js?v=d4e78492cd";
import { tr } from "./i18n.js?v=d4e78492cd";
import { PRESSURE_STAGES } from "./recognition.js?v=d4e78492cd";

export function lessonNotice(level, locale = "ja") {
  const lesson = lessonForLevel(level);
  return {
    title: tr("難度{level}↑", { level }, locale),
    detail: locale === "en" ? lesson.enCue : lesson.cue,
  };
}

export function pressureNotice(
  previous,
  current,
  { capacity = 6, numeric = false } = {},
  locale = "ja",
) {
  const before = PRESSURE_STAGES[previous],
    after = PRESSURE_STAGES[current];
  const changes = [];
  if (after.fallMs < before.fallMs) changes.push(tr("速度↑", {}, locale));
  if (Math.min(after.limit, capacity) > Math.min(before.limit, capacity))
    changes.push(tr("枚数↑", {}, locale));
  if (numeric && after.tier > before.tier) changes.push(tr("比較が細かく", {}, locale));
  return { title: tr("難度アップ", {}, locale), detail: changes.join(" · ") };
}
