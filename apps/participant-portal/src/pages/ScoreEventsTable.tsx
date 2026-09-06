import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Pagination from "@cloudscape-design/components/pagination";
import Table from "@cloudscape-design/components/table";
import { useState } from "react";
import type { ScoreEventView } from "../api/portal-client";
import { useLang, useT } from "../i18n";
import { describeAgo, formatOccurredAtTooltip } from "../lib/format";

/** 履歴 1 ページの行数。 uptime Battle は毎分加点で行が増え続けるためページングする (#履歴多すぎ)。 */
const PAGE_SIZE = 20;

const SOURCE_KEY: Record<ScoreEventView["source"], string> = {
  uptime: "score_events.source_uptime",
  flag: "score_events.source_flag",
  "flag-wrong": "score_events.source_flag_wrong",
  hint: "score_events.source_hint",
  // Issue #2283: Progression Gate 完了時の 1 回限り bonus。
  "gate-bonus": "score_events.source_gate_bonus",
  coordination: "score_events.source_coordination",
};

const SOURCE_COLOR: Record<ScoreEventView["source"], "blue" | "green" | "grey" | "red"> = {
  uptime: "green",
  flag: "blue",
  "flag-wrong": "red",
  hint: "grey",
  // Issue #2283: 加点系なので uptime と同じ green (= 正の得点は緑で揃える)。
  "gate-bonus": "green",
  coordination: "blue",
};

/**
 * 加点 / 減点の「理由」 label key。 source だけでは uptime の +200 (稼働継続) と -25/-100
 * (ダウン / 障害注入ペナルティ) を区別できないため、 source + points の符号から導く。
 */
const NON_UPTIME_REASON_KEY: Record<Exclude<ScoreEventView["source"], "uptime">, string> = {
  flag: "score_events.reason_flag",
  "flag-wrong": "score_events.reason_flag_wrong",
  hint: "score_events.reason_hint",
  "gate-bonus": "score_events.reason_gate_bonus",
  coordination: "score_events.reason_coordination",
};

function reasonKey(event: ScoreEventView): string {
  if (event.source === "coordination" && event.reason) {
    return `score_events.coordination_${event.reason}`;
  }
  if (event.source === "uptime") {
    return event.points >= 0 ? "score_events.reason_uptime_up" : "score_events.reason_uptime_down";
  }
  return NON_UPTIME_REASON_KEY[event.source];
}

/**
 * Score 履歴テーブル。 `ScoreEventsPage` から切り出し、 Table / Badge / 時刻フォーマット依存を
 * この module に閉じ込めた (= ページの高結合を解消)。
 */
export function ScoreEventsTable({ entries }: { entries: readonly ScoreEventView[] }) {
  const t = useT();
  const lang = useLang();
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
            <span title={formatOccurredAtTooltip(e.occurredAt, lang)}>
              {describeAgo(e.occurredAt, Date.now(), lang)}
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
        {
          id: "reason",
          header: t("score_events.col_reason"),
          cell: (e) => (
            <Box variant="small" color="text-status-inactive">
              {t(reasonKey(e))}
            </Box>
          ),
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
