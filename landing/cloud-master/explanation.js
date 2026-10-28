import { API_COPY, EVIDENCE_HEADLINES } from "./explanation-copy.js?v=ab7d2594f9";
import { explanationTitle } from "./explanation-titles.js?v=ab7d2594f9";
import { questionView } from "./question-locales.js?v=ab7d2594f9";

const value = (x) => (typeof x === "string" ? x : JSON.stringify(x));
const MEANING = {
  elbv2: "リクエストの振り分け",
  cloudfront: "コンテンツの配信",
  wafv2: "Webリクエストの検査",
  s3: "ファイル置き場",
  iam: "操作権限",
  ec2: "仮想サーバー",
  rds: "データベース",
  lambda: "プログラム実行",
  cloudtrail: "操作の記録",
};
function expectedValue(q) {
  const c = q.context;
  if (c.kind !== "evidence") return value(c.allowed);
  return c.operator === "gt" ? `${c.threshold}以下` : value(q.normalValue);
}
function indicatorCopy(q, field) {
  const headline = /SuspiciousFile/.test(q.scenarioId)
    ? "要調査のファイルの指紋と一致"
    : "注意対象の指標と一致しています";
  return {
    headline: q.danger ? headline : "これは止めなくてOK",
    reason: q.danger
      ? `${field}が、カードに示した注意対象と一致しています。`
      : `${field}は、カードに示した注意対象とは異なります。`,
  };
}
function evidenceCopy(q, field, actual) {
  const c = q.context;
  if (c.operator === "gt")
    return {
      headline: q.danger ? `${field}が、今回の上限を超えています` : "これは止めなくてOK",
      reason: `${field}は${actual}。${c.policy}`,
    };
  if (/指標|指紋|脅威リスト|Tor.*リスト/.test(c.policy + field)) return indicatorCopy(q, field);
  return {
    headline: q.danger
      ? (EVIDENCE_HEADLINES[field] ?? `${field}が、今回の予定と違います`)
      : "これは止めなくてOK",
    reason: `${field}は${actual}。${c.policy}`,
  };
}
export function explanationCard(q, locale = "ja") {
  if (locale === "en") return questionView(q, locale);
  const c = q.context,
    field = q.decisionField;
  const actual = value(c.actual),
    expected = expectedValue(q),
    copy = API_COPY[q.scenarioId];
  const summary = copy
    ? { headline: q.danger ? copy[0] : "これは止めなくてOK", reason: copy[q.danger ? 1 : 2] }
    : evidenceCopy(q, field, actual);
  const { headline, reason } = summary;
  return {
    headline: explanationTitle(q),
    operation: q.operation,
    meaning: MEANING[q.serviceId] ?? q.service,
    danger: q.danger,
    field,
    actual,
    expected,
    expectedLabel: c.kind === "evidence" && c.operator === "eq" ? "正常の例" : "この対象の条件",
    reason,
    successReason: headline,
    policy: c.policy,
    fullReason: q.why,
    wire: q.wire,
    source: q.source,
  };
}
