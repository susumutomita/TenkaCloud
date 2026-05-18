import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useMemo } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { useTeamView } from "../auth/TeamViewProvider";
import { EndpointOverrideForm } from "../components/EndpointOverrideForm";
import { ProblemPanel } from "../components/ProblemPanel";
import type { AppConfig } from "../config";
import {
  findProblemMetadata,
  type ProblemCatalogEntry,
  resolveLocalizedNarrative,
} from "../data/problems";
import { useI18n } from "../i18n";
import { renderMarkdownToSafeHtml } from "../lib/markdown";
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
  // Issue #583 Phase 5.B: locale に応じて metadata.i18n[locale] override を被せる。
  // hooks-rule のため early return より前で hook を呼ぶ (= jobId 不在でも順序が変わらない)。
  const { locale } = useI18n();
  const problem = view?.problems.find((p) => p.jobId === jobId);
  // #550: problem.problemId から build-time catalog で metadata を引いて narrative を表示。
  // backend を経由せず Portal が直接 metadata.json を bundle に持つ (admin-console と同 source、
  // ADR-003 で DDB API 化したらここを差し替える)。catalog 不在 (= 旧 problem 等) は undefined。
  const metadata = problem ? findProblemMetadata(problem.problemId) : undefined;
  // ja / metadata.i18n 不在 / 該当 field 不在は元の ja narrative にフォールバック (helper 側で処理)。
  const narrative = useMemo(
    () => (metadata ? resolveLocalizedNarrative(metadata, locale) : undefined),
    [metadata, locale],
  );

  if (!jobId) return <Navigate to="/problems" replace />;

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={narrative?.shortDescription}
        actions={<Button onClick={() => navigate("/problems")}>問題一覧へ戻る</Button>}
      >
        {narrative?.name ?? problem?.problemId ?? jobId}
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

      {/* Issue #1038 P0 #2: 競技開始前は問題詳細 / hints へのアクセスを **完全に lock**。
       *   backend (= participant-handler) から eventGate が scoring_not_started で返ってきた
       *   とき、 problem detail の代わりに lock screen を表示する。 backend 側で fail-closed
       *   が担保されているため、 eventId 不在 / gate 取得失敗時も同じく lock 表示になる。
       *   競技公平性 (= 開始前に hints / 問題文を読んで準備するのを防ぐ) のため必須。 */}
      {problem && view?.eventGate?.kind === "scoring_not_started" && (
        <Alert type="info" header="競技開始前です">
          <Box variant="p">
            この問題は <strong>競技開始時刻まで lock</strong> されています。 開始までは問題詳細
            ・ヒント・flag 提出経路にアクセスできません。 運営の開始合図をお待ちください。
            {view.eventGate.startsAt && (
              <>
                <br />
                開始予定: <code>{new Date(view.eventGate.startsAt).toLocaleString()}</code>
              </>
            )}
          </Box>
        </Alert>
      )}

      {/* #550: 競技者向けに problem の narrative を 1 section にまとめる。
       *   metadata 不在 (= 旧 problem 等) は section ごと skip。
       *   Issue #1038 P0 #2: scoring_not_started のときは render しない (= lock)。 */}
      {problem &&
        metadata &&
        narrative &&
        view?.eventGate?.kind !== "scoring_not_started" && (
          <ProblemInfoSection metadata={metadata} narrative={narrative} />
        )}
      {/* 2026-05-18 user feedback: 「攻撃時刻を相手に予告する Red Team は存在しない」
       *   「種明かしをした おばけやしき はつまらない」
       *   ADR-012 Phase 4 / Issue #607 の `TimelinePredictSection` (= 残時間 countdown +
       *   phase / disruption の事前予告) は **競技公平性と体験の観点から competitor side で
       *   表示しない**。 component 自体は operator 視点 (= application-admin-console の
       *   Event 管理画面) で再利用する可能性があるため file は維持、 participant portal の
       *   ProblemDetail からのみ撤去する。 */}

      {/* Issue #1038 P0 #2: ProblemPanel (= flag 提出 / hint reveal の UI 本体) も lock。 */}
      {problem && view?.eventGate?.kind !== "scoring_not_started" && (
        <ProblemPanel
          problem={problem}
          apiBaseUrl={config.apiBaseUrl}
          sessionToken={sessionToken ?? ""}
          onScored={refresh}
        />
      )}

      {/* Issue #607 ADR-012 Phase 3.A UI: endpoints[] が宣言された Battle 問題で override 登録
       *   form を表示。 endpoints 空 / 不在の問題 (= flag-only Challenge 等) は内部で skip。
       *   Issue #1038 P0 #2: scoring_not_started のときは render しない (= lock)。 */}
      {problem &&
        metadata &&
        metadata.endpoints.length > 0 &&
        view?.eventGate?.kind !== "scoring_not_started" && (
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
}: {
  metadata: ProblemCatalogEntry;
  narrative: { readonly description: string };
}) {
  // Audit table #1/#2: 想定プレイ時間 / 学習目的 / タグ は competition では出さない
  // (= timing 漏洩 + 出題意図メタの暴露)。 残すのは カテゴリ + 難易度 + 問題説明 のみ。
  return (
    <Container header={<Header variant="h2">問題情報</Header>}>
      <SpaceBetween size="m">
        <ColumnLayout columns={2} variant="text-grid">
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
        </ColumnLayout>

        <div>
          <Box variant="awsui-key-label">問題説明</Box>
          {/* Issue #661: metadata.json の description は markdown source。 marked → DOMPurify
           *   で sanitize した HTML を render する。 ADR-008 で community contributor 経由の
           *   metadata 受け入れを想定して必ず XSS sanitize を通す。 */}
          <div
            className="problem-description-markdown"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: DOMPurify sanitized in renderMarkdownToSafeHtml
            dangerouslySetInnerHTML={{ __html: renderMarkdownToSafeHtml(narrative.description) }}
          />
        </div>
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
