import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { Navigate, useNavigate, useParams } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { useTeamView } from "../auth/TeamViewProvider";
import { EndpointOverrideForm } from "../components/EndpointOverrideForm";
import { PhaseCountdown, type PhaseCountdownEntry } from "../components/PhaseCountdown";
import { ProblemPanel } from "../components/ProblemPanel";
import type { AppConfig } from "../config";
import { findProblemMetadata, type ProblemCatalogEntry } from "../data/problems";
import { PortalPluginSlots } from "../plugins/PortalPluginSlots";

const DIFFICULTY_LABEL: Record<ProblemCatalogEntry["difficulty"], string> = {
  1: "入門",
  2: "初級",
  3: "中級",
  4: "上級",
  5: "エキスパート",
};

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
  const sessionToken = auth.session?.sessionToken ?? null;
  const { view, error, refresh } = useTeamView();

  if (!jobId) return <Navigate to="/problems" replace />;

  const problem = view?.problems.find((p) => p.jobId === jobId);
  // #550: problem.problemId から build-time catalog で metadata を引いて narrative を表示。
  // backend を経由せず Portal が直接 metadata.json を bundle に持つ (admin-console と同 source、
  // ADR-003 で DDB API 化したらここを差し替える)。catalog 不在 (= 旧 problem 等) は undefined。
  const metadata = problem ? findProblemMetadata(problem.problemId) : undefined;

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={metadata?.shortDescription}
        actions={<Button onClick={() => navigate("/problems")}>問題一覧へ戻る</Button>}
      >
        {metadata?.name ?? problem?.problemId ?? jobId}
      </Header>

      {error && (
        <Alert type="error" header="状態の取得に失敗しました">
          {error}
        </Alert>
      )}

      {!problem && view && (
        <Alert type="warning" header="この問題は自チームに deploy されていません">
          <Box variant="p">
            jobId <code>{jobId}</code> は自チームの deploy リストに無いため、詳細を表示できません。
            operator にお問い合わせください。
          </Box>
        </Alert>
      )}
      {!problem && !view && !error && <Box>状態を取得中…</Box>}

      {/* #550: 競技者向けに problem の narrative を 1 section にまとめる。
       *   metadata 不在 (= 旧 problem 等) は section ごと skip。 */}
      {problem && metadata && <ProblemInfoSection metadata={metadata} />}
      {/* ADR-012 Phase 4 / Issue #607: phases / disruptions を予告 panel + countdown timeline で表示。
       *   両方とも空なら skip。 deployedAt が API から取れたら live countdown、 取れなければ
       *   static な「+N 分」 表示に degrade。 */}
      {problem && metadata && (metadata.phases.length > 0 || metadata.disruptions.length > 0) && (
        <TimelinePredictSection metadata={metadata} deployedAt={problem.createdAt} />
      )}

      {problem && (
        <ProblemPanel
          problem={problem}
          apiBaseUrl={config.apiBaseUrl}
          sessionToken={sessionToken ?? ""}
          onScored={refresh}
        />
      )}

      {/* Issue #607 ADR-012 Phase 3.A UI: endpoints[] が宣言された Battle 問題で override 登録
       *   form を表示。 endpoints 空 / 不在の問題 (= flag-only Challenge 等) は内部で skip。 */}
      {problem && metadata && metadata.endpoints.length > 0 && (
        <EndpointOverrideForm
          apiBaseUrl={config.apiBaseUrl}
          teamLoginKey={sessionToken ?? ""}
          problemId={problem.problemId}
        />
      )}

      {/* ADR-012 Phase 5: problem 側 portal plugin (= metadata.dashboard.slots で宣言) を
       *   render する。 該当 slot が無い問題は section 全体が render されない。 */}
      {problem && metadata?.dashboardSlots && view?.team && (
        <PortalPluginSlots
          problemId={problem.problemId}
          jobId={problem.jobId}
          score={problem.score}
          team={view.team}
          stackOutputs={problem.stackOutputs}
        />
      )}
    </SpaceBetween>
  );
}

/**
 * #550: 「問題情報」 section。metadata.json 由来の narrative を競技者目線で表示する。
 * 内訳:
 *   - カテゴリ (Battle / Challenge) + 難易度 + 想定プレイ時間 + tags (基本情報 row)
 *   - 問題説明 (= `description`、改行保持の長文)
 *   - 学習目的 (= `learningGoals`、bullet list)
 *
 * 表示しない field: `cfnTemplate` / `cfnParameters` / `exposedPorts` (= 競技者が見ても
 * 答えの hint にしかならない deploy 内部情報)。
 *
 * 「シナリオ」「達成条件」「参考資料」「Battle 用ヒント」は schema 拡張が要るため別 PR で
 * 対応 (= #550 issue 本文の段階的実装、schema 拡張は `problems/SCHEMA.json` + 既存 3 問の
 * metadata.json 全更新が要りスコープ大)。
 */
function ProblemInfoSection({ metadata }: { metadata: ProblemCatalogEntry }) {
  return (
    <Container header={<Header variant="h2">問題情報</Header>}>
      <SpaceBetween size="m">
        <ColumnLayout columns={4} variant="text-grid">
          <InfoCell label="カテゴリ">
            <SpaceBetween direction="horizontal" size="xxs">
              <Badge color={metadata.category === "Battle" ? "red" : "blue"}>
                {metadata.category}
              </Badge>
              {/* ADR-008 Phase 1: private 問題には「答え非公開」 badge。 public は省略 (= ノイズ削減)。 */}
              {metadata.visibility === "private" && <Badge color="severity-high">答え非公開</Badge>}
            </SpaceBetween>
          </InfoCell>
          <InfoCell label="難易度">{DIFFICULTY_LABEL[metadata.difficulty]}</InfoCell>
          <InfoCell label="想定プレイ時間">{metadata.estimatedDuration}</InfoCell>
          <InfoCell label="タグ">
            <SpaceBetween direction="horizontal" size="xxs">
              {metadata.tags.length === 0 ? (
                <Box variant="small" color="text-status-inactive">
                  —
                </Box>
              ) : (
                metadata.tags.map((t) => (
                  <Badge key={t} color="grey">
                    {t}
                  </Badge>
                ))
              )}
            </SpaceBetween>
          </InfoCell>
        </ColumnLayout>

        <div>
          <Box variant="awsui-key-label">問題説明</Box>
          <Box variant="p">
            <span style={{ whiteSpace: "pre-wrap" }}>{metadata.description}</span>
          </Box>
        </div>

        {metadata.learningGoals.length > 0 && (
          <div>
            <Box variant="awsui-key-label">学習目的</Box>
            <ul>
              {metadata.learningGoals.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
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

/**
 * ADR-012 Phase 4 + Issue #607: phases[] と disruptions[] を「いつ何が起きるか」 + live countdown
 * で表示。 deployedAt (= problem.createdAt) があれば 1 秒間隔の残時間表示、 無ければ
 * static「+N 分」 表示に degrade。 残時間 < 3 分は warn 強調 (= 事前告知)。
 */
function TimelinePredictSection({
  metadata,
  deployedAt,
}: {
  metadata: ProblemCatalogEntry;
  deployedAt?: string;
}) {
  const phases = metadata.phases;
  const disruptions = metadata.disruptions;
  const phaseEntries: PhaseCountdownEntry[] = phases.map((p) => ({
    id: `phase-${p.name}`,
    name: p.name,
    afterMinutes: p.afterMinutes,
    ...(p.description ? { description: p.description } : {}),
    variant: "phase",
  }));
  const disruptionEntries: PhaseCountdownEntry[] = disruptions.map((d) => ({
    id: `disruption-${d.id}`,
    name: d.name,
    afterMinutes: d.defaultAfterMinutes ?? 0,
    ...(d.description ? { description: d.description } : {}),
    variant: "disruption",
  }));
  return (
    <Container
      header={
        <Header
          variant="h2"
          description="このあと自動で発火するフェーズ / 妨害イベント。 残 3 分以内のイベントは warn 強調で予告します。 各イベントの発火タイミングは metadata.json の宣言値で、 operator が deploy 時に上書きしている場合は実際の発火時刻と差が出ます。"
        >
          タイムライン (予告)
        </Header>
      }
    >
      <SpaceBetween size="m">
        {phaseEntries.length > 0 && (
          <div>
            <Box variant="awsui-key-label">フェーズ</Box>
            <PhaseCountdown entries={phaseEntries} {...(deployedAt ? { deployedAt } : {})} />
          </div>
        )}
        {disruptionEntries.length > 0 && (
          <div>
            <Box variant="awsui-key-label">妨害イベント</Box>
            <PhaseCountdown entries={disruptionEntries} {...(deployedAt ? { deployedAt } : {})} />
          </div>
        )}
      </SpaceBetween>
    </Container>
  );
}
