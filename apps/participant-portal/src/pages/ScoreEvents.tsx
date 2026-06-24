import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Toggle from "@cloudscape-design/components/toggle";
import { ScoreCumulativeChart } from "../components/ScoreCumulativeChart";
import type { AppConfig } from "../config";
import { useIsMock } from "../config-context";
import { POLL_INTERVAL_MS } from "../constants/polling";
import { useScoreEventsData } from "../hooks/useScoreEventsData";
import { useT } from "../i18n";
import { ScoreEventsTable } from "./ScoreEventsTable";

/**
 * 自チームの累積スコア折れ線 + score 履歴テーブルのページ。 取得 / auto refresh / error /
 * dev-mock seed と累積系列の導出は {@link useScoreEventsData} に、 chart 描画は
 * {@link ScoreCumulativeChart} に委譲し、 ここは描画分岐だけを担う thin orchestrator。
 */
export function ScoreEventsPage({ config }: { config: AppConfig }) {
  const t = useT();
  const isMock = useIsMock();
  const {
    data,
    series,
    xDomain,
    error,
    autoRefresh,
    setAutoRefresh,
    isRefreshing,
    canRefresh,
    refresh,
  } = useScoreEventsData(config);

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={t("score_events.description", { intervalSec: POLL_INTERVAL_MS / 1000 })}
        actions={
          canRefresh ? (
            <SpaceBetween direction="horizontal" size="s">
              <Toggle
                checked={autoRefresh}
                onChange={({ detail }) => setAutoRefresh(detail.checked)}
              >
                {t("score_events.auto_refresh_label", { intervalSec: POLL_INTERVAL_MS / 1000 })}
              </Toggle>
              <Button iconName="refresh" loading={isRefreshing} onClick={refresh}>
                {t("score_events.refresh_latest")}
              </Button>
            </SpaceBetween>
          ) : undefined
        }
      >
        {t("score_events.title")}
      </Header>

      {error && (
        <Alert type="error" header={t("app.fetch_status_failed")}>
          {error}
        </Alert>
      )}
      {!isMock && !data && !error && (
        <Box textAlign="center" padding="l">
          <Spinner /> {t("app.loading")}
        </Box>
      )}

      {data && series.length > 0 && <ScoreCumulativeChart series={series} xDomain={xDomain} />}

      {data && (
        <Container
          header={
            <Header variant="h2">
              {t("score_events.history_header", { count: data.entries.length })}
            </Header>
          }
        >
          <ScoreEventsTable entries={data.entries} />
        </Container>
      )}
    </SpaceBetween>
  );
}
