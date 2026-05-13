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
import { ProblemPanel } from "../components/ProblemPanel";
import type { AppConfig } from "../config";
import {
  findProblemMetadata,
  type ProblemCatalogEntry,
  resolveLocalizedNarrative,
} from "../data/problems";
import { useI18n } from "../i18n";
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

      {/* #550: 競技者向けに problem の narrative を 1 section にまとめる。
       *   metadata 不在 (= 旧 problem 等) は section ごと skip。 */}
      {problem && metadata && narrative && (
        <ProblemInfoSection metadata={metadata} narrative={narrative} />
      )}
      {/* ADR-012 Phase 4: phases / disruptions を予告 panel として表示。 両方とも空なら skip。 */}
      {problem && metadata && (metadata.phases.length > 0 || metadata.disruptions.length > 0) && (
        <TimelinePredictSection metadata={metadata} />
      )}

      {problem && (
        <ProblemPanel
          problem={problem}
          apiBaseUrl={config.apiBaseUrl}
          sessionToken={sessionToken ?? ""}
          onScored={refresh}
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
function ProblemInfoSection({
  metadata,
  narrative,
}: {
  metadata: ProblemCatalogEntry;
  narrative: {
    readonly description: string;
    readonly learningGoals: readonly string[];
  };
}) {
  return (
    <Container header={<Header variant="h2">問題情報</Header>}>
      <SpaceBetween size="m">
        <ColumnLayout columns={4} variant="text-grid">
          <InfoCell label="カテゴリ">
            <Badge color={metadata.category === "Battle" ? "red" : "blue"}>
              {metadata.category}
            </Badge>
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
            <span style={{ whiteSpace: "pre-wrap" }}>{narrative.description}</span>
          </Box>
        </div>

        {narrative.learningGoals.length > 0 && (
          <div>
            <Box variant="awsui-key-label">学習目的</Box>
            <ul>
              {narrative.learningGoals.map((g) => (
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
 * ADR-012 Phase 4 portal predict: phases[] と disruptions[] を「いつ何が起きるか」 panel に
 * 並べて表示する。 deploy 時刻 (= 自チーム deploy の startedAt) は portal API に未露出 (Phase 4
 * scope 外) なので、 "deploy 後 N 分" の relative 表示に留める。 deploy 時刻が露出されたら
 * countdown / 経過判定を後付けする (= 同じ data shape を使う前提)。
 */
function TimelinePredictSection({ metadata }: { metadata: ProblemCatalogEntry }) {
  const phases = metadata.phases;
  const disruptions = metadata.disruptions;
  return (
    <Container
      header={
        <Header
          variant="h2"
          description="このあと自動で発火するフェーズ / 妨害イベント。 各イベントの発火タイミングは metadata.json の宣言値で、 operator が deploy 時に上書きしている場合は実際の発火時刻と差が出ます。"
        >
          タイムライン (予告)
        </Header>
      }
    >
      <SpaceBetween size="m">
        {phases.length > 0 && (
          <div>
            <Box variant="awsui-key-label">フェーズ</Box>
            <ul>
              {phases.map((p) => (
                <li key={p.name}>
                  <Badge color="blue">+{p.afterMinutes} 分</Badge> <strong>{p.name}</strong>
                  {p.description && <Box variant="p">{p.description}</Box>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {disruptions.length > 0 && (
          <div>
            <Box variant="awsui-key-label">妨害イベント</Box>
            <ul>
              {disruptions.map((d) => (
                <li key={d.id}>
                  {typeof d.defaultAfterMinutes === "number" && (
                    <>
                      <Badge color="red">+{d.defaultAfterMinutes} 分</Badge>{" "}
                    </>
                  )}
                  <strong>{d.name}</strong>
                  {d.description && <Box variant="p">{d.description}</Box>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </SpaceBetween>
    </Container>
  );
}
