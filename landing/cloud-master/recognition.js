import { CORRECT_PER_LEVEL, LESSONS, scenarioLevel } from "./curriculum.js?v=649cc787a2";
import { EVIDENCE_SCENARIOS } from "./evidence-scenarios.js?v=649cc787a2";
import { SECURITY_SCENARIOS } from "./security-scenarios.js?v=649cc787a2";
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
export const LEVEL_STAGES = LESSONS.map((_, index) => ({
  level: index + 1,
  correct: index * CORRECT_PER_LEVEL,
}));
export const PRESSURE_STAGES = [
  { level: 1, fallMs: 10000, intervalMs: 1600, limit: 1, tier: 1 },
  { level: 2, fallMs: 10000, intervalMs: 1400, limit: 2, tier: 1 },
  { level: 3, fallMs: 10000, intervalMs: 1200, limit: 3, tier: 1 },
  { level: 4, fallMs: 9000, intervalMs: 1000, limit: 3, tier: 1 },
  { level: 5, fallMs: 9000, intervalMs: 900, limit: 4, tier: 1 },
  { level: 6, fallMs: 9000, intervalMs: 800, limit: 4, tier: 2 },
  { level: 7, fallMs: 8000, intervalMs: 800, limit: 4, tier: 2 },
  { level: 8, fallMs: 8000, intervalMs: 700, limit: 5, tier: 2 },
  { level: 10, fallMs: 7000, intervalMs: 600, limit: 6, tier: 2 },
  { level: 12, fallMs: 7000, intervalMs: 500, limit: 6, tier: 3 },
  { level: 13, fallMs: 6000, intervalMs: 500, limit: 6, tier: 3 },
  { level: 15, fallMs: 6000, intervalMs: 400, limit: 6, tier: 3 },
  { level: 16, fallMs: 5500, intervalMs: 400, limit: 6, tier: 3 },
  { level: 18, fallMs: 5500, intervalMs: 280, limit: 6, tier: 3 },
  { level: 19, fallMs: 5000, intervalMs: 280, limit: 6, tier: 3 },
  { level: 22, fallMs: 4700, intervalMs: 280, limit: 6, tier: 3 },
  { level: 25, fallMs: 4400, intervalMs: 280, limit: 6, tier: 3 },
  { level: 28, fallMs: 4200, intervalMs: 280, limit: 6, tier: 3 },
];
export function levelFor(correctDecisions) {
  const count = Math.max(0, Number.isFinite(correctDecisions) ? correctDecisions : 0);
  return 1 + Math.floor(count / CORRECT_PER_LEVEL);
}
// Preserve v2.6.9 through Lv105, then use a positive power-law tail with no fixed
// late-game floor. Rendering and floating-point clock granularity remain limits.
export const TAIL_START_LEVEL = 105;
export const TAIL_FALL_MS = 600;
export const TAIL_INTERVAL_MS = 100;
function safeLevel(level) {
  if (level === Infinity) return Number.MAX_SAFE_INTEGER;
  return Number.isFinite(level)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(level)))
    : 1;
}
export function pressureFor(level) {
  return Math.max(
    0,
    PRESSURE_STAGES.findLastIndex((p) => safeLevel(level) >= p.level),
  );
}
export function difficulty(level = 1, pressureIndex = pressureFor(level)) {
  const stage =
    PRESSURE_STAGES[
      Number.isFinite(pressureIndex)
        ? Math.max(0, Math.min(PRESSURE_STAGES.length - 1, Math.floor(pressureIndex)))
        : pressureFor(level)
    ];
  const current = safeLevel(level);
  const tail = stage.level === 28 && current > TAIL_START_LEVEL;
  const scale = tail
    ? Math.sqrt(TAIL_START_LEVEL / current)
    : stage.level === 28
      ? 0.975 ** Math.max(0, current - 28)
      : 1;
  return {
    ...stage,
    fallMs: tail ? TAIL_FALL_MS * scale : Math.max(TAIL_FALL_MS, Math.round(stage.fallMs * scale)),
    intervalMs: tail
      ? TAIL_INTERVAL_MS * scale
      : Math.max(TAIL_INTERVAL_MS, Math.round(stage.intervalMs * scale)),
    level: current,
  };
}
export const QUESTION_COOLDOWN_MS = 8000;
export function levelChanges(previous, current) {
  return {
    faster: false,
    morePatterns: Math.min(current, LESSONS.length) > Math.min(previous, LESSONS.length),
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
const preparedPools = new WeakMap();
function poolsFor(catalog) {
  if (preparedPools.has(catalog)) return preparedPools.get(catalog);
  const supported = (s) =>
    s.serviceId === "signin" ||
    catalog.some((m) => m.id === s.serviceId && m.operations.some((op) => op[0] === s.operation));
  const all = [
    ...SECURITY_SCENARIOS.filter(
      (s) => supported(s) && (!s.normalRequest || supported(s.normalRequest)),
    ),
    ...EVIDENCE_SCENARIOS,
  ];
  const result = {
    all,
    stages: Object.fromEntries(
      LESSONS.map((_, index) => [index + 1, all.filter((s) => scenarioLevel(s.id) <= index + 1)]),
    ),
  };
  preparedPools.set(catalog, result);
  return result;
}
export function availableScenarios(catalog) {
  return poolsFor(catalog).all;
}
export function availableAtLevel(catalog, level) {
  return poolsFor(catalog).stages[Math.min(LESSONS.length, Math.max(1, level))];
}
function currentLevel(state) {
  return state.taughtLevel ?? 1;
}
function currentGroup(state) {
  return availableAtLevel(state.catalog, currentLevel(state)).filter(
    (s) => scenarioLevel(s.id) === currentLevel(state),
  );
}
function blockedDecisions(state) {
  const keys = new Set(
    (state.active ?? []).map((x) => `${x.question.scenarioId}:${x.question.danger}`),
  );
  const group = currentGroup(state),
    small = group.length <= 2 && state.taughtLevel !== undefined;
  for (const entry of state.history ?? []) {
    const cooldown =
      small && scenarioLevel(entry.question.scenarioId) === currentLevel(state)
        ? 2000
        : QUESTION_COOLDOWN_MS;
    if (state.elapsed - entry.at < cooldown)
      keys.add(`${entry.question.scenarioId}:${entry.question.danger}`);
  }
  return keys;
}
function freshFor(pool, blocked, intended) {
  return pool.filter((s) => !blocked.has(`${s.id}:${intended}`));
}
function operationKey(scenario, intended = true) {
  const request = !intended && scenario.normalRequest ? scenario.normalRequest : scenario;
  return scenario.family
    ? `${scenario.family}:${scenario.title}`
    : `${request.serviceId ?? scenario.serviceId}:${request.operation ?? scenario.operation}`;
}
// Structural judgment keys group similar comparisons, not AWS detector rules.
export function scenarioType(s) {
  return JSON.stringify(
    s.family
      ? [s.family, s.focusLabel, s.operator, typeof s.normal, typeof s.flag]
      : [
          s.serviceId,
          s.operation,
          s.field,
          s.normalRequest?.serviceId ?? s.serviceId,
          s.normalRequest?.operation ?? s.operation,
          typeof s.risk,
        ],
  );
}
function unseenFirst(state, choices) {
  if (currentLevel(state) === 1) return choices;
  const unseenTypes = choices.filter((s) => !state.seenTypes?.has(scenarioType(s)));
  if (unseenTypes.length) return unseenTypes;
  const unseenCases = choices.filter((s) => !state.seenScenarios?.has(s.id));
  return unseenCases.length ? unseenCases : choices;
}
function practicePool(state, group, level) {
  if (level === 1) return group;
  if (state.lessonStats?.normal > 0 && state.lessonStats?.danger > 0) return [];
  return group;
}
function chooseFromBag(state, key, pool, intended, blocked, variedOnly = false) {
  const fresh = freshFor(pool, blocked, intended);
  if (!fresh.length) return null;
  const ids = new Set(pool.map((s) => s.id));
  state[key] = (state[key] ?? []).filter((s) => ids.has(s.id));
  if (!state[key].length) state[key] = shuffled(pool, state);
  const alternatives = fresh.filter((s) => s.id !== state.lastScenario);
  const varied = alternatives.filter(
    (s) => currentLevel(state) === 1 || operationKey(s, intended) !== state.lastOperation,
  );
  if (variedOnly && !varied.length) return null;
  const choices = unseenFirst(
    state,
    varied.length ? varied : alternatives.length ? alternatives : fresh,
  );
  let index = state[key].findLastIndex((s) => choices.some((x) => x.id === s.id));
  if (index < 0) {
    state[key] = shuffled(choices, state);
    index = state[key].length - 1;
  }
  return state[key].splice(index, 1)[0];
}
function eligibleOutcomeIndex(state, priority, pool, blocked) {
  const preferred = state.outcomes.findLastIndex(
    (outcome) => freshFor(priority, blocked, outcome).length,
  );
  return preferred >= 0
    ? preferred
    : state.outcomes.findLastIndex((outcome) => freshFor(pool, blocked, outcome).length);
}
function selection(state) {
  if (!state.outcomes.length)
    state.outcomes = shuffled([true, false, true, false, true, false], state);
  const level = currentLevel(state),
    stage = Math.min(level, LESSONS.length),
    pool = availableAtLevel(state.catalog, level),
    group = practicePool(state, currentGroup(state), level);
  let blocked = blockedDecisions(state);
  if (state.scenarioTier !== stage) {
    state.scenarioBag = [];
    state.lessonBag = [];
    state.scenarioTier = stage;
  }
  const priority = state.practiceTurn && group.length ? group : pool;
  let index = eligibleOutcomeIndex(state, priority, pool, blocked);
  if (index < 0 && !(state.active ?? []).length) {
    blocked = new Set();
    index = eligibleOutcomeIndex(state, priority, pool, blocked);
  }
  if (index < 0) return null;
  const intended = state.outcomes[index];
  let scenario =
    state.practiceTurn && group.length
      ? chooseFromBag(state, "lessonBag", group, intended, blocked, level > 1)
      : null;
  const practised = Boolean(scenario);
  scenario ??= chooseFromBag(state, "scenarioBag", pool, intended, blocked);
  if (!scenario) return null;
  state.outcomes.splice(index, 1);
  if (state.practiceTurn === false || practised) state.practiceTurn = !state.practiceTurn;
  state.seenTypes ??= new Set();
  state.seenScenarios ??= new Set();
  state.seenTypes.add(scenarioType(scenario));
  state.seenScenarios.add(scenario.id);
  state.lastScenario = scenario.id;
  state.lastOperation = operationKey(scenario, intended);
  return { scenario, intended };
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
const foundationParameters = {
  EC2ProductionTerminationProtection: (value) => ({
    InstanceId: "i-production",
    DisableApiTermination: { Value: value === "ON" },
  }),
  ALBApprovedForwardTarget: (target) => ({
    ListenerArn:
      "arn:aws:elasticloadbalancing:ap-northeast-1:111122223333:listener/app/production/1111111111111111/2222222222222222",
    DefaultActions: [
      {
        Type: "forward",
        TargetGroupArn: `arn:aws:elasticloadbalancing:ap-northeast-1:111122223333:targetgroup/${target}/3333333333333333`,
      },
    ],
  }),
  SecurityGroupAppSource: (group) => ({
    GroupId: "sg-application",
    IpPermissions: [
      { IpProtocol: "tcp", FromPort: 8080, ToPort: 8080, UserIdGroupPairs: [{ GroupId: group }] },
    ],
  }),
  CloudFrontApprovedOrigin: (domain) => ({
    Id: "SYNTHETIC-DISTRIBUTION",
    IfMatch: "SYNTHETIC-ETAG",
    DistributionConfig: {
      Origins: { Quantity: 1, Items: [{ Id: "app-origin", DomainName: domain }] },
      DefaultCacheBehavior: { TargetOriginId: "app-origin" },
    },
  }),
  WAFEnforcedBlock: (action) => ({
    Name: "production-web",
    Scope: "REGIONAL",
    Id: "SYNTHETIC-WEB-ACL",
    LockToken: "SYNTHETIC-LOCK",
    DefaultAction: { Allow: {} },
    Rules: [
      {
        Name: "known-denylist",
        Priority: 0,
        Action: structuredClone(action),
        Statement: {
          IPSetReferenceStatement: {
            ARN: "arn:aws:wafv2:ap-northeast-1:111122223333:regional/ipset/known-denylist/11111111-2222-3333-4444-555555555555",
          },
        },
      },
    ],
  }),
};
function initialParameters(s, actual) {
  if (foundationParameters[s.id]) return foundationParameters[s.id](actual);
  if (s.parameters) return structuredClone(s.parameters);
  return s.field.startsWith("eventContext.") ? {} : nested(s.field, actual);
}
function requestData(s, actual) {
  let parameters = initialParameters(s, actual);
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
  if (s.id === "EC2SecurityGroupPublicSSH" && !s.parameters) return `TCP 22 / CidrIp: ${actual}`;
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
function sampleNumericEvidence(state, s) {
  const tier = difficulty(state.taughtLevel, state.pressureIndex).tier;
  const ratio = tier === 1 ? 0.2 : tier === 2 ? 0.6 : 0.8;
  const minimum = s.threshold > 0 ? Math.max(1, Math.ceil(s.threshold * ratio)) : 0;
  s.normal = minimum + Math.floor(random(state) * (s.threshold - minimum + 1));
  const spread =
    tier === 1
      ? Math.max(5, s.threshold * 5)
      : tier === 2
        ? Math.max(5, s.threshold)
        : Math.max(2, s.threshold * 0.2);
  s.flag = s.threshold + 1 + Math.floor(random(state) * spread) + (tier === 1 ? s.threshold : 0);
}
function sampleEvidence(state, source) {
  const s = { ...source };
  if (s.operator === "gt") {
    sampleNumericEvidence(state, s);
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
  return `今回の判断: ${danger ? "検知" : "通す"}。今回の観測: ${context.observed}。対象・用途: ${context.policy}。${comparison}${danger ? ` 補足: ${detail}` : ""} これは表示した演習方針への適合判定です。通す例も安全の証明ではなく、GuardDuty findingの有無は判定しません。数値・条件は演習の前提で、AWSの非公開判定式や実行成功は再現しません。`;
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
  const selected = selection(state);
  if (!selected) return null;
  const { scenario, intended } = selected;
  const question = scenario.family
    ? evidenceQuestion(state, scenario, intended)
    : apiQuestion(state, scenario, intended);
  return { ...question, lessonLevel: scenarioLevel(scenario.id) };
}
function apiSource(scenario) {
  return officialSource(
    scenario.source ??
      (scenario.id.includes(":")
        ? `https://docs.aws.amazon.com/guardduty/latest/ug/${scenario.id.includes(":S3/") ? "guardduty_finding-types-s3.html" : "guardduty_finding-types-iam.html"}`
        : "https://docs.aws.amazon.com/guardduty/latest/ug/findings-custom-detection-rules.html"),
    scenario.referenceText ?? scenario.id,
  );
}
function apiQuestion(state, scenario, intended) {
  const request =
    !intended && scenario.normalRequest ? { ...scenario, ...scenario.normalRequest } : scenario;
  const model =
    request.serviceId === "signin" ? null : state.catalog.find((s) => s.id === request.serviceId);
  const operation = model?.operations.find((op) => op[0] === request.operation);
  const actual = intended ? scenario.risk : scenario.safe;
  const observed = visiblePayload(request, actual);
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
  const { parameters, metadata } = requestData(request, actual);
  return {
    id: `${state.questionSerial++}:${scenario.id}`,
    scenarioId: scenario.id,
    serviceId: request.serviceId,
    service: model?.name ?? "AWS Sign-In",
    operation: request.operation,
    method,
    path,
    protocol: model?.protocol ?? "cloudtrail-event",
    payload: observed,
    parameters,
    metadata,
    wire: `${request.serviceId === "signin" ? "合成CloudTrailイベント" : "API引数のデコード抜粋"} · ${request.operation}\n${JSON.stringify(parameters, null, 2)}\n付帯観測（API引数とは別）: ${JSON.stringify(metadata)}\n${scenario.baseline}`,
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
    source: apiSource(scenario),
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
    lastOperation: null,
    outcomes: [],
    questionSerial: 0,
  };
}
