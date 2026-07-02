import type { ProblemScoringMetadata } from "../../../utils/scoring-metadata.js";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { parseStackOutputs } from "../shared/cfn-status.js";
import { DELETED_LIKE_STATUSES } from "../shared/constants.js";
import { parseEndpointsHealth } from "../shared/endpoints-health.js";
import { parseHintRevealedAttribute } from "../shared/hint-reveal.js";
import { evaluateGate, type GateBlock, getEventGate } from "./event-gate.js";
import { type ParticipantSharedResources, queryTeamItems } from "./shared.js";
import { getSolvedFlagIds } from "./submit-flag.js";

/**
 * 1 teamLoginKey = 1 team (= N deployments) として view を構成する。
 *
 * stackOutputs は DDB に JSON 文字列で入っているが、UI に返す前に object へ展開する。
 * `flagOutputKey` で指定された field は **競技者に出さない** (= 当てる対象なので)。
 */

/**
 * Issue #742 Phase 4: progressive hint の view shape。 reveal 済 hint には content が乗り、
 * 未 reveal hint は content を含まない (= server-side で revealed=false な行は content を
 * 落として送り、 frontend に答えを漏らさない)。
 *
 *   - id: stable identifier (= scoring.hints[].id と同じ)
 *   - penalty: reveal すると差し引かれるポイント (= 表示用、 0 許容)
 *   - revealed: 既に reveal 済なら true
 *   - content: revealed=true のときのみ存在
 *   - revealedAt: revealed=true のときのみ、 ISO 8601 (= UI で reveal 時刻表示用)
 */
export interface ParticipantHintView {
  readonly id: string;
  readonly penalty: number;
  readonly revealed: boolean;
  readonly content?: string;
  readonly revealedAt?: string;
}

/**
 * Participant 側に出してよい scoring 情報の view。`kind` は 5 種 builtin DSL のいずれか
 * (ADR-012 Phase 3.B)。kind ごとに見える field は最小限 (= 答えとなる flagOutputKey の
 * 値 / 攻撃 counter の生値 / 内部 platformRules の細部は出さない)。
 */
export interface ParticipantScoringInfo {
  readonly kind:
    | "flag"
    | "multi-flag"
    | "uptime"
    | "uptime-flat"
    | "uptime-multi"
    | "phased-polling"
    | "attack-detection";
  readonly points?: number;
  readonly pointsPerSuccess?: number;
  readonly pointsAllOk?: number;
  readonly pointsPerAttack?: number;
  /**
   * Issue #1796: multi-flag の sub-flag 一覧 (= portal が N 個の提出欄を出すための view)。
   * `solved` は team の `solvedFlagIds` に id が入っているかで判定する。 正解値 (flagOutputKey の
   * 値) は出さない (= 単一 flag kind の flagOutputKey strip と同方針)。
   */
  readonly flags?: readonly {
    readonly id: string;
    readonly label: string;
    readonly points: number;
    readonly solved: boolean;
  }[];
  /**
   * Issue #742 Phase 4: progressive hint。 revealed=false な hint は content を持たず、
   * frontend は locked 表示 + reveal button を出す。 revealed=true は content を含み
   * unlocked 表示 (= 旧 string[] 形式から正式 view 形式に migrate)。
   */
  readonly hints?: readonly ParticipantHintView[];
  /** Challenge / flag のとき、提出済みなら true。再提出は加点されない。 */
  readonly flagSubmitted?: boolean;
}

/**
 * チームに紐づく 1 problem 単位の view。team 集約 (`ParticipantTeamView.problems[]`) の
 * 1 要素として返す。
 */
/**
 * Battle 系 (uptime kind) deployment の health 集約。`endpointsHealth` JSON を per-endpoint
 * のまま露出すると「どの endpoint が落ちているか」が見えてしまい Battle のゲーム性
 * (= 防御側が自分で調査) を破壊するため、aggregate のみに絞る (ADR-005 D1)。
 *
 * 旧 deployment / probe 未実行 / Challenge 系 (= flag kind、HealthCheck 対象外) は
 * `unknown` を返す。
 */
export type ApplicationStatusOverall = "healthy" | "degraded" | "down" | "unknown";

export interface ApplicationStatus {
  readonly overall: ApplicationStatusOverall;
  readonly healthyCount: number;
  readonly totalCount: number;
  /** 最後の probe 時刻 (ISO 8601)。`unknown` のときは undefined。 */
  readonly checkedAt?: string;
}

export interface DeploymentLogEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly source: "deployment";
  readonly level: "info" | "success" | "warning" | "error";
  readonly message: string;
}

export interface DeploymentLogView {
  /**
   * `/portal/me` polling で差分判定するための cursor。現状は DDB row の updatedAt を使い、
   * CloudWatch Logs 直読を後続で足す場合は nextToken に差し替え可能な shape にしておく。
   */
  readonly cursor: string;
  readonly entries: readonly DeploymentLogEntry[];
}

export type ParticipantProblemView = Pick<
  DeploymentItem,
  "jobId" | "problemId" | "region" | "expiresAt" | "awsAccountId"
> & {
  readonly status: DeploymentStatus;
  /**
   * Issue #2233 (ADR-0001): この deployment の実行先 cloud provider。 AWS 以外は
   * Console / CLI federation の対象外 (= external-portal 導線、 ADR-0001 の matrix)。
   * DDB row は非 AWS runtime のときだけ `runtimeProvider` を持つ (deploy.ts) ため、
   * 欠損 = legacy / aws/cloudformation 経路 = "aws" に解決する。
   */
  readonly provider: "aws" | "sakura" | "azure" | "gcp";
  readonly stackOutputs: Record<string, string>;
  readonly failureReason?: string;
  readonly score: number;
  readonly lastScoredAt?: string;
  readonly lastResult?: "ok" | "fail";
  readonly posture?: Record<string, boolean>;
  readonly platform?: string;
  readonly scoring?: ParticipantScoringInfo;
  readonly deployLog: DeploymentLogView;
  /** ADR-012 Phase 4 / Issue #607: deploy 開始時刻 (= DDB.createdAt の echo)。 portal の phase
   *  countdown timeline (= metadata.phases[].afterMinutes の経過判定) に使う。 deploy 中の
   *  PENDING / IN_PROGRESS でも present (= job 生成時刻)。 */
  readonly createdAt?: string;
  /**
   * Battle (uptime kind) の集約 health。per-endpoint の URL / 名前は **絶対に出さない**
   * (ADR-005 D1)。Challenge 形式 (flag kind) では undefined。
   */
  readonly applicationStatus?: ApplicationStatus;
  // 設計判断: `endpointsHealth` (= どの endpoint が落ちているか) は participant API には
  // 出さない。Battle のゲーム性は「壊れている原因を防御側自身が調査して復旧する」点に
  // あり、画面で答え合わせをすると興ざめになる。露出するのは aggregate のみ。
  // `awsAccountId` は AWS Console 直接アクセス (SSO Credentials) のため公開する。
  // AWS の account id は機密ではない (= IAM role 信頼ポリシーや CFn template にも露出する)。
};

export interface ParticipantTeamView {
  readonly team: {
    readonly teamName: string;
    readonly teamNameSetByCompetitor: boolean;
    /** Phase 1 以前に作られた deployment は持たない。 */
    readonly eventId?: string;
    readonly teamId?: string;
  };
  readonly problems: readonly ParticipantProblemView[];
  /**
   * Issue #1038 P0 #2: 競技開始前 / 終了 / 一時停止 の gate 状態。 frontend が
   * ProblemDetail page にロック画面を出すために使う (= competitor が競技開始前に問題詳細
   * や hints を覗き見るのを防ぐ)。
   *
   * - `{ kind: "ok" }` = gate 通過、 通常表示
   * - `{ kind: "scoring_not_started", startsAt? }` = 競技開始前、 ProblemDetail を隠す
   * - `{ kind: "scoring_ended", endsAt? }` = 競技終了後、 ProblemDetail は閲覧可能だが
   *   提出 / hint reveal は backend gate で reject される (= 既存挙動と同等)
   * - `{ kind: "scoring_locked" }` = 一時 lock、 提出 / hint reveal は同様に reject
   *
   * eventId 不在 / gate 取得失敗時は **fail-closed** で scoring_not_started 扱い
   * (= 安全側に倒す)。
   */
  readonly eventGate?: GateBlock | { readonly kind: "ok" };
}

/**
 * 1 deployment row → ParticipantProblemView 変換。
 *
 * status が DELETING / DELETED の場合は `undefined` を返す。これは sparse 化が
 * 崩れた行 (GSI2PK が残ったまま teardown が進んだケース) への防御。
 *
 * `scoringMap` から該当 problemId の scoring 設定を引き、participant 側に出してよい
 * 情報だけ (= flagOutputKey の値は出さない、kind / points / hints のみ) を含める。
 * stackOutputs からも flagOutputKey フィールドは strip し、答えが見えないようにする。
 */
/**
 * stackOutputs から「答え」になる flagOutputKey を strip する (= 競技者に出さない)。
 *   - flag       : 単一 flagOutputKey を削除
 *   - multi-flag : 全 sub-flag の flagOutputKey を削除 (Issue #1796。 1 つでも露出させない)
 *   - その他     : 何もしない (= uptime 系等は flagOutputKey を持たない)
 */
function stripAnswerOutputs(
  stackOutputs: Record<string, string>,
  scoring: ProblemScoringMetadata | undefined,
): Record<string, string> {
  if (scoring?.kind === "flag") {
    delete stackOutputs[scoring.flagOutputKey];
  } else if (scoring?.kind === "multi-flag") {
    for (const f of scoring.flags) {
      delete stackOutputs[f.flagOutputKey];
    }
  }
  return stackOutputs;
}

const NON_AWS_PROVIDERS = new Set(["sakura", "azure", "gcp"] as const);

/**
 * Issue #2233: DeploymentItem.runtimeProvider (= 非 AWS runtime のときだけ永続化、 deploy.ts)
 * から参加者向け provider を解決する。 欠損 / 未知値は "aws" (= legacy 互換 + composite は
 * ADR-048 の aws-access-bridge 経由で AWS 導線が正)。
 */
function resolveProblemProvider(item: Partial<DeploymentItem>): "aws" | "sakura" | "azure" | "gcp" {
  const raw = item.runtimeProvider;
  if (typeof raw === "string" && (NON_AWS_PROVIDERS as ReadonlySet<string>).has(raw)) {
    return raw as "sakura" | "azure" | "gcp";
  }
  return "aws";
}

export function toProblemView(
  item: Partial<DeploymentItem>,
  scoringMap: Record<string, ProblemScoringMetadata> = {},
): ParticipantProblemView | undefined {
  const status = (item.status ?? "PENDING") as DeploymentStatus;
  if (DELETED_LIKE_STATUSES.has(status)) return undefined;

  const scoring = item.problemId ? scoringMap[item.problemId] : undefined;
  const stackOutputs = stripAnswerOutputs(parseStackOutputs(item.stackOutputs), scoring);

  return {
    jobId: String(item.jobId ?? ""),
    problemId: String(item.problemId ?? ""),
    region: String(item.region ?? ""),
    awsAccountId: String(item.awsAccountId ?? ""),
    status,
    provider: resolveProblemProvider(item),
    stackOutputs,
    failureReason: status === "FAILED" ? item.failureReason : undefined,
    expiresAt: Number(item.expiresAt ?? 0),
    score: Number(item.score ?? 0),
    lastScoredAt: typeof item.lastScoredAt === "string" ? item.lastScoredAt : undefined,
    lastResult: item.lastResult,
    posture: parsePostureSnapshot(item.posture),
    platform: typeof item.platform === "string" ? item.platform : undefined,
    scoring: scoring ? toScoringInfo(scoring, item) : undefined,
    deployLog: toDeploymentLog(item, status),
    // Issue #607: deploy 開始時刻 (DDB.createdAt) を echo。 portal の phase countdown が
    // metadata.phases[].afterMinutes との差で「+N 分まであと M 分」を計算する。
    createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
    // 全 uptime 系 (= legacy uptime + uptime-flat + uptime-multi + phased-polling) で
    // endpointsHealth aggregate を出す (ADR-005 D1: per-endpoint URL は隠す)。
    // attack-detection / flag では undefined (= probe しない kind)。
    applicationStatus: isUptimeKind(scoring?.kind) ? toApplicationStatus(item) : undefined,
  };
}

function parsePostureSnapshot(value: unknown): Record<string, boolean> | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const posture: Record<string, boolean> = {};
    for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof raw === "boolean") posture[key] = raw;
    }
    return Object.keys(posture).length > 0 ? posture : undefined;
  } catch {
    return undefined;
  }
}

function toDeploymentLog(
  item: Partial<DeploymentItem>,
  status: DeploymentStatus,
): DeploymentLogView {
  const createdAt = typeof item.createdAt === "string" ? item.createdAt : "";
  const updatedAt = typeof item.updatedAt === "string" ? item.updatedAt : createdAt;
  const hasBuildId = hasNonEmptyString(item.buildId);
  const hasStackId = hasNonEmptyString(item.stackId);
  const entries: DeploymentLogEntry[] = [];

  const push = (
    message: string,
    level: DeploymentLogEntry["level"] = "info",
    at: string | undefined = createdAt,
  ) => {
    entries.push({
      id: `${resolveLogTimestamp(at, updatedAt, createdAt)}:${entries.length}`,
      timestamp: resolveLogTimestamp(at, updatedAt, createdAt),
      source: "deployment",
      level,
      message,
    });
  };

  push("Deployment job was queued.", "info", createdAt);

  if (hasBuildId) {
    push("Build runner started.", "info", updatedAt);
  } else if (status === "PENDING") {
    push("Waiting for build runner.", "info", updatedAt);
  }

  if (hasStackId) {
    push(...describeStackLog(status), updatedAt);
  }

  if (status === "COMPLETE") {
    push("Deployment completed.", "success", updatedAt);
  } else if (status === "FAILED") {
    const reason =
      typeof item.failureReason === "string" && item.failureReason.length > 0
        ? `: ${item.failureReason}`
        : ".";
    push(`Deployment failed${reason}`, "error", updatedAt);
  } else if (status === "IN_PROGRESS") {
    push("Deployment is still running.", "info", updatedAt);
  }

  return {
    cursor: updatedAt || createdAt || status,
    entries,
  };
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function resolveLogTimestamp(
  value: string | undefined,
  updatedAt: string,
  createdAt: string,
): string {
  return value || updatedAt || createdAt;
}

function describeStackLog(status: DeploymentStatus): [string, DeploymentLogEntry["level"]] {
  if (status === "COMPLETE") return ["CloudFormation stack completed.", "success"];
  if (status === "FAILED") return ["CloudFormation reported a failure.", "error"];
  return ["CloudFormation stack creation is in progress.", "info"];
}

function isUptimeKind(kind: string | undefined): boolean {
  return (
    kind === "uptime" ||
    kind === "uptime-flat" ||
    kind === "uptime-multi" ||
    kind === "phased-polling"
  );
}

/**
 * Server-internal scoring metadata から participant 向け safe view を組み立てる。
 * 「答え」になる field (flagOutputKey 値 / statsOutputKey / platformRules の細部) は
 * 出さない。kind と配点ベースだけを露出する。
 */
function toScoringInfo(
  scoring: ProblemScoringMetadata,
  item: Partial<DeploymentItem>,
): ParticipantScoringInfo {
  if (scoring.kind === "flag") {
    // Issue #742 Phase 4: progressive hint view を組み立てる。 revealed=false な hint は
    // content を落として送る (= 答えを frontend に漏らさない)。 revealed=true は content +
    // revealedAt を含める。 reveal 状態は item.hintsRevealed (= Phase 2 で DDB に保存) から
    // 読む。
    const revealed = parseHintRevealedAttribute(item.hintsRevealed);
    const revealedMap = new Map(revealed.map((r) => [r.hintId, r] as const));
    const hintViews: ParticipantHintView[] | undefined = scoring.hints?.map((h) => {
      const r = revealedMap.get(h.id);
      if (r) {
        return {
          id: h.id,
          penalty: h.penalty,
          revealed: true,
          content: h.content,
          revealedAt: r.revealedAt,
        };
      }
      return { id: h.id, penalty: h.penalty, revealed: false };
    });
    return {
      kind: "flag",
      points: scoring.points,
      ...(hintViews ? { hints: hintViews } : {}),
      flagSubmitted: item.flagSubmitted === true,
    };
  }
  if (scoring.kind === "multi-flag") {
    // Issue #1796: 各 sub-flag を { id, label, points, solved } で出す。 solved は team の
    // solvedFlagIds (= String Set) に id が含まれるかで判定。 points は全 sub-flag の合計を
    // 問題の満点として返す (= 部分点の母数)。
    // per-flag hints は本 Phase では portal に露出しない (= 後続課題。 reveal-hint も multi-flag を
    // not_flag_problem として reject し続ける)。
    const solved = getSolvedFlagIds(item);
    return {
      kind: "multi-flag",
      points: scoring.flags.reduce((sum, f) => sum + f.points, 0),
      flags: scoring.flags.map((f) => ({
        id: f.id,
        label: f.label,
        points: f.points,
        solved: solved.has(f.id),
      })),
    };
  }
  if (scoring.kind === "uptime" || scoring.kind === "uptime-flat") {
    // 旧 view (legacy "uptime") との互換のため、metadata で書かれた kind 値をそのまま返す。
    // 現行 frontend は `kind === "uptime"` を Battle 判定の signal に使うので、新規問題が
    // `uptime-flat` を書いた場合だけ新名で露出する。
    return { kind: scoring.kind, pointsPerSuccess: scoring.pointsPerSuccess };
  }
  if (scoring.kind === "uptime-multi") {
    return { kind: "uptime-multi", pointsAllOk: scoring.pointsAllOk };
  }
  if (scoring.kind === "phased-polling") {
    // platformRules / phases の細部は出さない。最大配点だけ参考値で出す。
    const points = Math.max(...Object.values(scoring.platformRules).map((r) => r.points));
    return { kind: "phased-polling", pointsPerSuccess: points };
  }
  if (scoring.kind === "attack-detection") {
    return { kind: "attack-detection", pointsPerAttack: scoring.pointsPerAttack };
  }
  // unreachable: 5 kind を全網羅。
  return { kind: scoring.kind } as never;
}

/**
 * `endpointsHealth` JSON を aggregate (overall / healthyCount / totalCount / checkedAt)
 * に変換する。**per-endpoint URL / 名前は絶対に出さない** (ADR-005 D1)。
 *
 * 判定ルール:
 *   - probe 未実行 (= endpointsHealth が無い / 空) → `unknown`
 *   - 全 endpoint OK → `healthy`
 *   - 全 endpoint NG → `down`
 *   - 一部 OK → `degraded`
 */
function toApplicationStatus(item: Partial<DeploymentItem>): ApplicationStatus {
  const health = parseEndpointsHealth(item.endpointsHealth);
  const entries = Object.values(health);
  if (entries.length === 0) {
    return { overall: "unknown", healthyCount: 0, totalCount: 0 };
  }
  const healthyCount = entries.filter((e) => e.ok).length;
  const totalCount = entries.length;
  const checkedAt = entries[0]?.checkedAt;
  let overall: ApplicationStatusOverall;
  if (healthyCount === totalCount) overall = "healthy";
  else if (healthyCount === 0) overall = "down";
  else overall = "degraded";
  return checkedAt
    ? { overall, healthyCount, totalCount, checkedAt }
    : { overall, healthyCount, totalCount };
}

/**
 * teamLoginKey で GSI2 を Query して team の全 deployment 行を返し、team 集約 view を作る。
 *
 * - 該当行が無い (key 不正 / GSI2PK 属性が削除された) → undefined (401 相当)
 * - 全行が DELETING / DELETED → undefined (sparse 化が崩れた場合の防御)
 * - 1 つでも live な行があれば team view を返す
 *
 * GSI2 は eventually consistent。直近に rotate / 削除された teamLoginKey は最大
 * 数百ms 程度認証が通る可能性があるが、TTL ベースの teardown と整合する許容範囲。
 *
 * Issue #1038 P0 #2: team view に **eventGate** (= 競技開始前 / 終了 / 一時停止 の judge)
 * を含める。 frontend が ProblemDetail page にロック画面を出すために使う (= competitor が
 * 競技開始前に問題詳細 / hints を覗き見るのを防ぐ)。 gate 取得 fail (= eventId 不在 /
 * IAM 失敗) は fail-closed で `kind: "scoring_not_started"` 扱い (= 安全側に倒す)。
 */
export async function lookupTeamByLoginKey(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
): Promise<ParticipantTeamView | undefined> {
  const items = await queryTeamItems(shared, teamLoginKey);
  const view = buildTeamView(items, shared.problemsScoring);
  if (!view) return undefined;

  // eventGate を取得して team view に注入。 eventId 不在は gate 不明 → fail-closed。
  const eventId = view.team.eventId;
  if (eventId) {
    const gate = await getEventGate(shared, eventId);
    const block = evaluateGate(gate, Date.now());
    return { ...view, eventGate: block ?? { kind: "ok" } };
  }
  return { ...view, eventGate: { kind: "scoring_not_started" } };
}

/**
 * 既に Query 済みの items から ParticipantTeamView を組み立てる (1 pass)。
 * lookup と update (Update 後の ALL_NEW Attributes 集合) の両方が利用する。
 */
export function buildTeamView(
  items: readonly Partial<DeploymentItem>[],
  scoringMap: Record<string, ProblemScoringMetadata>,
): ParticipantTeamView | undefined {
  if (items.length === 0) return undefined;

  const problems = items
    .map((item) => toProblemView(item, scoringMap))
    .filter((view): view is ParticipantProblemView => view !== undefined);
  const sample = findLiveTeamSample(items);
  if (!sample || problems.length === 0) return undefined;

  const operatorSlug = String(sample.teamName ?? "");
  const display = typeof sample.displayTeamName === "string" ? sample.displayTeamName : undefined;

  return {
    team: {
      teamName: display ?? operatorSlug,
      teamNameSetByCompetitor: display !== undefined,
      eventId: typeof sample.eventId === "string" ? sample.eventId : undefined,
      teamId: typeof sample.teamId === "string" ? sample.teamId : undefined,
    },
    problems,
  };
}

function findLiveTeamSample(
  items: readonly Partial<DeploymentItem>[],
): Partial<DeploymentItem> | undefined {
  return items.find((item) => {
    const status = (item.status ?? "PENDING") as DeploymentStatus;
    return !DELETED_LIKE_STATUSES.has(status);
  });
}
