import { EVIDENCE_SCENARIOS } from "./evidence-scenarios.js";
import { SECURITY_SCENARIOS } from "./security-scenarios.js";
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
export function levelFor(elapsed) {
  return 1 + Math.floor(Math.max(0, elapsed) / 15000);
}
export function difficulty(elapsed = 0) {
  const time = Math.max(0, elapsed);
  return {
    level: levelFor(time),
    tier: time < 30000 ? 1 : time < 90000 ? 2 : 3,
    fallMs: Math.round(4200 + 7800 * Math.exp(-time / 100000)),
    intervalMs: Math.round(280 + 920 * Math.exp(-time / 65000)),
    limit: 6,
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
export function availableScenarios(catalog) {
  return [
    ...SECURITY_SCENARIOS.filter(
      (s) =>
        s.serviceId === "signin" ||
        catalog.some(
          (m) => m.id === s.serviceId && m.operations.some((op) => op[0] === s.operation),
        ),
    ),
    ...EVIDENCE_SCENARIOS,
  ];
}
function choose(state) {
  const tier = difficulty(state.study ? 90000 : state.elapsed).tier;
  if (!state.scenarioBag.length || state.scenarioTier !== tier) {
    let list = availableScenarios(state.catalog);
    if (tier === 1) list = list.filter((s) => STARTER.has(s.id));
    else if (tier === 2)
      list = list.filter((s) =>
        s.family
          ? ["cloudtrail", "dns", "network", "s3_data", "configuration"].includes(s.family)
          : !s.field.startsWith("eventContext.") &&
            !s.field.includes("Principal") &&
            !s.id.includes("SESFullAccess"),
      );
    state.scenarioBag = shuffled(list, state);
    state.scenarioTier = tier;
    if (state.scenarioBag.at(-1)?.id === state.lastScenario && state.scenarioBag.length > 1)
      [state.scenarioBag[0], state.scenarioBag[state.scenarioBag.length - 1]] = [
        state.scenarioBag.at(-1),
        state.scenarioBag[0],
      ];
  }
  const result = state.scenarioBag.pop();
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
    why: `${s.why} ${danger ? "表示した事実をこの演習条件で要確認とします。" : "表示した条件と整合する正常例です。"} 数値・許可条件は演習用で、AWSの非公開判定式や実行成功は再現しません。`,
    source: officialSource(s.source, s.referenceText),
  };
}
export function nextQuestion(state) {
  if (!state.outcomes.length)
    state.outcomes = shuffled([true, false, true, false, true, false], state);
  const intended = state.outcomes.pop();
  const scenario = choose(state);
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
    why: `${scenario.why} ${danger ? "表示した対象・用途と要求内容が衝突するため検知します。" : "表示した対象・用途に沿う内容なので通します。"} 公開説明を基にした演習であり、AWSの実判定や要求の実行成功を再現しません。`,
    source: officialSource(
      scenario.id.includes(":")
        ? `https://docs.aws.amazon.com/guardduty/latest/ug/${scenario.id.includes(":S3/") ? "guardduty_finding-types-s3.html" : "guardduty_finding-types-iam.html"}`
        : "https://docs.aws.amazon.com/guardduty/latest/ug/findings-custom-detection-rules.html",
      scenario.id,
    ),
  };
}
export function createQuestionStream(catalog, seed = 726) {
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
