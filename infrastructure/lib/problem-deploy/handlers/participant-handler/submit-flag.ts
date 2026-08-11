import type { SubmitFlagOutcome as SubmitFlagWireOutcome } from "@tenkacloud/portal-contracts";
import type {
  FlagScoringMetadata,
  MultiFlagEntry,
  ProblemScoringMetadata,
} from "../../../utils/scoring-metadata.js";
import type { DeploymentsScoringPort } from "../../control-data/deployments-repository.js";
import type { DeploymentItem } from "../deploy-handler/types.js";
import { flagMatches } from "../generic-scoring-handler/kinds/flag.js";
import { parseStackOutputs } from "../shared/cfn-status.js";
import { buildScoreEventRecord } from "../shared/score-event.js";
import { getCompetitionAccessBlock } from "./challenge-access.js";
import {
  type ParticipantSharedResources,
  queryTeamItems,
  resolveDeploymentsRepository,
} from "./shared.js";

/**
 * Issue #2203: HTTP 200 で返る wire 応答 (ok / already_scored / wrong) の定義正本は
 * `@tenkacloud/portal-contracts` の `SubmitFlagOutcome` (= SPA portal-client と共有)。
 * 以下は HTTP status へ map される backend 内部 outcome を union で足したもの。
 */
export type SubmitFlagOutcome =
  | SubmitFlagWireOutcome
  | { kind: "not_flag_problem" }
  /**
   * Issue #1796: multi-flag で flagId が指定されていない / metadata の flags[] に存在しない id。
   * 単一 flag kind は flagId を無視するのでこの outcome は返さない。
   */
  | { kind: "unknown_flag" }
  | { kind: "no_outputs" }
  | { kind: "scoring_locked" }
  /**
   * Issue #13 / scoring gate: 競技が開始前 (= Event.startsAt 未設定 / now < startsAt) または
   * 終了後 (= now > endsAt) / status=ENDED|ARCHIVED の状態で flag 提出を受けない。
   * 旧コードはこの gate が欠落しており、 deploy 直後から flag 提出で得点が入っていた (= JAM/GameDay
   * 前提違反、 大会の公平性を完全に壊す)。
   */
  | { kind: "scoring_not_started"; startsAt?: string }
  | { kind: "scoring_ended"; endsAt?: string }
  /**
   * Issue #2283: Progression Gate 未完了。 locked challenge への flag 提出を server-side で
   * 拒否する (= UI 改ざん / API 直呼びで bypass 不可)。 `gateProblemId` は先に完了すべき
   * Gate challenge。
   */
  | { kind: "challenge_prerequisite_not_met"; gateProblemId: string }
  | { kind: "unauthorized" };

/**
 * teamLoginKey で team の全 deployment 行を引き、`problemId` 一致する行に対し flag を
 * 採点する。正解なら `ADD score :pts` + `SET flagSubmitted = true` を 1 UpdateItem
 * で atomic に行う (Phase 2c: team scope なので problemId 引数が必須)。
 *
 * - team scope に該当行が無い (key 不正) は `unauthorized`
 * - team に該当 problemId が無い (= 違う event の問題を指定) は `unauthorized`
 *   (= problem の存在を漏らさない)
 * - kind=flag / multi-flag 以外の問題は `not_flag_problem`
 * - stackOutputs に flagOutputKey が無い (= deploy 未完了等) は `no_outputs`
 * - 既に flagSubmitted=true なら `already_scored` (= 重複加算しない)
 *
 * Issue #1796: multi-flag では `flagId` でどの sub-flag への提出かを受け取り、その flag の
 * flagOutputKey と照合する (= 単一 flag kind は flagId を無視して従来挙動を保つ)。 解済 flag は
 * `solvedFlagIds` (String Set) に蓄積し、 flag ごとに 1 回だけ加点する (= 冪等)。
 */
export async function submitFlag(
  shared: ParticipantSharedResources,
  scoringMap: Record<string, ProblemScoringMetadata>,
  teamLoginKey: string,
  problemId: string,
  submittedFlag: string,
  flagId?: string,
): Promise<SubmitFlagOutcome> {
  const items = await queryTeamItems(shared, teamLoginKey);
  if (items.length === 0) return { kind: "unauthorized" };

  const item = items.find((i) => i.problemId === problemId);
  if (!isSubmitFlagItem(item)) return { kind: "unauthorized" };

  // Issue #13 / scoring gate + Issue #2283 / Progression Gate: 競技開始前 / 終了後 / lock 中 /
  // 前提問題未完了は加点経路を返さない (= 提出履歴は残さず、 該当 outcome を UI に伝える)。
  // Event GET は 1 RCU、 submit-flag は per-attempt の rare path なので read-through で十分。
  // 判定は reveal-hint と共通の getCompetitionAccessBlock に集約 (= 片側だけ条件が増える drift 防止)。
  const blocked = await getCompetitionAccessBlock(shared, items, item);
  if (blocked) return blocked;

  const scoring = scoringMap[item.problemId];
  // Issue #1796: multi-flag は gate を通過した後の照合経路だけが分岐する (= gate / 認可は共通)。
  if (scoring?.kind === "multi-flag") {
    return submitMultiFlag(shared, item, scoring.flags, submittedFlag, flagId);
  }
  if (scoring?.kind !== "flag") return { kind: "not_flag_problem" };

  if (item.flagSubmitted === true) {
    return { kind: "already_scored", totalScore: Number(item.score ?? 0) };
  }

  const outputs = parseStackOutputs(item.stackOutputs);
  const expected = outputs[scoring.flagOutputKey];
  if (typeof expected !== "string") return { kind: "no_outputs" };

  if (!flagMatches(submittedFlag, expected)) {
    return scoreWrongFlag(shared, item, scoring);
  }

  return scoreCorrectFlag(shared, item, scoring);
}

/**
 * Issue #1796: solvedFlagIds attribute を寛容に `ReadonlySet<string>` へ正規化する。
 *
 * lib-dynamodb は JS `Set<string>` ↔ DynamoDB String Set (SS) を marshal するので通常は Set で
 * 戻るが、 旧 SDK / 手書き row 由来の string[] や、 未設定 (undefined) も握れるようにする
 * (DB row drift / 移行期の防御層、 既存の分離契約と整合)。 lookup.ts も同 helper を再利用する。
 */
export function getSolvedFlagIds(item: Partial<DeploymentItem>): ReadonlySet<string> {
  const raw = (item as { solvedFlagIds?: unknown }).solvedFlagIds;
  if (raw instanceof Set) {
    return new Set(Array.from(raw, String));
  }
  if (Array.isArray(raw)) {
    return new Set(raw.filter((v): v is string => typeof v === "string"));
  }
  return new Set<string>();
}

/**
 * Issue #1796: multi-flag の照合 + 加点経路。 flagId で対象 sub-flag を引き、 その flagOutputKey の
 * stack output 値と `flagMatches` (= 定数時間比較を再利用) で照合する。 解済 flag は
 * `solvedFlagIds` (String Set) に蓄積し、 flag ごとに 1 回だけ加点する (= 冪等、 ConditionExpression で race を防ぐ)。
 */
async function submitMultiFlag(
  shared: ParticipantSharedResources,
  item: Partial<DeploymentItem> & { PK: string; problemId: string },
  flags: readonly MultiFlagEntry[],
  submittedFlag: string,
  flagId: string | undefined,
): Promise<SubmitFlagOutcome> {
  const entry = flagId ? flags.find((f) => f.id === flagId) : undefined;
  // flagId 未指定 / metadata の flags[] に無い id は unknown_flag (= 単一 flag kind の挙動とは別)。
  if (!entry || flagId === undefined) return { kind: "unknown_flag" };

  // 既に解済の flag は重複加算しない (= per-flag 冪等)。 totalScore は header の累計を返す。
  if (getSolvedFlagIds(item).has(entry.id)) {
    return { kind: "already_scored", totalScore: Number(item.score ?? 0) };
  }

  const outputs = parseStackOutputs(item.stackOutputs);
  const expected = outputs[entry.flagOutputKey];
  if (typeof expected !== "string") return { kind: "no_outputs" };

  if (!flagMatches(submittedFlag, expected)) {
    return scoreWrongMultiFlag(shared, item, entry);
  }
  return scoreCorrectMultiFlag(shared, item, entry);
}

async function scoreCorrectMultiFlag(
  shared: ParticipantSharedResources,
  item: Partial<DeploymentItem> & { PK: string; problemId: string },
  entry: MultiFlagEntry,
): Promise<SubmitFlagOutcome> {
  // solvedFlagIds に entry.id が未収録のときだけ ADD する (= 2 重加算をレースから守る)。
  const now = new Date().toISOString();
  const jobId = String(item.jobId ?? "");
  const repository: DeploymentsScoringPort = await resolveDeploymentsRepository(shared);
  const outcome = await repository.applyMultiFlagCorrectScore(jobId, entry.points, entry.id, now);
  // [Issue #2441 / Phase B2] `applyMultiFlagCorrectScore` folds the CCF into
  // `conflict` (no probe) instead of throwing.
  if (outcome.outcome !== "updated") {
    return { kind: "already_scored", totalScore: Number(item.score ?? 0) + entry.points };
  }
  const totalScore = Number(outcome.record?.score ?? Number(item.score ?? 0) + entry.points);
  // 加点成功時のみ score event 行を append (= 単一 flag kind と同じ「flag」source を踏襲)。
  if (item.jobId) await writeMultiFlagScoreEvent(shared, item, "flag", entry.points, now);
  return { kind: "ok", scoreDelta: entry.points, totalScore, flagId: entry.id };
}

async function scoreWrongMultiFlag(
  shared: ParticipantSharedResources,
  item: Partial<DeploymentItem> & { PK: string; problemId: string },
  entry: MultiFlagEntry,
): Promise<SubmitFlagOutcome> {
  const penalty = entry.wrongAnswerPenalty ?? 0;
  // penalty 無し (= 0 / 未設定) は単一 flag kind と同じ legacy wrong shape (= 加点経路を打たない)。
  if (penalty === 0) return legacyWrongFlagOutcome(item);
  const now = new Date().toISOString();
  const jobId = String(item.jobId ?? "");
  // 既に解済の flag は減点しない (= correct 経路と同じ not-already-solved condition)。
  // [Issue #2441 / Phase B2] `applyMultiFlagWrongPenalty` folds the CCF into
  // `conflict` (no probe) instead of throwing.
  const repository: DeploymentsScoringPort = await resolveDeploymentsRepository(shared);
  const outcome = await repository.applyMultiFlagWrongPenalty(jobId, penalty, entry.id, now);
  if (outcome.outcome !== "updated") {
    return { kind: "already_scored", totalScore: Number(item.score ?? 0) };
  }
  const rawScore = Number(outcome.record?.score ?? 0);
  if (item.jobId) await writeMultiFlagScoreEvent(shared, item, "flag-wrong", -penalty, now);
  return {
    kind: "wrong",
    scoreDelta: -penalty,
    totalScore: rawScore < 0 ? 0 : rawScore,
    wrongCount: Number(outcome.record?.wrongAnswerCount ?? 1),
  };
}

async function writeMultiFlagScoreEvent(
  shared: ParticipantSharedResources,
  item: Partial<DeploymentItem> & { problemId: string; jobId?: string },
  source: "flag" | "flag-wrong",
  points: number,
  occurredAt: string,
): Promise<void> {
  const repository: DeploymentsScoringPort = await resolveDeploymentsRepository(shared);
  await repository.appendScoreEvent(
    buildScoreEventRecord(
      {
        jobId: String(item.jobId ?? ""),
        problemId: item.problemId,
        teamId: item.teamId,
        eventId: item.eventId,
        expiresAt: item.expiresAt ?? 0,
      },
      source,
      points,
      occurredAt,
    ),
  );
}

function isSubmitFlagItem(
  item: Partial<DeploymentItem> | undefined,
): item is Partial<DeploymentItem> & { PK: string; problemId: string } {
  return typeof item?.PK === "string" && typeof item.problemId === "string";
}

async function scoreWrongFlag(
  shared: ParticipantSharedResources,
  item: Partial<DeploymentItem> & { PK: string; problemId: string },
  scoring: FlagScoringMetadata,
): Promise<SubmitFlagOutcome> {
  const penalty = scoring.wrongAnswerPenalty ?? 0;
  if (penalty === 0) return legacyWrongFlagOutcome(item);
  const wrongNow = new Date().toISOString();
  const jobId = String(item.jobId ?? "");
  // [Issue #2441 / Phase B2] `applyFlagWrongPenalty` folds the CCF into
  // `conflict` (no probe) instead of throwing.
  const repository: DeploymentsScoringPort = await resolveDeploymentsRepository(shared);
  const outcome = await repository.applyFlagWrongPenalty(jobId, penalty, wrongNow);
  if (outcome.outcome !== "updated") {
    return { kind: "already_scored", totalScore: Number(item.score ?? 0) };
  }
  const rawScore = Number(outcome.record?.score ?? 0);
  if (item.jobId) await writeFlagScoreEvent(shared, item, "flag-wrong", -penalty, wrongNow);
  return {
    kind: "wrong",
    scoreDelta: -penalty,
    totalScore: rawScore < 0 ? 0 : rawScore,
    wrongCount: Number(outcome.record?.wrongAnswerCount ?? 1),
  };
}

function legacyWrongFlagOutcome(item: Partial<DeploymentItem>): SubmitFlagOutcome {
  return {
    kind: "wrong",
    scoreDelta: 0,
    totalScore: Math.max(0, Number(item.score ?? 0)),
    wrongCount: Number(item.wrongAnswerCount ?? 0),
  };
}

async function scoreCorrectFlag(
  shared: ParticipantSharedResources,
  item: Partial<DeploymentItem> & { PK: string; problemId: string },
  scoring: FlagScoringMetadata,
): Promise<SubmitFlagOutcome> {
  // ConditionExpression で flagSubmitted=true への 2 重加算を防ぐ。レース勝者だけが加点される。
  const now = new Date().toISOString();
  const jobId = String(item.jobId ?? "");
  // [Issue #2441 / Phase B2] `applyFlagCorrectScore` folds the CCF into
  // `conflict` (no probe) instead of throwing.
  const repository: DeploymentsScoringPort = await resolveDeploymentsRepository(shared);
  const outcome = await repository.applyFlagCorrectScore(jobId, scoring.points, now);
  if (outcome.outcome !== "updated") {
    return { kind: "already_scored", totalScore: Number(item.score ?? 0) + scoring.points };
  }
  const totalScore = Number(outcome.record?.score ?? scoring.points);

  // 加点成功時のみ score event 行を append。失敗 (= already_scored の race) では
  // 既存の event 行が記録済みなので二重に書かない。
  // #745: 旧実装は Put 失敗を console.warn で握り潰していたが、 score events 履歴が空のまま
  // header の score だけ加点される矛盾を生んだ (= IAM 不足で silent skip)。 AGENTS.md
  // 「モック / スタブで握り潰す fallback 禁止」 違反だったので、 失敗は throw して
  // route-helpers の internal_error 経路で 500 を返す。
  if (item.jobId) await writeFlagScoreEvent(shared, item, "flag", scoring.points, now);

  return { kind: "ok", scoreDelta: scoring.points, totalScore };
}

async function writeFlagScoreEvent(
  shared: ParticipantSharedResources,
  item: Partial<DeploymentItem> & { problemId: string; jobId?: string },
  source: "flag" | "flag-wrong",
  points: number,
  occurredAt: string,
): Promise<void> {
  const repository: DeploymentsScoringPort = await resolveDeploymentsRepository(shared);
  await repository.appendScoreEvent(
    buildScoreEventRecord(
      {
        jobId: String(item.jobId ?? ""),
        problemId: item.problemId,
        teamId: item.teamId,
        eventId: item.eventId,
        expiresAt: item.expiresAt ?? 0,
      },
      source,
      points,
      occurredAt,
    ),
  );
}
