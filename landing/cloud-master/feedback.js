import { tr } from "./i18n.js?v=7ace2d323a";
import { questionView } from "./question-locales.js?v=7ace2d323a";
export const REASON_DURATION_MS = 2000;
export function decisionFact(question, locale = "ja") {
  const view = questionView(question, locale);
  const actual = locale === "en" ? view.actual : question.context.actual;
  const fullValue = typeof actual === "string" ? actual : JSON.stringify(actual);
  const account = /^arn:aws:iam::(\d{12}):root$/.exec(fullValue);
  if (account) return { label: tr("AWSアカウント", {}, locale), value: account[1], fullValue };
  const policy = /^arn:aws:iam::aws:policy\/(.+)$/.exec(fullValue);
  if (policy) return { label: tr("AWS管理ポリシー", {}, locale), value: policy[1], fullValue };
  return {
    label: locale === "en" ? view.field : question.decisionField,
    value: fullValue,
    fullValue,
  };
}

export function reasonDuration(copy, value, locale = "ja") {
  return locale === "ja"
    ? REASON_DURATION_MS
    : Math.min(3000, Math.max(REASON_DURATION_MS, (copy.length + value.length) * 25));
}

// Bounded result DOM even after long runs; retain all mistakes (at most three).
export function reviewEntries(history) {
  const rows = new Map(
    [...history.filter((entry) => !entry.correct), ...history.slice(-50)].map((entry) => [
      entry.uid,
      entry,
    ]),
  );
  return [...rows.values()].sort((a, b) => b.at - a.at || b.uid - a.uid);
}
