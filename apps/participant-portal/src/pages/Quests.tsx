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
  getConsoleSigninUrl,
  type ParticipantProblemView,
  type ParticipantScoringInfo,
  PortalAuthError,
} from "../api/portal-client";
import { useAuth } from "../auth/AuthProvider";
import { useTeamView } from "../auth/TeamViewProvider";
import type { AppConfig } from "../config";
import { useT } from "../i18n";
import { categoryOf } from "../lib/category";

/**
 * Issue #821 / #822: 競技者向けの 「解答状態」 (= 解けた / 解けてない) を可視化する。
 *
 * 旧 UI は `DeploymentStatus` (PENDING / IN_PROGRESS / COMPLETE / FAILED) を表示
 * していたが、 これは 「deploy 進行状態」 であり競技者にとっては無関係。 競技者は
 * 「flag 提出が成功したか」 / 「Battle が進行中か」 が知りたい。
 *
 * Challenge (flag):
 *   - deploy 失敗 → \"デプロイ失敗\" (error)
 *   - deploy 中    → \"準備中\" (in-progress)
 *   - 未提出      → \"未解答\" (pending)
 *   - 提出済 (正解) → \"クリア\" (success) + 獲得 pt を score 列で表示
 *
 * Battle (uptime / phased-polling / attack-detection):
 *   - deploy 失敗 → \"デプロイ失敗\" (error)
 *   - deploy 中    → \"準備中\" (in-progress)
 *   - それ以外    → \"挑戦中\" (info) — Battle は 「解く」 ものでなく継続採点
 *
 * `applicationStatus.overall` は別 section で詳細化 (= 既存挙動を維持)。
 */
function renderSubmissionState(problem: ParticipantProblemView): {
  readonly type: StatusIndicatorProps.Type;
  readonly label: string;
} {
  if (problem.status === "FAILED") return { type: "error", label: "デプロイ失敗" };
  if (problem.status === "DELETED") return { type: "stopped", label: "終了" };
  if (problem.status === "PENDING" || problem.status === "IN_PROGRESS") {
    return { type: "in-progress", label: "準備中" };
  }
  // status === COMPLETE / DELETING
  if (problem.scoring?.kind === "flag") {
    if (problem.scoring.flagSubmitted) return { type: "success", label: "クリア" };
    return { type: "pending", label: "未解答" };
  }
  // Battle 系 (= uptime / phased-polling / attack-detection)。 採点は別 section で表示。
  return { type: "info", label: "挑戦中" };
}

type CategoryFilter = "all" | "battle" | "challenge";

function categoryBadge(scoring: ParticipantScoringInfo | undefined, uncategorizedLabel: string) {
  const cat = categoryOf(scoring);
  if (cat === "battle") return <Badge color="red">Battle</Badge>;
  if (cat === "challenge") return <Badge color="blue">Challenge</Badge>;
  return <Badge color="grey">{uncategorizedLabel}</Badge>;
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
  const t = useT();
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
      setConsoleError(t("quests.session_expired"));
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

  const emptyMessage =
    filter === "all"
      ? t("quests.empty_all")
      : filter === "battle"
        ? t("quests.empty_battle")
        : t("quests.empty_challenge");
  const emptyHint = filter === "all" ? t("quests.empty_hint_all") : t("quests.empty_hint_filtered");

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={t("quests.header_description")}>
        {t("quests.header")}
      </Header>

      {!isBackend && <Alert type="info">{t("app.dev_mock_alert")}</Alert>}
      {error && (
        <Alert type="error" header={t("app.fetch_status_failed")}>
          {error}
        </Alert>
      )}
      {consoleError && (
        <Alert
          type="error"
          dismissible
          onDismiss={() => setConsoleError(null)}
          header={t("quests.console_failed_header")}
        >
          {consoleError}
        </Alert>
      )}

      <SegmentedControl
        selectedId={filter}
        onChange={({ detail }) => setFilter(detail.selectedId as CategoryFilter)}
        options={[
          { id: "all", text: `${t("quests.filter_all")} (${counts.all})` },
          { id: "battle", text: `${t("quests.filter_battle")} (${counts.battle})` },
          { id: "challenge", text: `${t("quests.filter_challenge")} (${counts.challenge})` },
        ]}
        label={t("quests.filter_label")}
      />

      <Cards<ParticipantProblemView>
        items={filteredItems}
        loading={isBackend && !view && !error}
        loadingText={t("quests.loading_text")}
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
              {categoryBadge(problem.scoring, t("quests.category_uncategorized"))}
            </SpaceBetween>
          ),
          sections: [
            {
              // Issue #821 / #822: 「deploy 進行状況」 ではなく 「解答状態」 を出す
              // (= COMPLETE / FAILED 等の internal deploy term を競技者に見せない)。
              id: "submission",
              header: "解答状態",
              content: (problem) => {
                const s = renderSubmissionState(problem);
                return <StatusIndicator type={s.type}>{s.label}</StatusIndicator>;
              },
            },
            {
              id: "score",
              header: t("quests.score_header"),
              content: (problem) => (
                <Box variant="strong" color="text-status-success">
                  {problem.score} pt
                </Box>
              ),
            },
            {
              id: "region",
              header: t("quests.region_header"),
              content: (problem) => problem.region,
            },
            {
              id: "outputs",
              header: t("quests.outputs_header"),
              content: (problem) => {
                const entries = Object.entries(problem.stackOutputs);
                if (entries.length === 0) {
                  return (
                    <Box variant="small" color="text-status-inactive">
                      {t("quests.outputs_pending")}
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
                      {t("quests.open_console")}
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
              <Box variant="strong">{emptyMessage}</Box>
              <Box variant="small" color="text-status-inactive" padding={{ top: "s" }}>
                {emptyHint}
              </Box>
            </Box>
          </Container>
        }
      />
    </SpaceBetween>
  );
}
