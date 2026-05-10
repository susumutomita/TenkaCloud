import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Cards from "@cloudscape-design/components/cards";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import SegmentedControl from "@cloudscape-design/components/segmented-control";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator, {
  type StatusIndicatorProps,
} from "@cloudscape-design/components/status-indicator";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  type DeploymentStatus,
  getConsoleSigninUrl,
  type ParticipantProblemView,
  type ParticipantScoringInfo,
  PortalAuthError,
} from "../api/portal-client";
import { useAuth } from "../auth/AuthProvider";
import { useTeamView } from "../auth/TeamViewProvider";
import type { AppConfig } from "../config";
import { categoryOf } from "../lib/category";

const STATUS_TYPE: Record<DeploymentStatus, StatusIndicatorProps.Type> = {
  PENDING: "pending",
  IN_PROGRESS: "in-progress",
  COMPLETE: "success",
  FAILED: "error",
  DELETING: "in-progress",
  DELETED: "stopped",
};

/**
 * 競技者語彙の status label (#549)。
 *
 * deployment status (`COMPLETE` / `IN_PROGRESS` / ...) は operator 視点の語彙で、
 * 競技者目線では「自分が解いた = COMPLETE」と誤解されていた。インフラ状態を抽象化して
 * 「プレイ可能か」の軸に変換する。本来は scoring kind ごとに「正解/未提出」「防御中/攻撃検知」
 * を出すべきだが (issue 内 案 A)、それは participant API の拡張が要るので別 issue
 * (#163 / #164) で対応する。本 PR では **「環境の起動状態」** を競技者語彙に統一する第一弾。
 */
const STATUS_PARTICIPANT_LABEL: Record<DeploymentStatus, string> = {
  PENDING: "起動準備中",
  IN_PROGRESS: "起動中…",
  COMPLETE: "起動中",
  FAILED: "起動失敗",
  DELETING: "停止中",
  DELETED: "停止済",
};

type CategoryFilter = "all" | "battle" | "challenge";

function categoryBadge(scoring: ParticipantScoringInfo | undefined) {
  const cat = categoryOf(scoring);
  if (cat === "battle") return <Badge color="red">Battle</Badge>;
  if (cat === "challenge") return <Badge color="blue">Challenge</Badge>;
  return <Badge color="grey">未分類</Badge>;
}

/**
 * 自チーム向け deploy 済問題のカタログ画面 (sidebar 「問題一覧」)。Home に対する
 * compact な navigation focus 版で、各問題の status / score / アクセス先 URL を
 * カード表示する。
 *
 * データ source は `useTeamView()` (= ShellLayout 内の `/portal/me` polling 結果を共有)。
 * 専用 polling は持たない (Home / TopNav と同じ context を使う)。
 */
export function QuestsPage({ config }: { config: AppConfig }) {
  const { view, error } = useTeamView();
  const navigate = useNavigate();
  const auth = useAuth();
  const isBackend = config.mode === "backend";
  const [filter, setFilter] = useState<CategoryFilter>("all");
  // #551: 問題ごとの「AWS Console を開く」 button 進行中フラグ。1 card につき 1 click だけ
  // signin URL 発行 API を叩き window.open するための loading state (jobId → boolean)。
  const [consoleInFlight, setConsoleInFlight] = useState<Record<string, boolean>>({});
  const [consoleError, setConsoleError] = useState<string | null>(null);

  const openAwsConsole = async (jobId: string) => {
    if (consoleInFlight[jobId]) return;
    const sessionToken = auth.session?.sessionToken ?? null;
    if (!sessionToken) {
      setConsoleError("セッションが切れています。再ログインしてください。");
      return;
    }
    setConsoleInFlight((prev) => ({ ...prev, [jobId]: true }));
    setConsoleError(null);
    try {
      const url = await getConsoleSigninUrl(config.apiBaseUrl, sessionToken, jobId);
      // 別 tab で開く (= popup 系 blocker は同期 click 直下なら基本通る)。
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      if (err instanceof PortalAuthError) {
        auth.logout();
        return;
      }
      setConsoleError(err instanceof Error ? err.message : String(err));
    } finally {
      setConsoleInFlight((prev) => ({ ...prev, [jobId]: false }));
    }
  };

  const counts = useMemo(() => {
    const all = view?.problems ?? [];
    return {
      all: all.length,
      battle: all.filter((p) => categoryOf(p.scoring) === "battle").length,
      challenge: all.filter((p) => categoryOf(p.scoring) === "challenge").length,
    };
  }, [view]);

  const filteredItems = useMemo(() => {
    const all = view?.problems ?? [];
    if (filter === "all") return [...all];
    return all.filter((p) => categoryOf(p.scoring) === filter);
  }, [view, filter]);

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description="自チームに deploy された問題のカタログ。各カードからアクセス先 URL に直接遷移できます。"
      >
        問題一覧 (Quests)
      </Header>

      {!isBackend && (
        <Alert type="info">
          dev-mock モードで動作中です。実 backend と接続するには runtime-config の <code>mode</code>{" "}
          を <code>backend</code> に設定してください。
        </Alert>
      )}
      {error && (
        <Alert type="error" header="状態の取得に失敗しました">
          {error}
        </Alert>
      )}
      {consoleError && (
        <Alert
          type="error"
          dismissible
          onDismiss={() => setConsoleError(null)}
          header="AWS Console の発行に失敗しました"
        >
          {consoleError}
        </Alert>
      )}

      <SegmentedControl
        selectedId={filter}
        onChange={({ detail }) => setFilter(detail.selectedId as CategoryFilter)}
        options={[
          { id: "all", text: `すべて (${counts.all})` },
          { id: "battle", text: `Battle (${counts.battle})` },
          { id: "challenge", text: `Challenge (${counts.challenge})` },
        ]}
        label="カテゴリで絞り込み"
      />

      <Cards<ParticipantProblemView>
        items={filteredItems}
        loading={isBackend && !view && !error}
        loadingText="問題を取得中…"
        cardDefinition={{
          // jobId (ULID) を URL key にする。problemId (slug) は metadata 上 unique 前提だが、
          // 将来 problemId を意図せず重複登録された場合の link 衝突を回避する防御。
          header: (problem) => (
            <SpaceBetween size="xs" direction="horizontal" alignItems="center">
              <Link
                fontSize="heading-m"
                href={`/problems/${encodeURIComponent(problem.jobId)}`}
                onFollow={(e) => {
                  e.preventDefault();
                  navigate(`/problems/${encodeURIComponent(problem.jobId)}`);
                }}
              >
                <code>{problem.problemId}</code>
              </Link>
              {categoryBadge(problem.scoring)}
            </SpaceBetween>
          ),
          sections: [
            {
              id: "status",
              header: "環境ステータス",
              content: (problem) => (
                <StatusIndicator type={STATUS_TYPE[problem.status]}>
                  {STATUS_PARTICIPANT_LABEL[problem.status]}
                </StatusIndicator>
              ),
            },
            {
              id: "score",
              header: "現在の Score",
              content: (problem) => (
                <Box variant="strong" color="text-status-success">
                  {problem.score} pt
                </Box>
              ),
            },
            {
              id: "region",
              header: "Region",
              content: (problem) => problem.region,
            },
            {
              id: "outputs",
              header: "アクセス先 URL",
              content: (problem) => {
                const entries = Object.entries(problem.stackOutputs);
                if (entries.length === 0) {
                  return (
                    <Box variant="small" color="text-status-inactive">
                      まだ deploy 完了していません
                    </Box>
                  );
                }
                return (
                  <SpaceBetween size="xs">
                    {entries.map(([label, value]) => (
                      <Box key={label}>
                        <Box variant="awsui-key-label">{label}</Box>
                        <a href={value} target="_blank" rel="noreferrer noopener">
                          <code>{value}</code>
                        </a>
                      </Box>
                    ))}
                    {/* #551: 問題詳細から 1 click で competitor AWS account の Console を開く。
                     *   backend は POST /portal/me/console-signin-url で短命の federation URL を
                     *   発行 (= /tools/sso の 2-step フローを 1-step に短縮)。*/}
                    <Button
                      iconName="external"
                      iconAlign="right"
                      disabled={!isBackend}
                      loading={consoleInFlight[problem.jobId] === true}
                      onClick={() => void openAwsConsole(problem.jobId)}
                    >
                      AWS Console を開く
                    </Button>
                  </SpaceBetween>
                );
              },
            },
          ],
        }}
        cardsPerRow={[{ cards: 1 }, { minWidth: 600, cards: 2 }]}
        empty={
          <Container>
            <Box textAlign="center" padding="l">
              <Box variant="strong">
                {filter === "all"
                  ? "問題がありません"
                  : `${filter === "battle" ? "Battle" : "Challenge"} カテゴリに該当する問題がありません`}
              </Box>
              <Box variant="small" color="text-status-inactive" padding={{ top: "s" }}>
                {filter === "all"
                  ? "このチームには deploy 済みの問題がありません。operator にお問い合わせください。"
                  : "他カテゴリは「すべて」タブで確認できます。"}
              </Box>
            </Box>
          </Container>
        }
      />
    </SpaceBetween>
  );
}
