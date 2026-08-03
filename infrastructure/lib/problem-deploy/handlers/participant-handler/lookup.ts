import type {
  ApplicationStatus,
  ApplicationStatusOverall,
  DeploymentLogEntry,
  DeploymentLogView,
  ParticipantHintView,
  ParticipantScoringInfo,
  ParticipantTeamView,
  ParticipantProblemView as PortalParticipantProblemView,
  TargetAccessCapability,
} from "@tenkacloud/portal-contracts";
import type { ProblemScoringMetadata } from "../../../utils/scoring-metadata.js";
import { resolveTargetAccessCapability } from "../deploy-handler/composite-target-access.js";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { parseAttackProbeStatus } from "../shared/attack-probe-status.js";
import { parseStackOutputs } from "../shared/cfn-status.js";
import { DELETED_LIKE_STATUSES } from "../shared/constants.js";
import { parseEndpointsHealth } from "../shared/endpoints-health.js";
import { parseHintRevealedAttribute } from "../shared/hint-reveal.js";
import { decorateTeamView } from "./challenge-access.js";
import { warnLoginUnauthorized } from "./login-diagnostics.js";
import { type ParticipantSharedResources, queryTeamItems } from "./shared.js";
import { getSolvedFlagIds } from "./submit-flag.js";

/**
 * 1 teamLoginKey = 1 team (= N deployments) として view を構成する。
 *
 * stackOutputs は DDB に JSON 文字列で入っているが、UI に返す前に object へ展開する。
 * `flagOutputKey` で指定された field は **競技者に出さない** (= 当てる対象なので)。
 */

/**
 * Issue #2203: participant 系 view 型の定義正本は `@tenkacloud/portal-contracts` に移設した
 * (= SPA `portal-client` と同一定義を共有し、 field 追加の無音ドリフト (#2198) を typecheck で
 * 検出する)。 本 module は既存 caller (routes / tests) 向けに re-export し、 backend が必ず
 * 埋める field だけ下の intersection で optionality を tighten する。
 */
export type { ParticipantTeamView } from "@tenkacloud/portal-contracts";

/**
 * backend が構成する 1 problem view。 wire contract 上は旧 backend 互換のため optional な
 * `provider` / `accessCapabilities` を、 現行 backend は常に返すので required に tighten する
 * (= 定義の重複ではなく optionality の絞り込み。 shape の正本は contract 側)。
 *
 * `awsAccountId` は AWS Console 直接アクセス (SSO Credentials) のため公開する。 AWS の
 * account id は機密ではない (= IAM role 信頼ポリシーや CFn template にも露出する)。
 * `endpointsHealth` (per-endpoint の生死) を出さない設計判断は contract 側の docblock を参照。
 */
export type ParticipantProblemView = PortalParticipantProblemView & {
  /**
   * [#2233] 行契約 (deploy-handler/types.ts): runtimeProvider 欠落 = aws/cloudformation
   * (legacy 互換)。 未知の格納値は raw のまま返す (= 誤って aws 扱いにしない)。
   */
  readonly provider: string;
  /**
   * [#2235 / ADR-0001·ADR-048] provider の純関数。 matrix の正本は composite-target-access.ts。
   */
  readonly accessCapabilities: readonly TargetAccessCapability[];
};

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

/**
 * [#2233] 行の runtimeProvider から participant へ出す provider を解決する。
 * 行契約 (deploy-handler/types.ts): 欠落 / 空 = aws/cloudformation (legacy 行 / bulk-deploy 行)。
 * 未知の格納値は raw で通す (= mislabel しない)。composite target 行は常に明示値を持つ。
 */
function resolveViewProvider(runtimeProvider: unknown): string {
  return typeof runtimeProvider === "string" && runtimeProvider !== "" ? runtimeProvider : "aws";
}

export function toProblemView(
  item: Partial<DeploymentItem>,
  scoringMap: Record<string, ProblemScoringMetadata> = {},
): ParticipantProblemView | undefined {
  const status = (item.status ?? "PENDING") as DeploymentStatus;
  if (DELETED_LIKE_STATUSES.has(status)) return undefined;

  const scoring = item.problemId ? scoringMap[item.problemId] : undefined;
  const stackOutputs = stripAnswerOutputs(parseStackOutputs(item.stackOutputs), scoring);
  const provider = resolveViewProvider(item.runtimeProvider);

  return {
    jobId: String(item.jobId ?? ""),
    problemId: String(item.problemId ?? ""),
    region: String(item.region ?? ""),
    awsAccountId: String(item.awsAccountId ?? ""),
    provider,
    // [#2235] ADR-0001/048 の matrix を composite-target-access の resolver で解決する
    // (= view 側に別 matrix を持たせず drift を防ぐ)。
    accessCapabilities: resolveTargetAccessCapability(provider, status),
    status,
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
    // [#2422] uptime-multi の attack-probe 結果 (= 「green なのに満点でない理由」)。 attackProbes
    // を持つ問題でのみ行に present。 snapshot は非スポイラー (label/symptom/outcome/penalty のみ、
    // slot/path は含まない) なので、 kind 判定なしで present のときそのまま露出できる。
    attackProbeStatus: parseAttackProbeStatus(item.attackProbes),
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
      // 順序ゲートを外す flat モードの問題だけ hintReveal を露出する (= 既定 sequential は
      // 送らず、 既存問題の view を不変に保つ)。 frontend HintsPanel がこれを見て lock を外す。
      ...(scoring.hintReveal ? { hintReveal: scoring.hintReveal } : {}),
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
  if (!view) {
    // Issue #2675: emit a server-side triage line before the opaque 401. The HTTP
    // response is unchanged (still undefined → `unauthorized`); only the reason and
    // a non-reversible key fingerprint are logged, never the plaintext key.
    warnLoginUnauthorized(teamLoginKey, items);
    return undefined;
  }

  // eventGate + progression (Issue #2283) の注入と locked 問題の stackOutputs 空化は
  // decorateTeamView に集約 (= PATCH /portal/me 応答と同じ経路)。 eventId 不在は
  // gate 不明 → fail-closed (scoring_not_started)。
  return decorateTeamView(shared, items, view);
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
