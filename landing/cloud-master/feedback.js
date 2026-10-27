import { tr } from "./i18n.js?v=e279d431f3";
import { questionView } from "./question-locales.js?v=e279d431f3";
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
