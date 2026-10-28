import { EVIDENCE_SCENARIOS } from "./evidence-scenarios.js?v=c99bccde86";
import { SECURITY_SCENARIOS } from "./security-scenarios.js?v=c99bccde86";

const SOURCE = new Map([...SECURITY_SCENARIOS, ...EVIDENCE_SCENARIOS].map((s) => [s.id, s]));
const JAPANESE = /[\u3040-\u30ff\u3400-\u9fff]/u;
const VALUE_NOTES = {
  "[本文省略・実行不可]": "[content omitted; not executable]",
  "[公開証明書省略]": "[public certificate omitted]",
};
const SERVICE = {
  通信: "Network",
  ファイル検査: "File scan",
  RDS監査: "RDS audit",
  K8s監査: "Kubernetes audit",
  相関: "Correlation",
  AI監査: "AI audit",
  S3監査: "S3 audit",
  構成差分: "Configuration",
};
const MEANING = {
  elbv2: "Route requests",
  cloudfront: "Deliver content",
  wafv2: "Inspect web requests",
  s3: "File storage",
  iam: "Permissions",
  ec2: "Virtual servers",
  rds: "Database",
  lambda: "Run code",
  cloudtrail: "Activity logs",
};
let english, loading;
const dictionaries = new Map();
export function validateEnglishCatalog(data) {
  for (const [id, source] of SOURCE) {
    const row = data[id];
    const required = source.family
      ? ["meaningTitle", "baseline", "why", "title", "focusLabel", "successReason"]
      : ["meaningTitle", "baseline", "why", "dangerHeadline", "dangerReason", "normalReason"];
    if (!row || required.some((key) => typeof row[key] !== "string" || !row[key].trim()))
      throw new Error(`Incomplete English scenario: ${id}`);
  }
}
export async function loadQuestionLocale(locale) {
  if (locale !== "en" || english) return;
  loading ??= import("./locales/en-scenarios.js?v=c99bccde86")
    .then((module) => {
      validateEnglishCatalog(module.EN_SCENARIOS);
      english = module.EN_SCENARIOS;
      for (const [id, source] of SOURCE) {
        const map = new Map(Object.entries(VALUE_NOTES));
        collectPairs(source, english[id], map);
        dictionaries.set(id, map);
      }
    })
    .catch((error) => {
      loading = null;
      throw error;
    });
  await loading;
}
function collectPairs(source, translated, result) {
  if (typeof source === "string" && typeof translated === "string") {
    if (JAPANESE.test(source)) result.set(source, translated);
  } else if (Array.isArray(source))
    source.forEach((item, i) => {
      collectPairs(item, translated?.[i], result);
    });
  else if (source && typeof source === "object")
    for (const key of Object.keys(source)) collectPairs(source[key], translated?.[key], result);
}
function pairFor(q) {
  const source = SOURCE.get(q.scenarioId),
    en = english?.[q.scenarioId];
  if (!source || !en) throw new Error(`Missing English scenario: ${q.scenarioId}`);
  if (!dictionaries.has(q.scenarioId)) {
    const map = new Map(Object.entries(VALUE_NOTES));
    collectPairs(source, en, map);
    dictionaries.set(q.scenarioId, map);
  }
  return { source, en, map: dictionaries.get(q.scenarioId) };
}
function display(value, map) {
  if (typeof value === "string") return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => display(v, map));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, display(v, map)]));
  return value;
}
const text = (value) => (typeof value === "string" ? value : JSON.stringify(value));
function englishPolicy(q, source, en) {
  let policy = en.baseline;
  if (
    q.context.kind === "evidence" &&
    typeof source.flag === "string" &&
    q.context.threshold !== source.threshold
  )
    policy = policy.replaceAll(source.flag, String(q.context.threshold));
  return policy;
}
function apiPayload(q, field, actual) {
  if (q.scenarioId === "RDSMasterPasswordReset")
    return `MasterUserPassword: [REDACTED]\nChange ticket: ${actual}`;
  if (q.scenarioId === "SageMakerLifecycleConfigModified")
    return `OnStart.Content: [content omitted]\nContent hash: ${actual}`;
  if (q.scenarioId === "EC2UserDataModified")
    return `UserData: [content omitted]\nContent hash: ${actual}`;
  if (q.scenarioId === "RolesAnywhereTrustAnchorCreated")
    return `CERTIFICATE_BUNDLE\nCertificate fingerprint: ${actual}`;
  return `${field}: ${actual}`;
}
function fullReason(q, view, en, map) {
  let criterion;
  if (q.context.kind !== "evidence")
    criterion = `Expected for this scenario: ${view.field}: ${view.expected}.`;
  else if (q.context.operator === "gt")
    criterion = `Scenario limit: ${view.field}: ${q.context.threshold}.`;
  else
    criterion = `Review condition: ${view.field}: ${text(display(q.context.threshold, map))}. Normal example: ${view.expected}.`;
  return `${q.danger ? "Flag this observation." : "Let this observation pass."} Observed: ${view.field}: ${view.actual}. ${criterion} ${q.danger ? en.why : view.reason} This judges the stated exercise policy, not whether GuardDuty creates a finding. Passing is not proof of safety. Values and thresholds are exercise assumptions, not AWS's private detection logic or proof that a request succeeded.`;
}
function expectedValue(q, map) {
  if (q.context.kind !== "evidence") return text(display(q.context.allowed, map));
  if (q.context.operator === "gt") return `${q.context.threshold} or less`;
  return text(display(q.normalValue, map));
}
function payloadValue(q, source, map, field, actual) {
  if (!source.family) return apiPayload(q, field, actual);
  return q.fields
    .map(([label, value]) => `${display(label, map)}: ${text(display(value, map))}`)
    .join("\n");
}
function evidenceSummary(q, en, field, actual, policy) {
  if (q.context.operator === "gt")
    return {
      reason: `${field}: ${actual}. ${policy}`,
      successReason: `${field} exceeds the scenario limit`,
    };
  if (/指標|指紋|脅威リスト|Tor.*リスト/.test(q.context.policy + q.decisionField))
    return {
      reason: `${field} ${q.danger ? "matches" : "does not match"} the indicator listed in this scenario.`,
      successReason: /SuspiciousFile/.test(q.scenarioId)
        ? "Matches a fingerprint requiring review"
        : "Matches a listed indicator",
    };
  return { reason: `${field}: ${actual}. ${policy}`, successReason: en.meaningTitle };
}
function wireValue(q, view, map) {
  if (q.context.kind === "evidence")
    return `Synthetic ${view.service} observation (not an API request) · ${view.operation}\n${view.payload}\n${view.policy}`;
  const type =
    q.serviceId === "signin" ? "Synthetic CloudTrail event" : "Decoded SDK input excerpt";
  return `${type} · ${view.operation}\n${JSON.stringify(display(q.parameters, map), null, 2)}\nAdditional context (not API input): ${JSON.stringify(display(q.metadata, map))}\n${view.policy}`;
}
export function questionView(q, locale = "ja") {
  if (locale === "ja") return { ...q, policy: q.context.policy, observed: q.context.observed };
  const { source, en, map } = pairFor(q),
    actual = text(display(q.context.actual, map));
  const field = source.family ? en.focusLabel : q.decisionField.replace("観測.", "Context.");
  const policy = englishPolicy(q, source, en),
    service = SERVICE[q.service] ?? q.service;
  const payload = payloadValue(q, source, map, field, actual);
  const summary = source.family
    ? { ...evidenceSummary(q, en, field, actual, policy), successReason: en.successReason }
    : { reason: q.danger ? en.dangerReason : en.normalReason, successReason: en.dangerHeadline };
  const view = {
    operation: source.family ? en.title : q.operation,
    service,
    meaning: MEANING[q.serviceId] ?? service,
    field,
    actual,
    expected: expectedValue(q, map),
    expectedLabel:
      q.context.kind === "evidence" && q.context.operator === "eq"
        ? "Normal example"
        : "Target conditions",
    policy,
    payload,
    observed: payload,
    headline: en.meaningTitle,
    ...summary,
    danger: q.danger,
    source: q.source,
  };
  return { ...view, wire: wireValue(q, view, map), fullReason: fullReason(q, view, en, map) };
}
export function englishScenarioIds() {
  return Object.keys(english ?? {});
}
