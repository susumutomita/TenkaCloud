/** One stable task: flag a request that violates the policy visible on its card. */
export const PATTERNS = ["service", "account", "network", "approval", "acl", "keyOwner"];
const COMMON = [
  "s3",
  "ec2",
  "iam",
  "lambda",
  "dynamodb",
  "sqs",
  "sns",
  "cloudtrail",
  "logs",
  "rds",
];
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
export function levelFor(correct) {
  return Math.min(5, 1 + Math.floor(correct / 5));
}
export function difficulty(correct) {
  const level = levelFor(correct);
  return {
    level,
    fallMs: [18000, 16000, 14000, 12000, 10500][level - 1],
    intervalMs: [4500, 4000, 3500, 3000, 2600][level - 1],
    limit: level === 1 ? 2 : 3,
  };
}
function ipv4(value) {
  return value.split(".").reduce((n, part) => (n * 256 + Number(part)) >>> 0, 0);
}
export function violates(context) {
  if (context.kind === "network")
    return ipv4(context.actual) >>> 8 !== ipv4(context.allowed.split("/")[0]) >>> 8;
  return context.actual !== context.allowed;
}
function nextService(state) {
  const level = levelFor(state.correct);
  if (!state.serviceBag.length || state.bagLevel !== level) {
    const available = state.catalog
      .map((service, index) => ({ service, index }))
      .filter(({ service }) => level >= 3 || COMMON.includes(service.id));
    state.serviceBag = shuffled(
      available.map(({ index }) => index),
      state,
    );
    state.bagLevel = level;
    if (state.serviceBag.at(-1) === state.lastService && state.serviceBag.length > 1)
      [state.serviceBag[0], state.serviceBag[state.serviceBag.length - 1]] = [
        state.serviceBag.at(-1),
        state.serviceBag[0],
      ];
  }
  const index = state.serviceBag.pop();
  state.lastService = index;
  return index;
}
function nextOperation(state, index) {
  const service = state.catalog[index];
  if (!state.operationBags[index]?.length)
    state.operationBags[index] = shuffled(
      service.operations.map((_, i) => i),
      state,
    );
  return service.operations[state.operationBags[index].pop()];
}
function wire(service, operation, parameters) {
  const [name, method, path] = operation;
  const lines = [`${method} ${path}`];
  if (service.protocol === "json" && service.target)
    lines.push(`X-Amz-Target: ${service.target}.${name}`);
  if (["query", "ec2"].includes(service.protocol))
    lines.push(`Action=${name}&Version=${service.version}`);
  if (service.protocol === "smithy-rpc-v2-cbor") lines.push("Smithy-Protocol: rpc-v2-cbor");
  if (parameters) lines.push(parameters);
  return lines.join("\n");
}
function genericContext(state, service, danger) {
  const level = levelFor(state.correct);
  const kinds = level === 1 ? ["service"] : ["service", "account", "network"];
  let kind = kinds[Math.floor(random(state) * kinds.length)];
  if (service.name.length > 18 && kind === "service") kind = "account";
  if (kind === "account")
    return {
      kind,
      allowed: "検証アカウント",
      actual: danger ? "本番アカウント" : "検証アカウント",
      policy: "許可: 検証内の全API",
      observed: `実行先: ${danger ? "本番" : "検証"}`,
      severity: 4,
    };
  if (kind === "network")
    return {
      kind,
      allowed: "192.0.2.0/24",
      actual: danger ? "198.51.100.23" : "192.0.2.23",
      policy: "許可元: 192.0.2.0/24",
      observed: `発信元: ${danger ? "198.51.100.23" : "192.0.2.23"}`,
      severity: 3,
    };
  const other = state.catalog.find(
    (s) => COMMON.includes(s.id) && s.id !== service.id && s.name.length < 18,
  );
  const allowed = danger ? other.name : service.name;
  return {
    kind,
    allowed,
    actual: service.name,
    policy: `許可: ${allowed} の全API`,
    observed: `要求先: ${service.name}`,
    severity: 1,
  };
}
function curated(state, danger) {
  const pick = Math.floor(random(state) * 3);
  if (pick === 0)
    return {
      serviceId: "cloudtrail",
      operation: "StopLogging",
      parameters: '{"Name":"training-trail"}',
      context: {
        kind: "approval",
        allowed: "承認あり",
        actual: danger ? "承認なし" : "承認あり",
        policy: "本番ログ停止: 承認が必要",
        observed: `変更申請: ${danger ? "なし" : "承認済み"}`,
        severity: 8,
      },
    };
  if (pick === 1)
    return {
      serviceId: "s3",
      operation: "PutBucketAcl",
      parameters: `x-amz-acl: ${danger ? "public-read" : "private"}`,
      context: {
        kind: "acl",
        allowed: "private",
        actual: danger ? "public-read" : "private",
        policy: "このバケット: 非公開限定",
        observed: `公開範囲: ${danger ? "全員 (public-read)" : "非公開 (private)"}`,
        severity: 7.5,
      },
    };
  return {
    serviceId: "iam",
    operation: "CreateAccessKey",
    parameters: `UserName=training-${danger ? "beta" : "alpha"}`,
    context: {
      kind: "keyOwner",
      allowed: "training-alpha",
      actual: danger ? "training-beta" : "training-alpha",
      policy: "許可ユーザー: training-alpha",
      observed: `キー作成先: training-${danger ? "beta" : "alpha"}`,
      severity: 5.5,
    },
  };
}
function reason(context, danger, operation) {
  const detail = {
    service: `担当に許可されているのは「${context.allowed}」。要求先は「${context.actual}」です。`,
    account: `操作できるのは「${context.allowed}」。今回は「${context.actual}」への要求です。`,
    network: `許可された発信元は ${context.allowed}。今回は ${context.actual} です。`,
    approval: `${operation} は監査ログの記録停止を求める API です。本番での停止には変更承認が必要で、今回は「${context.actual}」です。`,
    acl:
      context.actual === "public-read"
        ? "public-read はバケットの READ（一覧など）を全員へ許可する指定です。非公開限定の演習ルールに反します。オブジェクト内容の公開とは別です。"
        : "private は所有者に限る指定です。非公開限定の演習ルールに沿っています。",
    keyOwner: `キー作成を許可された対象は ${context.allowed}。今回は ${context.actual} を指定しています。`,
  }[context.kind];
  return `${detail}${danger ? "表示した演習ルールの範囲外なので検知します。" : "演習ルールの範囲内なので、そのまま通します。"} API 名だけで不正と決めたわけではありません。実行結果は判定しません。`;
}
function requestChoice(state, intended) {
  if (levelFor(state.correct) >= 2 && random(state) < 0.28) {
    const selected = curated(state, intended);
    const service = state.catalog.find((s) => s.id === selected.serviceId);
    return {
      service,
      operation: service.operations.find((op) => op[0] === selected.operation),
      context: selected.context,
      parameters: selected.parameters,
    };
  }
  const index = nextService(state);
  const service = state.catalog[index];
  return {
    service,
    operation: nextOperation(state, index),
    context: genericContext(state, service, intended),
    parameters: "",
  };
}
export function nextQuestion(state) {
  if (!state.outcomes.length)
    state.outcomes = shuffled([true, false, true, false, true, false], state);
  const intended = state.outcomes.pop();
  const { service, operation, context, parameters } = requestChoice(state, intended);
  const requestPath =
    service.protocol === "smithy-rpc-v2-cbor"
      ? `/service/${service.target}/operation/${operation[0]}`
      : operation[2];
  const requestOperation = [operation[0], operation[1], requestPath];
  const danger = violates(context);
  return {
    id: `${state.questionSerial++}:${service.id}:${operation[0]}`,
    serviceId: service.id,
    service: service.name,
    operation: operation[0],
    method: operation[1],
    path: requestPath,
    protocol: service.protocol,
    wire: wire(service, requestOperation, parameters),
    context,
    danger,
    severity: danger ? context.severity : 0,
    points: danger ? Math.round(context.severity * 10) : 10,
    why: reason(context, danger, operation[0]),
    source: `https://github.com/boto/botocore/tree/1.43.118/botocore/data/${service.id}/${service.version}`,
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
    serviceBag: [],
    bagLevel: 0,
    lastService: null,
    operationBags: {},
    outcomes: [],
    questionSerial: 0,
  };
}
