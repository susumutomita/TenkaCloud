import { EVIDENCE_SCENARIOS } from "./evidence-scenarios.js?v=b4e44e232c";
import { SECURITY_SCENARIOS } from "./security-scenarios.js?v=b4e44e232c";
export const PATTERNS = [...SECURITY_SCENARIOS, ...EVIDENCE_SCENARIOS].map((s) => s.id);
export function random(state) {
  state.rng = (Math.imul(state.rng, 1664525) + 1013904223) >>> 0;
  return state.rng / 4294967296;
}
export function shuffled(values, state) {
  const list = [...values];
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random(state) * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}
export const LEVEL_STAGES = [
  { at: 0, fallMs: 16000, intervalMs: 1200 },
  { at: 20000, fallMs: 13500, intervalMs: 1000 },
  { at: 40000, fallMs: 11000, intervalMs: 850 },
  { at: 60000, fallMs: 9000, intervalMs: 700 },
  { at: 90000, fallMs: 6800, intervalMs: 560 },
  { at: 120000, fallMs: 6000, intervalMs: 440 },
  { at: 150000, fallMs: 5400, intervalMs: 360 },
  { at: 180000, fallMs: 5000, intervalMs: 320 },
];
export function levelFor(elapsed) {
  const time = Math.max(0, Number.isFinite(elapsed) ? elapsed : 0);
  return time >= 180000
    ? 8 + Math.floor((time - 180000) / 30000)
    : LEVEL_STAGES.findLastIndex((s) => time >= s.at) + 1;
}
export function difficulty(elapsed = 0) {
  const level = levelFor(elapsed),
    base = LEVEL_STAGES[Math.min(level, 8) - 1];
  return {
    level,
    tier: level === 1 ? 1 : level < 5 ? 2 : 3,
    fallMs: Math.max(4200, base.fallMs - Math.max(0, level - 8) * 300),
    intervalMs: Math.max(280, base.intervalMs - Math.max(0, level - 8) * 10),
    limit: 6,
  };
}
export const QUESTION_COOLDOWN_MS = 8000;
export function levelChanges(previous, current) {
  const at = (level) => LEVEL_STAGES[Math.min(level, 8) - 1].at + Math.max(0, level - 8) * 30000;
  return {
    faster: difficulty(at(current)).fallMs < difficulty(at(previous)).fallMs,
    morePatterns: Math.min(current, 5) > Math.min(previous, 5),
  };
}
export function violates(context) {
  if (context.kind === "evidence") {
    if (context.operator === "gt") {
      if (!Number.isFinite(context.actual) || !Number.isFinite(context.threshold))
        throw new Error("Invalid numeric evidence");
      return context.actual > context.threshold;
    }
    if (
      context.operator !== "eq" ||
      context.actual === undefined ||
      context.threshold === undefined
    )
      throw new Error("Invalid evidence operator");
    return JSON.stringify(context.actual) === JSON.stringify(context.threshold);
  }
  return JSON.stringify(context.actual) !== JSON.stringify(context.allowed);
}
const STARTER = new Set([
  "RDSPubliclyAccessible",
  "EC2SecurityGroupPublicSSH",
  "Stealth:IAMUser/CloudTrailLoggingDisabled",
  "Policy:S3/BucketPublicAccessGranted",
  "RDSIAMAuthDisabled",
  "LambdaFunctionUrlPublicAccess",
  "S3LifecycleRapidExpiration",
]);
const preparedPools = new WeakMap();
function poolsFor(catalog) {
  if (preparedPools.has(catalog)) return preparedPools.get(catalog);
  const all = [
    ...SECURITY_SCENARIOS.filter(
      (s) =>
        s.serviceId === "signin" ||
        catalog.some(
          (m) => m.id === s.serviceId && m.operations.some((op) => op[0] === s.operation),
        ),
    ),
    ...EVIDENCE_SCENARIOS,
  ];
  const rank = (s) => {
    if (STARTER.has(s.id)) return 1;
    if (!s.family)
      return s.field.startsWith("eventContext.") ||
        s.field.includes("Principal") ||
        s.id.includes("SESFullAccess")
        ? 3
        : 2;
    if (["cloudtrail", "s3_data", "configuration"].includes(s.family)) return 3;
    if (["dns", "network"].includes(s.family)) return 4;
    return 5;
  };
  const result = {
    all,
    stages: Object.fromEntries(
      [1, 2, 3, 4, 5].map((stage) => [stage, all.filter((s) => rank(s) <= stage)]),
    ),
  };
  preparedPools.set(catalog, result);
  return result;
}
export function availableScenarios(catalog) {
  return poolsFor(catalog).all;
}
export function availableAtLevel(catalog, level) {
  return poolsFor(catalog).stages[Math.min(5, Math.max(1, level))];
}
function blockedDecisions(state) {
  const keys = new Set(
    (state.active ?? []).map((x) => `${x.question.scenarioId}:${x.question.danger}`),
  );
  const history = state.history ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (state.elapsed - history[i].at >= QUESTION_COOLDOWN_MS) break;
    keys.add(`${history[i].question.scenarioId}:${history[i].question.danger}`);
  }
  return keys;
}
function choose(state, intended) {
  const stage = Math.min(5, difficulty(state.elapsed).level),
    pool = availableAtLevel(state.catalog, stage),
    blocked = blockedDecisions(state);
  const fresh = (s) => !blocked.has(`${s.id}:${intended}`);
  if (!pool.some(fresh)) return null;
  if (!state.scenarioBag.length || state.scenarioTier !== stage) {
    state.scenarioBag = shuffled(pool, state);
    state.scenarioTier = stage;
  }
  let index = state.scenarioBag.findLastIndex((s) => fresh(s) && s.id !== state.lastScenario);
  if (index < 0) {
    const alternatives = pool.filter((s) => fresh(s) && s.id !== state.lastScenario);
    state.scenarioBag = shuffled(alternatives.length ? alternatives : pool.filter(fresh), state);
    index = state.scenarioBag.length - 1;
  }
  const result = state.scenarioBag.splice(index, 1)[0];
  state.lastScenario = result.id;
  return result;
}
function valueText(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}
function nested(path, value) {
  const parts = path.replaceAll("[0]", ".0").split(".");
  const root = {};
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    node[key] = parts[i + 1] === "0" ? [] : {};
    node = node[key];
  }
  node[parts.at(-1)] = value;
  return root;
}
function requestData(s, actual) {
  let parameters = s.field.startsWith("eventContext.") ? {} : nested(s.field, actual);
  const metadata = s.field.startsWith("eventContext.") ? { [s.field.slice(13)]: actual } : {};
  if (s.id === "RDSMasterPasswordReset")
    parameters = { DBInstanceIdentifier: "customer-db", MasterUserPassword: "[REDACTED]" };
  if (s.id === "SageMakerLifecycleConfigModified")
    parameters = { OnStart: [{ Content: "[本文省略・実行不可]" }] };
  if (s.id === "EC2UserDataModified") parameters = { UserData: { Value: "[本文省略・実行不可]" } };
  if (s.id === "RolesAnywhereTrustAnchorCreated")
    parameters = {
      source: {
        sourceType: "CERTIFICATE_BUNDLE",
        sourceData: { x509CertificateData: "[公開証明書省略]" },
      },
    };
  if (s.id === "RDSSnapshotPubliclyShared") parameters.AttributeName = "restore";
  if (s.id === "EC2SecurityGroupPublicSSH")
    Object.assign(parameters.IpPermissions[0], { IpProtocol: "tcp", FromPort: 22, ToPort: 22 });
  if (s.id === "S3BucketPolicyExternalAccess") {
    Object.assign(parameters.Policy.Statement[0], {
      Effect: "Allow",
      Action: "s3:GetObject",
      Resource: "arn:aws:s3:::customer-data/*",
    });
    parameters.Policy = JSON.stringify(parameters.Policy);
  }
  if (s.id === "IAMRoleTrustPolicyModified") {
    Object.assign(parameters.PolicyDocument.Statement[0], {
      Effect: "Allow",
      Action: "sts:AssumeRole",
    });
    parameters.PolicyDocument = JSON.stringify(parameters.PolicyDocument);
  }
  if (s.id === "S3LifecycleRapidExpiration")
    Object.assign(parameters.LifecycleConfiguration.Rules[0], {
      ID: "audit-retention",
      Status: "Enabled",
      Filter: { Prefix: "" },
    });
  return { parameters, metadata };
}
function visiblePayload(s, actual) {
  const field = s.field.replace("eventContext.", "観測.");
  if (s.id === "EC2SecurityGroupPublicSSH") return `TCP 22 / CidrIp: ${actual}`;
  if (s.id === "RDSMasterPasswordReset") return `MasterUserPassword: [REDACTED]\n変更票: ${actual}`;
  if (s.id === "SageMakerLifecycleConfigModified")
    return `OnStart.Content: [本文省略]\n内容ハッシュ: ${actual}`;
  if (s.id === "EC2UserDataModified") return `UserData: [本文省略]\n内容ハッシュ: ${actual}`;
  if (s.id === "RolesAnywhereTrustAnchorCreated")
    return `CERTIFICATE_BUNDLE\n証明書指紋: ${actual}`;
  return `${field}: ${valueText(actual)}`;
}

export function officialSource(base, reference) {
  return `${base}#:~:text=${encodeURIComponent(reference)}`;
}
function sampleEvidence(state, source) {
  const s = { ...source };
  if (s.operator === "gt") {
    const minimum = s.threshold > 0 ? Math.max(1, Math.ceil(s.threshold * 0.2)) : 0;
    s.normal = minimum + Math.floor(random(state) * (s.threshold - minimum + 1));
    const subtle = difficulty(state.elapsed).tier >= 3;
    s.flag =
      s.threshold +
      1 +
      Math.floor(random(state) * Math.max(5, s.threshold * (subtle ? 1 : 5))) +
      (subtle ? 0 : s.threshold);
  } else if (typeof s.flag === "string" && /^203\.0\.113\.\d+$/u.test(s.flag)) {
    const prefix = ["192.0.2", "198.51.100", "203.0.113"][Math.floor(random(state) * 3)];
    const n = 1 + Math.floor(random(state) * 250);
    const flag = `${prefix}.${n}`,
      normal = `${prefix}.${n === 250 ? 251 : n + 1}`;
    s.baseline = s.baseline.replaceAll(s.flag, flag);
    s.normal = normal;
    s.flag = flag;
    s.threshold = flag;
  } else if (typeof s.flag === "string" && /^edge-[a-f0-9]+\.example$/u.test(s.flag)) {
    const nonce = Math.floor(random(state) * 900) + 100;
    const flag = `svc-${nonce}.example`,
      normal = `svc-${nonce + 1}.example`;
    s.baseline = s.baseline.replaceAll(s.flag, flag);
    s.normal = normal;
    s.flag = flag;
    s.threshold = flag;
  }
  return s;
}
function decisionExplanation(context, focusLabel, detail) {
  const danger = violates(context);
  let comparison;
  if (context.kind !== "evidence") {
    comparison = `この演習の正常条件は ${focusLabel}: ${valueText(context.allowed)}。今回の値 ${valueText(context.actual)} は${danger ? "その条件と一致しないため検知します" : "その条件と一致するため通します"}。`;
  } else if (context.operator === "gt") {
    comparison = `この演習の上限は ${focusLabel}: ${valueText(context.threshold)}。今回の値 ${valueText(context.actual)} は${danger ? "上限を超えるため検知します" : "上限以下のため通します"}。`;
  } else {
    comparison = `この演習の要確認条件は ${focusLabel}: ${valueText(context.threshold)}。今回の値 ${valueText(context.actual)} は${danger ? "その条件と一致するため検知します" : "その条件とは異なるため通します"}。`;
  }
  return `今回の判断: ${danger ? "検知" : "通す"}。今回の観測: ${context.observed}。対象・用途: ${context.policy}。${comparison}${danger ? ` 補足: ${detail}` : ""} 数値・条件は表示した演習の前提です。AWSの非公開判定式や実行成功は再現しません。`;
}
function briefReason(context, label) {
  const field = label.split(".").at(-1);
  if (!violates(context)) return `${field}: ${valueText(context.actual)} — 表示した正常条件と整合`;
  const comparison =
    context.kind !== "evidence"
      ? `正常値 ${valueText(context.allowed)} と不一致`
      : context.operator === "gt"
        ? `演習上限 ${valueText(context.threshold)} 超え`
        : "表示した要確認条件に一致";
  return `${field}: ${valueText(context.actual)} — ${comparison}`;
}
function evidenceQuestion(state, source, intended) {
  const s = sampleEvidence(state, source);
  const actual = intended ? s.flag : s.normal;
  const variantExtra = intended ? s.flagExtra : s.normalExtra;
  const fields = [[s.focusLabel, actual], ...s.extra, ...(variantExtra ?? [])];
  const observed = fields.map(([label, value]) => `${label}: ${valueText(value)}`).join("\n");
  const context = {
    kind: "evidence",
    actual,
    operator: s.operator,
    threshold: s.threshold,
    policy: s.baseline,
    observed,
  };
  const danger = violates(context);
  return {
    id: `${state.questionSerial++}:${s.id}`,
    scenarioId: s.id,
    serviceId: `evidence:${s.family}`,
    service: {
      cloudtrail: "CloudTrail",
      dns: "DNS",
      network: "通信",
      runtime: "Runtime",
      runtime_custom: "Runtime",
      malware: "ファイル検査",
      rds: "RDS監査",
      kubernetes: "K8s監査",
      sequence: "相関",
      ai: "AI監査",
      s3_data: "S3監査",
      configuration: "構成差分",
    }[s.family],
    operation: s.title,
    protocol: `synthetic-${s.family}`,
    method: "OBSERVATION",
    path: "",
    evidenceFamily: s.family,
    fields,
    payload: observed,
    parameters: {},
    metadata: { evidenceType: s.family, fields },
    wire: `合成${s.family}観測（API要求ではありません） · ${s.title}\n${observed}\n${s.baseline}`,
    context,
    danger,
    severity: danger ? s.severity : 0,
    points: danger ? s.severity * 10 : 10,
    decisionField: s.focusLabel,
    teachingNote: s.why,
    normalValue: s.normal,
    why: decisionExplanation(context, s.focusLabel, s.why),
    briefReason: briefReason(context, s.focusLabel),
    source: officialSource(s.source, s.referenceText),
  };
}
export function nextQuestion(state) {
  if (!state.outcomes.length)
    state.outcomes = shuffled([true, false, true, false, true, false], state);
  const intended = state.outcomes.pop();
  const scenario = choose(state, intended);
  if (!scenario) {
    state.outcomes.push(intended);
    return null;
  }
  if (scenario.family) return evidenceQuestion(state, scenario, intended);
  const model =
    scenario.serviceId === "signin" ? null : state.catalog.find((s) => s.id === scenario.serviceId);
  const operation = model?.operations.find((op) => op[0] === scenario.operation);
  const actual = intended ? scenario.risk : scenario.safe;
  const observed = visiblePayload(scenario, actual);
  const context = {
    kind: scenario.id,
    allowed: scenario.safe,
    actual,
    policy: scenario.baseline,
    observed,
    severity: scenario.severity,
  };
  const danger = violates(context);
  const method = operation?.[1] ?? "EVENT",
    path = operation?.[2] ?? "CloudTrail console sign-in";
  const { parameters, metadata } = requestData(scenario, actual);
  return {
    id: `${state.questionSerial++}:${scenario.id}`,
    scenarioId: scenario.id,
    serviceId: scenario.serviceId,
    service: model?.name ?? "AWS Sign-In",
    operation: scenario.operation,
    method,
    path,
    protocol: model?.protocol ?? "cloudtrail-event",
    payload: observed,
    parameters,
    metadata,
    wire: `${scenario.serviceId === "signin" ? "合成CloudTrailイベント" : "API引数のデコード抜粋"} · ${scenario.operation}\n${JSON.stringify(parameters, null, 2)}\n付帯観測（API引数とは別）: ${JSON.stringify(metadata)}\n${scenario.baseline}`,
    context,
    danger,
    severity: danger ? scenario.severity : 0,
    points: danger ? Math.round(scenario.severity * 10) : 10,
    why: decisionExplanation(
      context,
      scenario.field.replace("eventContext.", "観測."),
      scenario.why,
    ),
    decisionField: scenario.field.replace("eventContext.", "観測."),
    teachingNote: scenario.why,
    briefReason: briefReason(context, scenario.field.replace("eventContext.", "観測.")),
    source: officialSource(
      scenario.id.includes(":")
        ? `https://docs.aws.amazon.com/guardduty/latest/ug/${scenario.id.includes(":S3/") ? "guardduty_finding-types-s3.html" : "guardduty_finding-types-iam.html"}`
        : "https://docs.aws.amazon.com/guardduty/latest/ug/findings-custom-detection-rules.html",
      scenario.id,
    ),
  };
}
export function createQuestionStream(catalog, seed = 726) {
  // Build catalog/tier indexes before the animation loop starts.
  poolsFor(catalog);
  let mixed = ((seed >>> 0) + 0x9e3779b9) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x85ebca6b);
  mixed = Math.imul(mixed ^ (mixed >>> 13), 0xc2b2ae35);
  return {
    catalog,
    rng: (mixed ^ (mixed >>> 16)) >>> 0,
    correct: 0,
    elapsed: 0,
    scenarioTier: 0,
    scenarioBag: [],
    lastScenario: null,
    outcomes: [],
    questionSerial: 0,
  };
}
