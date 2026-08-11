import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { Markdown } from "@tenkacloud/web-kit";
import { useMemo } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import type { ParticipantProblemView, ParticipantTeamView } from "../api/portal-client";
import { useAuth } from "../auth/AuthProvider";
import { useTeamView } from "../auth/TeamViewProvider";
import { EndpointOverrideForm } from "../components/EndpointOverrideForm";
import { ProblemPanel } from "../components/ProblemPanel";
import { localizeProblem } from "../components/ProblemPanel.helpers";
import { ProblemVideoSection } from "../components/ProblemVideoSection";
import type { AppConfig } from "../config";
import {
  findProblemDiagramUrl,
  findProblemMetadata,
  type ProblemCatalogEntry,
  resolveLocalizedNarrative,
} from "../data/problems";
import { providerLabel } from "../data/providers";
import { useProblemEndpoints } from "../hooks/useProblemEndpoints";
import { useI18n, useT } from "../i18n";
import {
  findGateProblem,
  hasGateCompletionBonus,
  isGateAwaitingCompletion,
  isPrerequisiteLocked,
} from "../lib/progression";
import { PortalPluginSlots } from "../plugins/PortalPluginSlots";

const DIFFICULTY_KEY: Record<ProblemCatalogEntry["difficulty"], string> = {
  1: "problem_detail.difficulty_1",
  2: "problem_detail.difficulty_2",
  3: "problem_detail.difficulty_3",
  4: "problem_detail.difficulty_4",
  5: "problem_detail.difficulty_5",
};

interface ProblemDetailGate {
  readonly kind: string;
}

interface ProblemDetailVisibilityState {
  readonly hasProblem: boolean;
  readonly locked: boolean;
}

interface EndpointOverrideVisibilityState extends ProblemDetailVisibilityState {
  readonly hasMetadata: boolean;
  readonly endpointCount: number;
}

function problemEndpointsRequest(
  config: AppConfig,
  sessionToken: string | null,
  problem: ParticipantProblemView | undefined,
  enabled: boolean,
) {
  return {
    apiBaseUrl: config.apiBaseUrl,
    teamLoginKey: sessionToken ?? "",
    problemId: problem?.problemId ?? "",
    enabled,
  };
}

function PlacedProblemVideo({ canRender, videoUrl }: { canRender: boolean; videoUrl?: string }) {
  if (!canRender || !videoUrl) return null;
  return <ProblemVideoSection videoUrl={videoUrl} />;
}

export function isProblemDetailLocked(eventGate: ProblemDetailGate | undefined): boolean {
  return eventGate?.kind === "scoring_not_started";
}

export function canRenderProblemDetailBody(state: ProblemDetailVisibilityState): boolean {
  return state.hasProblem && !state.locked;
}

export function canRenderEndpointOverride(state: EndpointOverrideVisibilityState): boolean {
  return canRenderProblemDetailBody(state) && state.hasMetadata && state.endpointCount > 0;
}

function getScoringNotStartedStartsAt(
  eventGate: ParticipantTeamView["eventGate"] | undefined,
): string | undefined {
  return eventGate?.kind === "scoring_not_started" ? eventGate.startsAt : undefined;
}

/**
 * 1 問題の詳細ページ。Quests から click で来る。`useTeamView()` の問題リストから
 * `:jobId` 一致する 1 件を見つけて `ProblemPanel` を 1 つだけ表示する。
 *
 * URL key は jobId (ULID) を採用。problemId (slug) は metadata 上 unique 前提だが、
 * 同名 problem の link 衝突を回避する防御。問題不在の場合は Alert で説明。
 */
export function ProblemDetailPage({ config }: { config: AppConfig }) {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const auth = useAuth();
  const t = useT();
  const sessionToken = auth.session?.sessionToken ?? null;
  const { view, error, refresh } = useTeamView();
  // Issue #583 Phase 5.B: locale に応じて metadata.i18n[locale] override を被せる。
  // hooks-rule のため early return より前で hook を呼ぶ (= jobId 不在でも順序が変わらない)。
  const { locale } = useI18n();
  const problem = view?.problems.find((p) => p.jobId === jobId);
  const localizedProblem = useMemo(
    () => (problem ? localizeProblem(problem, locale) : undefined),
    [problem, locale],
  );
  // #550: problem.problemId から build-time catalog で metadata を引いて narrative を表示。
  // backend を経由せず Portal が metadata.json を bundle に持つ (admin-console と同じ source)。
  // catalog 不在 (= 旧 problem 等) は undefined。
  const metadata = problem ? findProblemMetadata(problem.problemId) : undefined;
  // ja / metadata.i18n 不在 / 該当 field 不在は元の ja narrative にフォールバック (helper 側で処理)。
  const narrative = useMemo(
    () => (metadata ? resolveLocalizedNarrative(metadata, locale) : undefined),
    [metadata, locale],
  );
  const locked = isProblemDetailLocked(view?.eventGate);
  // Issue #2283: Progression Gate。 event gate (scoring_not_started) と同じ方針で
  // prerequisite-locked 問題も body / flag 提出 / endpoint form を render しない。
  // 実際の拒否は backend の 409 guard — ここは UX (先回り lock 表示)。
  const prereqLocked = isPrerequisiteLocked(view?.progression, problem?.problemId);
  const gatePending = isGateAwaitingCompletion(view?.progression, problem?.problemId);
  // #2283: 完了 bonus の予告は locked の有無と無関係 (policy "off" の team は何も locked
  // されないが完了 bonus は付く)。 gatePending の unlock hint とは別軸で判定する。
  const bonusPending = hasGateCompletionBonus(view?.progression, problem?.problemId);
  const gateProblem = findGateProblem(view?.progression, view?.problems);
  // #2283: 表示名は既に引いた gateProblem から導出する (gateProblemDisplayName を呼ぶと
  // view.problems を二重走査するだけ)。 fallback は problemId slug (= 同 helper と同じ規約)。
  const gateName = gateProblem?.name ?? view?.progression?.gateProblemId ?? "";
  const anyLocked = locked || prereqLocked;
  const canRenderBody = canRenderProblemDetailBody({ hasProblem: !!problem, locked: anyLocked });
  const canRenderEndpoints = canRenderEndpointOverride({
    hasProblem: !!problem,
    hasMetadata: !!metadata,
    endpointCount: metadata?.endpoints.length ?? 0,
    locked: anyLocked,
  });
  const endpointRegistry = useProblemEndpoints(
    problemEndpointsRequest(config, sessionToken, problem, canRenderEndpoints),
  );
  const scoringNotStartedAt = getScoringNotStartedStartsAt(view?.eventGate);
  // [Challenge #402] deploy が見つからないとき、それが「まだ deploy していない」のか
  // 「そもそも local play では起動できない AWS 専用問題」なのかを区別する。後者は
  // `local/` を持たない問題で、local play の jobId は `local-<problemId>` (api-state.ts の
  // `jobIdOf`) なので、問題が見つからなくても catalog を引ける。
  // `localPlayable !== false` で判定する — `undefined` は「判定していない」(AWS mode の
  // 投影は `local/` を見られない) であって「起動できない」ではない。
  const awsOnly = useMemo(() => {
    if (problem || config.cloudMode !== "local" || !jobId) return false;
    const problemId = jobId.startsWith("local-") ? jobId.slice("local-".length) : jobId;
    return findProblemMetadata(problemId)?.localPlayable === false;
  }, [problem, config.cloudMode, jobId]);

  if (!jobId) return <Navigate to="/problems" replace />;

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={narrative?.shortDescription}
        actions={
          <Button onClick={() => navigate("/problems")}>{t("problem_detail.back_button")}</Button>
        }
      >
        {narrative?.name ?? localizedProblem?.name ?? problem?.problemId ?? jobId}
      </Header>

      {/* Issue #1038 P0 #2: 競技開始前は問題詳細 / hints へのアクセスを **完全に lock**。
       *   backend (= participant-handler) から eventGate が scoring_not_started で返ってきた
       *   とき、 problem detail の代わりに lock screen を表示する。 backend 側で fail-closed
       *   が担保されているため、 eventId 不在 / gate 取得失敗時も同じく lock 表示になる。
       *   競技公平性 (= 開始前に hints / 問題文を読んで準備するのを防ぐ) のため必須。 */}
      <ProblemDetailStatusAlerts
        awsOnly={awsOnly}
        error={error}
        bonusPending={bonusPending}
        gateName={gateName}
        gatePending={gatePending}
        gateProblem={gateProblem}
        jobId={jobId}
        locked={locked}
        onNavigate={navigate}
        prereqLocked={prereqLocked}
        problem={problem}
        progression={view?.progression}
        scoringNotStartedAt={scoringNotStartedAt}
        t={t}
        view={view}
      />

      {/* #2707 P0-1: 冒頭の短い operation 動画。 videoUrl を持つ問題のみ。
       *   lock 中 (scoring_not_started / prerequisite) は本文と同様に出さない。 */}
      <PlacedProblemVideo canRender={canRenderBody} videoUrl={localizedProblem?.videoUrl} />

      {/* #550: 競技者向けに problem の narrative を 1 section にまとめる。
       *   metadata 不在 (= 旧 problem 等) は section ごと skip。
       *   Issue #1038 P0 #2: scoring_not_started のときは render しない (= lock)。 */}
      {canRenderBody && metadata && narrative && (
        <ProblemInfoSection metadata={metadata} narrative={narrative} t={t} />
      )}
      {/* 2026-05-18 user feedback: 「攻撃時刻を相手に予告する Red Team は存在しない」
       *   「種明かしをした おばけやしき はつまらない」
       *   Issue #607 の `TimelinePredictSection` (= 残時間 countdown +
       *   phase / disruption の事前予告) は **競技公平性と体験の観点から competitor side で
       *   表示しない**。 component 自体は operator 視点 (= application-admin-console の
       *   Event 管理画面) で再利用する可能性があるため file は維持、 participant portal の
       *   ProblemDetail からのみ撤去する。 */}

      {/* Issue #1038 P0 #2: ProblemPanel (= flag 提出 / hint reveal の UI 本体) も lock。 */}
      {canRenderBody && problem && (
        <ProblemPanel
          problem={problem}
          apiBaseUrl={config.apiBaseUrl}
          sessionToken={sessionToken ?? ""}
          onScored={refresh}
        />
      )}

      {/* Issue #607: endpoints[] が宣言された Battle 問題で override 登録
       *   form を表示。 endpoints 空 / 不在の問題 (= flag-only Challenge 等) は内部で skip。
       *   Issue #1038 P0 #2: scoring_not_started のときは render しない (= lock)。 */}
      {canRenderEndpoints && problem && (
        <EndpointOverrideForm
          key={JSON.stringify([view?.team.teamId, sessionToken, problem.problemId])}
          apiBaseUrl={config.apiBaseUrl}
          teamLoginKey={sessionToken ?? ""}
          problemId={problem.problemId}
          endpoints={endpointRegistry.endpoints}
          listError={endpointRegistry.error}
          onEndpointsChange={endpointRegistry.replaceEndpoints}
        />
      )}

      {/* metadata.dashboard.slots で宣言した problem plugin を
       *   render する。 該当 slot が無い問題は section 全体が render されない。 */}
      {problem && metadata?.dashboardSlots && view?.team && (
        <PortalPluginSlots
          problemId={problem.problemId}
          jobId={problem.jobId}
          score={problem.score}
          locale={locale}
          posture={problem.posture}
          platform={problem.platform}
          team={view.team}
          stackOutputs={problem.stackOutputs}
          endpoints={endpointRegistry.endpoints}
          coordinationApiUrl={config.coordinationApiUrl}
          sessionToken={sessionToken ?? undefined}
        />
      )}
    </SpaceBetween>
  );
}

function ProblemDetailStatusAlerts({
  awsOnly,
  error,
  bonusPending,
  gateName,
  gatePending,
  gateProblem,
  jobId,
  locked,
  onNavigate,
  prereqLocked,
  problem,
  progression,
  scoringNotStartedAt,
  t,
  view,
}: {
  awsOnly: boolean;
  error: string | null;
  bonusPending: boolean;
  gateName: string;
  gatePending: boolean;
  gateProblem?: ParticipantProblemView;
  jobId: string;
  locked: boolean;
  onNavigate: (to: string) => void;
  prereqLocked: boolean;
  problem?: ParticipantProblemView;
  progression?: ParticipantTeamView["progression"];
  scoringNotStartedAt?: string;
  t: (key: string, params?: Readonly<Record<string, string | number>>) => string;
  view: ParticipantTeamView | null;
}) {
  return (
    <>
      {error && (
        <Alert type="error" header={t("app.fetch_status_failed")}>
          {error}
        </Alert>
      )}
      {!problem && view && awsOnly && (
        // [Challenge #402] `local/` を持たない問題は `make local` では起動できない。以前は
        // 「deploy されていません。operator にお問い合わせください」と出ていたが、local play の
        // operator は本人なので何もできず、行き止まりだと分かるまでに時間がかかっていた。
        <Alert type="info" header={t("problem_detail.aws_only_header")}>
          <Box variant="p">{t("problem_detail.aws_only_body")}</Box>
        </Alert>
      )}
      {!problem && view && !awsOnly && (
        <Alert type="warning" header={t("problem_detail.deploy_missing_header")}>
          <Box variant="p">{t("problem_detail.deploy_missing_body", { jobId })}</Box>
        </Alert>
      )}
      {!problem && !view && !error && <Box>{t("app.loading")}</Box>}
      {problem && locked && (
        <Alert type="info" header={t("problem_detail.scoring_not_started_header")}>
          <Box variant="p">
            {t("problem_detail.scoring_not_started_body")}
            {scoringNotStartedAt && (
              <>
                <br />
                {t("problem_detail.scoring_not_started_starts_at_label")}:{" "}
                <code>{new Date(scoringNotStartedAt).toLocaleString()}</code>
              </>
            )}
          </Box>
        </Alert>
      )}
      {/* Issue #2283: Progression Gate。 prerequisite-locked 問題は scoring_not_started と
       *   同じ lock screen パターンで案内し、 body / flag 提出 / endpoint form は render しない。
       *   Gate 問題が自 team に deploy 済みなら詳細ページへの link を出す。 event gate lock
       *   (scoring_not_started) が同時に効いているときはそちらを優先 (= 二重 Alert を避ける)。 */}
      {problem && !locked && prereqLocked && (
        <Alert type="info" header={t("problem_detail.prerequisite_locked_header")}>
          <Box variant="p">
            {t("problem_detail.prerequisite_locked_body", { gateName })}
            {gateProblem && (
              <>
                <br />
                <Link
                  href={`/problems/${encodeURIComponent(gateProblem.jobId)}`}
                  onFollow={(e) => {
                    e.preventDefault();
                    onNavigate(`/problems/${encodeURIComponent(gateProblem.jobId)}`);
                  }}
                >
                  {t("problem_detail.prerequisite_locked_gate_link", { gateName })}
                </Link>
              </>
            )}
          </Box>
        </Alert>
      )}
      {/* Issue #2283: Gate 問題自身の詳細ページには 「これを完了すると他の問題が解放される」
       *   hint を出す (+ completionBonus があれば bonus 予告)。 lock ではないので body は出る。 */}
      {problem && !locked && gatePending && (
        <Alert type="info" header={t("problem_detail.gate_hint_header")}>
          <Box variant="p">
            {t("problem_detail.gate_hint_body")}
            {progression && progression.completionBonus > 0 && (
              <> {t("problem_detail.gate_hint_bonus", { points: progression.completionBonus })}</>
            )}
          </Box>
        </Alert>
      )}
      {/* Issue #2283: policy "off" の team は Gate 未完了でも何も locked されないので unlock hint
       *   (gatePending) は出ないが、 完了 bonus は付与される。 その場合だけ bonus 予告を単独で出す
       *   (gatePending 側は bonus を inline 表示済みなので二重に出さない)。 */}
      {problem && !locked && !gatePending && bonusPending && progression && (
        <Alert type="info" header={t("problem_detail.gate_bonus_only_header")}>
          <Box variant="p">
            {t("problem_detail.gate_hint_bonus", { points: progression.completionBonus })}
          </Box>
        </Alert>
      )}
    </>
  );
}

/**
 * #550 + audit #1/#2: 「問題情報」 section。 metadata 由来 narrative を competition 目線で表示。
 * 内訳:
 *   - カテゴリ (Battle / Challenge) + 難易度 (= 競技者の戦略決定に必要な 2 軸)
 *   - 問題説明 (= description、 改行保持の長文)
 *
 * 表示しない field (audit table):
 *   - 想定プレイ時間 → 大会 timing を競技者に漏らさない (audit #1)
 *   - 学習目的 / 背景 / 世界観 → 出題意図のメタ情報、 競技中は不要 (audit #2)
 *   - タグ → 一覧の category filter で十分、 詳細では noise
 *   - cfnTemplate / cfnParameters / exposedPorts → deploy 内部情報
 */
function ProblemInfoSection({
  metadata,
  narrative,
  t,
}: {
  metadata: ProblemCatalogEntry;
  narrative: { readonly shortDescription: string; readonly instructions?: string };
  t: (key: string, params?: Readonly<Record<string, string | number>>) => string;
}) {
  // Audit table #1/#2: 想定プレイ時間 / 学習目的 / タグ は competition では出さない
  // (= timing 漏洩 + 出題意図メタの暴露)。 残すのは カテゴリ + 難易度 + 問題説明 のみ。
  // Phase 1c (#1929): per-problem architecture diagram (bundled diagram.svg), if any.
  const diagramUrl = findProblemDiagramUrl(metadata.id);
  return (
    <Container header={<Header variant="h2">{t("problem_detail.info_header")}</Header>}>
      <SpaceBetween size="m">
        <ColumnLayout columns={2} variant="text-grid">
          <InfoCell label={t("problem_detail.info_category")}>
            <SpaceBetween direction="horizontal" size="xxs">
              <Badge color={metadata.category === "Battle" ? "red" : "blue"}>
                {metadata.category}
              </Badge>
              {/* private 問題には「答え非公開」badge を出し、public では省略する。 */}
              {metadata.visibility === "private" && (
                <Badge color="severity-high">{t("problem_detail.info_private_badge")}</Badge>
              )}
            </SpaceBetween>
          </InfoCell>
          <InfoCell label={t("problem_detail.info_difficulty")}>
            {t(DIFFICULTY_KEY[metadata.difficulty])}
          </InfoCell>
          {/* 問題が deploy される cloud を明示。AWS 以外は
              緑で強調し、 競技者が自分の対象 cloud account を取り違えないようにする。 */}
          <InfoCell label={t("problem_detail.info_runtime")}>
            <Badge color={metadata.runtime.provider === "aws" ? "grey" : "green"}>
              {providerLabel(metadata.runtime.provider)}
            </Badge>
          </InfoCell>
        </ColumnLayout>

        <div>
          <Box variant="awsui-key-label">{t("problem_detail.info_description_label")}</Box>
          {/* metadata.description は採点ルール /
           *   hardened state / 段階詳細 などのネタバレを含むので portal には embed しない。
           *   競技者向けの 1 行サマリ (= shortDescription) のみ表示する。 admin / authoring
           *   view 用の長文は apps/application-admin-console を参照。 */}
          <Box variant="p">{narrative.shortDescription}</Box>
        </div>
        {/* Issue #1929: per-problem architecture diagram (bundled diagram.svg). */}
        {diagramUrl && (
          <div>
            <Box variant="awsui-key-label">{t("problem_detail.info_diagram_label")}</Box>
            <img
              src={diagramUrl}
              alt={t("problem_detail.info_diagram_label")}
              style={{ maxWidth: "100%", height: "auto" }}
            />
          </div>
        )}
        {/* Issue #1929: player-facing getting-started guidance (Markdown, images allowed
         *   via the web-kit allowlist). Non-spoiler by contract -- scoring numbers /
         *   hardened state / surprise mechanics stay in description / hints. */}
        {narrative.instructions && (
          <div>
            <Box variant="awsui-key-label">{t("problem_detail.info_instructions_label")}</Box>
            <Markdown source={narrative.instructions} />
          </div>
        )}
      </SpaceBetween>
    </Container>
  );
}

function InfoCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Box variant="awsui-key-label">{label}</Box>
      <div>{children}</div>
    </div>
  );
}
