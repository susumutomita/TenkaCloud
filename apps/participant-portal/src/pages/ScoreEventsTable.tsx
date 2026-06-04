import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Pagination from "@cloudscape-design/components/pagination";
import Table from "@cloudscape-design/components/table";
import { useState } from "react";
import type { ScoreEventView } from "../api/portal-client";
import { useT } from "../i18n";
import { describeAgo, formatOccurredAtTooltip } from "../lib/format";

/** 履歴 1 ページの行数。 uptime Battle は毎分加点で行が増え続けるためページングする (#履歴多すぎ)。 */
const PAGE_SIZE = 20;

const SOURCE_KEY: Record<ScoreEventView["source"], string> = {
  uptime: "score_events.source_uptime",
  flag: "score_events.source_flag",
  "flag-wrong": "score_events.source_flag_wrong",
  hint: "score_events.source_hint",
};

const SOURCE_COLOR: Record<ScoreEventView["source"], "blue" | "green" | "grey" | "red"> = {
  uptime: "green",
  flag: "blue",
  "flag-wrong": "red",
  hint: "grey",
};

/**
 * Score 履歴テーブル。 `ScoreEventsPage` から切り出し、 Table / Badge / 時刻フォーマット依存を
 * この module に閉じ込めた (= ページの高結合を解消)。
 */
export function ScoreEventsTable({ entries }: { entries: readonly ScoreEventView[] }) {
  const t = useT();
  const [pageIndex, setPageIndex] = useState(1);
  const pagesCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  // entries は polling で増減しうるので、 範囲外に出た page を clamp する (= 末尾削除で空表示になるのを防ぐ)。
  const currentPage = Math.min(pageIndex, pagesCount);
  const pageItems = entries.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  return (
    <Table<ScoreEventView>
      variant="embedded"
      items={[...pageItems]}
      pagination={
        entries.length > PAGE_SIZE ? (
          <Pagination
            currentPageIndex={currentPage}
            pagesCount={pagesCount}
            onChange={(e) => setPageIndex(e.detail.currentPageIndex)}
            ariaLabels={{
              nextPageLabel: t("score_events.pagination_next"),
              previousPageLabel: t("score_events.pagination_previous"),
              pageLabel: (n) => t("score_events.pagination_page", { page: n }),
            }}
          />
        ) : undefined
      }
      columnDefinitions={[
        {
          id: "occurredAt",
          header: t("score_events.col_occurred_at"),
          cell: (e) => (
            <span title={formatOccurredAtTooltip(e.occurredAt)}>
              {describeAgo(e.occurredAt, Date.now())}
            </span>
          ),
        },
        {
          id: "problemId",
          header: t("score_events.col_problem"),
          cell: (e) => <code>{e.problemId}</code>,
        },
        {
          id: "source",
          header: t("score_events.col_source"),
          cell: (e) => <Badge color={SOURCE_COLOR[e.source]}>{t(SOURCE_KEY[e.source])}</Badge>,
          width: 180,
        },
        {
          id: "points",
          header: t("score_events.col_points"),
          cell: (e) =>
            e.points >= 0 ? (
              <Box variant="strong" color="text-status-success">
                +{e.points} pt
              </Box>
            ) : (
              <Box variant="strong" color="text-status-error">
                {e.points} pt
              </Box>
            ),
          width: 100,
        },
      ]}
      empty={
        <Box textAlign="center" padding="l">
          <Box variant="strong">{t("score_events.empty_header")}</Box>
          <Box variant="small" color="text-status-inactive" padding={{ top: "s" }}>
            {t("score_events.empty_hint")}
          </Box>
        </Box>
      }
    />
  );
}
