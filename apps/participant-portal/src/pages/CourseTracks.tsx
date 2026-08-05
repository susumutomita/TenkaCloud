/**
 * Issue #2786: 講座 track の参加者向け画面。
 *
 * 問題一覧 (`/problems`) は「自チームに deploy された問題のカタログ」で、順序を持たない。
 * 7 週間の講座を並べても、参加者には単発問題の集合にしか見えない。この画面は同じ問題を
 * **週・章の順序と前提関係つき**で見せる。
 *
 * 表示は metadata から組み立てる (= 固定ページに hard-code しない)。track を宣言しない
 * 既存問題は 1 件も現れず、`/problems` 側の挙動は変わらない。
 *
 * 未達成の前提があっても **lock はしない**。推奨順から外し、何が足りないかを書くだけである。
 * 前提判定は catalog の bug (cycle / 欠損) で `unknown` に倒れることがあり、それで進行不能に
 * なるのは participant の落ち度ではない。
 */

import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import ProgressBar from "@cloudscape-design/components/progress-bar";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useMemo } from "react";
import { useNavigate } from "react-router";
import { useTeamView } from "../auth/TeamViewProvider";
import {
  buildCourseTracks,
  type CourseProblemView,
  type CourseTrackView,
  toProblemProgress,
} from "../data/course-track";
import { listProblemCatalog } from "../data/problems";
import { useT } from "../i18n";

/** role → i18n key。未知の role は素の文字列を出す (= 新しい role で画面が壊れない)。 */
const ROLE_KEYS: Readonly<Record<string, string>> = {
  diagnostic: "course_track.role_diagnostic",
  mechanism: "course_track.role_mechanism",
  "assignment-companion": "course_track.role_assignment_companion",
  transfer: "course_track.role_transfer",
  synthesis: "course_track.role_synthesis",
};

function ProblemRow({
  problem,
  recommended,
  onOpen,
  t,
}: {
  readonly problem: CourseProblemView;
  readonly recommended: boolean;
  readonly onOpen: (problemId: string) => void;
  readonly t: (key: string, params?: Readonly<Record<string, string | number>>) => string;
}) {
  const roleKey = problem.role === undefined ? undefined : ROLE_KEYS[problem.role];
  return (
    <Box padding={{ vertical: "xs" }} data-testid={`course-problem-${problem.problemId}`}>
      <SpaceBetween size="xxs">
        <SpaceBetween size="xs" direction="horizontal">
          <Link
            href={`/problems/${encodeURIComponent(problem.problemId)}`}
            onFollow={(event) => {
              event.preventDefault();
              onOpen(problem.problemId);
            }}
          >
            {problem.name}
          </Link>
          {problem.progress.solved ? <Badge color="green">{t("course_track.solved")}</Badge> : null}
          {recommended ? <Badge color="blue">{t("course_track.recommended")}</Badge> : null}
          {roleKey ? <Badge>{t(roleKey)}</Badge> : null}
          {roleKey === undefined && problem.role !== undefined ? (
            <Badge>{problem.role}</Badge>
          ) : null}
        </SpaceBetween>

        <Box variant="small" color="text-body-secondary">
          {t("course_track.problem_meta", {
            difficulty: problem.difficulty,
            duration: problem.estimatedDuration,
          })}
        </Box>

        {/* checkpoint を持つ問題だけ進捗バーを出す。 単一 flag は 0/0 なので出さない。 */}
        {problem.progress.totalCheckpoints > 0 ? (
          <ProgressBar
            value={(problem.progress.solvedCheckpoints / problem.progress.totalCheckpoints) * 100}
            additionalInfo={t("course_track.checkpoints", {
              solved: problem.progress.solvedCheckpoints,
              total: problem.progress.totalCheckpoints,
            })}
            variant="key-value"
            label={t("course_track.checkpoint_label")}
          />
        ) : null}

        {problem.prerequisiteState === "unmet" ? (
          <Box variant="small" color="text-status-warning">
            {t("course_track.prerequisite_unmet", {
              problems: problem.unmetPrerequisites.join(", "),
            })}
          </Box>
        ) : null}

        {problem.sources.length > 0 ? (
          <Box variant="small" color="text-body-secondary">
            {t("course_track.source_label")}{" "}
            {problem.sources.map((source) => (
              <Link
                key={`${source.repository}:${source.path}`}
                external
                href={`https://github.com/${source.repository}/blob/${source.ref}/${source.path}`}
              >
                {source.path}
              </Link>
            ))}
          </Box>
        ) : null}
      </SpaceBetween>
    </Box>
  );
}

export function CourseTrackCard({
  track,
  onOpen,
  t,
}: {
  readonly track: CourseTrackView;
  readonly onOpen: (problemId: string) => void;
  readonly t: (key: string, params?: Readonly<Record<string, string | number>>) => string;
}) {
  // 1 度だけ narrow して以降は non-optional として扱う (= 到達しない fallback を作らない)。
  const recommended = track.recommendedNext;
  return (
    <Container
      header={
        <Header
          variant="h2"
          description={t("course_track.track_progress", {
            solved: track.solvedProblems,
            total: track.totalProblems,
          })}
          actions={
            recommended ? (
              <Button variant="primary" onClick={() => onOpen(recommended.problemId)}>
                {t("course_track.start_recommended")}
              </Button>
            ) : undefined
          }
        >
          {track.trackId}
          {track.edition ? ` (${track.edition})` : ""}
        </Header>
      }
    >
      <SpaceBetween size="s">
        {recommended ? (
          <Alert type="info" data-testid="course-recommended">
            {t("course_track.recommended_next", { name: recommended.name })}
          </Alert>
        ) : (
          <Alert type="success" data-testid="course-complete">
            {t("course_track.all_done")}
          </Alert>
        )}

        {track.totalCheckpoints > 0 ? (
          <ProgressBar
            value={(track.solvedCheckpoints / track.totalCheckpoints) * 100}
            additionalInfo={t("course_track.checkpoints", {
              solved: track.solvedCheckpoints,
              total: track.totalCheckpoints,
            })}
            label={t("course_track.track_checkpoint_label")}
          />
        ) : null}

        {track.chapters.map((chapter, index) => (
          <ExpandableSection
            key={chapter.chapter}
            headerText={chapter.chapter}
            // 最初の章だけ開いておく。 7 週分すべて開くと画面が長すぎて現在地を見失う。
            defaultExpanded={index === 0}
          >
            <SpaceBetween size="xxs">
              {chapter.problems.map((problem) => (
                <ProblemRow
                  key={problem.problemId}
                  problem={problem}
                  recommended={recommended?.problemId === problem.problemId}
                  onOpen={onOpen}
                  t={t}
                />
              ))}
            </SpaceBetween>
          </ExpandableSection>
        ))}
      </SpaceBetween>
    </Container>
  );
}

export function CourseTracksPage() {
  const { view, error } = useTeamView();
  const navigate = useNavigate();
  const t = useT();

  const tracks = useMemo(
    () => buildCourseTracks(listProblemCatalog(), toProblemProgress(view?.problems ?? [])),
    [view],
  );

  // deploy された問題の jobId は問題 id と別なので、 catalog の problemId から引き直す。
  // 未 deploy の問題は開けないため、 一覧 (`/problems`) へ送る。
  const openProblem = (problemId: string) => {
    const deployed = (view?.problems ?? []).find((p) => p.problemId === problemId);
    navigate(deployed ? `/problems/${encodeURIComponent(deployed.jobId)}` : "/problems");
  };

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={t("course_track.header_description")}>
        {t("course_track.header")}
      </Header>

      {error ? (
        <Alert type="error" header={t("app.fetch_status_failed")}>
          {error}
        </Alert>
      ) : null}

      {tracks.length === 0 ? (
        <Alert type="info" data-testid="course-empty">
          {t("course_track.empty")}
        </Alert>
      ) : (
        tracks.map((track) => (
          <CourseTrackCard
            key={`${track.trackId}:${track.edition ?? ""}`}
            track={track}
            onOpen={openProblem}
            t={t}
          />
        ))
      )}
    </SpaceBetween>
  );
}
