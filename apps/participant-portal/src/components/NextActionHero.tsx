import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useNavigate } from "react-router";
import type {
  LeaderboardResponse,
  ParticipantProblemView,
  ParticipantTeamView,
} from "../api/portal-client";
import { useT } from "../i18n";
import { computeCountdownState } from "./CountdownTimer";

/**
 * Issue #1349: Home tab 上部に出す「次に何をすればよいか」 hero panel。
 *
 * 3 状態:
 *  - `not_started`: 競技開始前 (= eventGate.kind === "scoring_not_started")
 *      → 「競技開始まで残り X 分」 countdown
 *  - `ended`: 競技終了済 (= eventGate.kind === "scoring_ended" or endsAt 経過)
 *      → 「お疲れさまでした。 最終順位: 3 位」
 *  - `running`: 競技中 (= eventGate.kind === "ok" or undefined)
 *      → 未解答問題が N 件。 まず {problemId} を解く →  (= 直接 /problems/:jobId に飛ぶ)
 *
 * 設計判断: 戦術判断 (= どの問題を「次にやるべき」 と推奨するか) は pure function
 * `pickNextProblem` に分離して unit test 可能にする。 UI 側は state 文字列を組み立てて
 * Cloudscape Container で render するだけ。
 */

export type NextActionState =
  | { readonly kind: "not_started"; readonly startsAt?: string }
  | { readonly kind: "ended"; readonly finalRank?: number; readonly totalEntries?: number }
  | {
      readonly kind: "running";
      readonly unsolvedCount: number;
      readonly nextProblem?: ParticipantProblemView;
    }
  // all_cleared: 全 flag 問題を submit 済 (= Challenge 的な真の完了)。
  // defending: deploy 済み問題はすべて稼働中だが、 uptime 等の継続採点問題があるため
  //   「解き終わり」 は無く、 競技終了まで防衛を続ける (= Battle はまだ進行中)。
  | { readonly kind: "all_cleared" }
  | { readonly kind: "defending" };

/**
 * 「次にやるべき問題」 を選ぶ pure function。
 *
 * - status === "COMPLETE" でかつ未解答 (= flag 未提出 or uptime score 0) なものを優先
 * - その中でも 難易度が低い方 (= problemId の lexical order を tie-breaker に使う)
 * - 全 cleared なら undefined → caller 側で「all_cleared」 state に倒す
 */
export function isProblemUnsolved(p: ParticipantProblemView): boolean {
  if (p.status !== "COMPLETE" && p.status !== "IN_PROGRESS" && p.status !== "PENDING") return false;
  if (p.scoring?.kind === "flag") return p.scoring.flagSubmitted !== true;
  // [#2885] checkpoint 制は「全部出したか」で見る。 `score === 0` だけだと、 1 個でも通した
  // 時点で解答済扱いになり、 残り 4 個ある問題が「次にやること」から消える。
  const flags = p.scoring?.flags;
  if (flags && flags.length > 0) return !flags.every((flag) => flag.solved);
  return p.score === 0;
}

export function pickNextProblem(
  problems: readonly ParticipantProblemView[],
  preferredProblemId?: string,
): ParticipantProblemView | undefined {
  const unsolved = problems.filter(isProblemUnsolved);
  if (unsolved.length === 0) return undefined;
  // [#2882] 講座トラックを進めている人には、 トラックが決めた次の 1 問がある。 表示順の先頭は
  // カタログ全体の並びであって、 その人の学習順ではない (実際、 チュートリアルの途中で
  // 無関係な問題が「次にやること」に出た)。 トラックの推薦が未解答なら、 それを優先する。
  if (preferredProblemId !== undefined) {
    const preferred = unsolved.find((p) => p.problemId === preferredProblemId);
    if (preferred) return preferred;
  }
  // Issue #1349: COMPLETE (= deploy 完了済) を優先、 deploy 中はやることが無いので後ろ。
  const ready = unsolved.filter((p) => p.status === "COMPLETE");
  const pool = ready.length > 0 ? ready : unsolved;
  // #2711 follow-up: 以前は problemId の辞書順で選んでいたが、 オンボーディング導線では
  // 表示順 (= fixture / deploy が pin する journey order) が正であり、 辞書順だと
  // deploy-tenkacloud-lite がチュートリアルより先に出てしまう。 /start と同じく表示順の先頭。
  return pool[0];
}

export function computeNextActionState(args: {
  readonly view: ParticipantTeamView | null;
  readonly leaderboard: LeaderboardResponse | null;
  readonly nowMs: number;
  /** [#2882] 講座トラックが決めた次の 1 問。 未解答ならこれを優先する。 */
  readonly preferredNextProblemId?: string;
}): NextActionState | null {
  const { view, leaderboard, nowMs, preferredNextProblemId } = args;
  if (!view) return null;
  const gate = view.eventGate;
  if (gate?.kind === "scoring_not_started") {
    return { kind: "not_started", startsAt: gate.startsAt };
  }
  // endsAt 経過 (= timer 上は終了) も ended 扱い、 backend gate と独立に判定 (= 末端で
  // race condition を吸収)。
  const endsAt = leaderboard?.endsAt;
  const countdown = computeCountdownState(endsAt, nowMs);
  if (gate?.kind === "scoring_ended" || countdown.kind === "ended") {
    const myEntry = leaderboard?.entries.find((e) => e.isMyTeam);
    return {
      kind: "ended",
      finalRank: myEntry?.rank,
      totalEntries: leaderboard?.entries.length,
    };
  }
  const unsolved = view.problems.filter(isProblemUnsolved);
  if (unsolved.length === 0 && view.problems.length > 0) {
    // uptime / 継続採点問題は「解き終わる」概念が無く、 score>0 でも競技は続く。 全問題が flag
    // (= 一発 capture) で submit 済のときだけ真の完了 (all_cleared)。 継続採点問題が 1 つでもあれば
    // 競技継続中なので defending を出す (= 「全問クリア / 最終順位を待ちましょう」 の誤表示を防ぐ)。
    const allClearable = view.problems.every((p) => p.scoring?.kind === "flag");
    return allClearable ? { kind: "all_cleared" } : { kind: "defending" };
  }
  const next = pickNextProblem(view.problems, preferredNextProblemId);
  return { kind: "running", unsolvedCount: unsolved.length, nextProblem: next };
}

export function NextActionHero({
  view,
  leaderboard,
  preferredNextProblemId,
}: {
  view: ParticipantTeamView | null;
  leaderboard: LeaderboardResponse | null;
  /** [#2882] 講座トラックが決めた次の 1 問 (local のみ)。 */
  preferredNextProblemId?: string;
}) {
  const t = useT();
  const navigate = useNavigate();
  const state = computeNextActionState({
    view,
    leaderboard,
    nowMs: Date.now(),
    preferredNextProblemId,
  });
  if (!state) return null;

  if (state.kind === "not_started") {
    return (
      <Container
        header={
          <Header variant="h2" description={t("next_action.not_started_description")}>
            {t("next_action.not_started_header")}
          </Header>
        }
      >
        <Box variant="awsui-value-large" color="text-status-info">
          {state.startsAt
            ? t("next_action.not_started_starts_at", {
                startsAt: new Date(state.startsAt).toLocaleString(),
              })
            : t("next_action.not_started_unknown")}
        </Box>
      </Container>
    );
  }

  if (state.kind === "ended") {
    const rankLine =
      state.finalRank !== undefined && state.totalEntries !== undefined
        ? t("next_action.ended_with_rank", {
            rank: state.finalRank,
            total: state.totalEntries,
          })
        : t("next_action.ended_no_rank");
    return (
      <Container
        header={
          <Header variant="h2" description={t("next_action.ended_description")}>
            {t("next_action.ended_header")}
          </Header>
        }
      >
        <Box variant="awsui-value-large" color="text-status-success">
          {rankLine}
        </Box>
      </Container>
    );
  }

  if (state.kind === "all_cleared") {
    return (
      <Container
        header={
          <Header variant="h2" description={t("next_action.all_cleared_description")}>
            {t("next_action.all_cleared_header")}
          </Header>
        }
      >
        <Box variant="awsui-value-large" color="text-status-success">
          {t("next_action.all_cleared_body")}
        </Box>
      </Container>
    );
  }

  if (state.kind === "defending") {
    return (
      <Container
        header={
          <Header variant="h2" description={t("next_action.defending_description")}>
            {t("next_action.defending_header")}
          </Header>
        }
      >
        <Box variant="awsui-value-large" color="text-status-info">
          {t("next_action.defending_body")}
        </Box>
      </Container>
    );
  }

  // state.kind === "running"
  const nextProblem = state.nextProblem;
  return (
    <Container
      header={
        <Header
          variant="h2"
          description={t("next_action.running_description", { count: state.unsolvedCount })}
        >
          {t("next_action.running_header")}
        </Header>
      }
    >
      <SpaceBetween size="m">
        <Box variant="awsui-value-large" color="text-status-info">
          {nextProblem
            ? t("next_action.running_pick", { problemId: nextProblem.problemId })
            : t("next_action.running_no_ready")}
        </Box>
        {nextProblem && (
          <Button
            variant="primary"
            onClick={() => navigate(`/problems/${encodeURIComponent(nextProblem.jobId)}`)}
          >
            {t("next_action.running_open_button")}
          </Button>
        )}
      </SpaceBetween>
    </Container>
  );
}
