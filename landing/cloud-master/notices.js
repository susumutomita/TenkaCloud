import { LESSONS, lessonForLevel } from "./curriculum.js?v=8dd78c52dc";
import { tr } from "./i18n.js?v=8dd78c52dc";
import { PRESSURE_STAGES } from "./recognition.js?v=8dd78c52dc";

export function lessonNotice(level, locale = "ja") {
  const lesson = lessonForLevel(level);
  return {
    title: tr("レベルアップ Lv{level}", { level }, locale),
    detail:
      level <= LESSONS.length
        ? locale === "en"
          ? lesson.enCue
          : lesson.cue
        : tr("次も正しく見分けよう。", {}, locale),
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
  return { title: tr("レベルアップ", {}, locale), detail: changes.join(" · ") };
}
