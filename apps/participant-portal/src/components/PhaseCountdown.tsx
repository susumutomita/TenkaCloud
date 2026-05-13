/**
 * Issue #607 Phase 3 / ADR-012 Phase 4 portal predict: phase / disruption の発火時刻までの
 * 残時間を live countdown で表示する。
 *
 * 入力: `deployedAt` (= deployment.createdAt の ISO 8601) + `entries[]` (= name + afterMinutes
 * + description)。 `Date.now()` との差で残分秒を計算し、 1 秒間隔で再 render。 deployedAt が
 * 不在 (= 旧 deployment 互換 / PENDING で未確定) なら static な「+N 分」 表示に degrade する。
 *
 * 設計判断:
 *   - polling 不要 (= 完全 client-side)。 server 側時刻と clock skew があり得るが phase 切替は
 *     scoring engine 側 (= server) で発火するため、 portal の countdown は表示用 hint のみ。
 *   - 残時間 < 0 (= 既に発火済) は "発火済" badge。
 *   - 残時間 < 3 分 (= 180 秒) は "もうすぐ" の warn badge で強調 (= toast の代わり)。
 *   - cleanup: unmount 時 setInterval を clear。
 *
 * Issue #607 toast 通知 (= phase 切替 3 分前から事前告知) は本 component の「もうすぐ」
 * inline strong 表示で代用 (= Cloudscape Flashbar を別途配置するよりシンプル + 状態 1 source)。
 */

import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import { useEffect, useState } from "react";

export interface PhaseCountdownEntry {
  readonly id: string;
  readonly name: string;
  readonly afterMinutes: number;
  readonly description?: string;
  /** Badge 色を切替えるための分類。 phase = blue、 disruption = red。 */
  readonly variant: "phase" | "disruption";
}

interface PhaseCountdownProps {
  readonly deployedAt?: string;
  readonly entries: readonly PhaseCountdownEntry[];
}

/** `deployedAt` + `afterMinutes` から発火 epoch (ms) を計算。 deployedAt 不在なら undefined。 */
function computeFireMs(deployedAt: string | undefined, afterMinutes: number): number | undefined {
  if (!deployedAt) return undefined;
  const deployedMs = Date.parse(deployedAt);
  if (!Number.isFinite(deployedMs)) return undefined;
  return deployedMs + afterMinutes * 60_000;
}

/** ms 単位の残時間を `M:SS` / `H:MM:SS` 表示にする。 負値は "発火済"。 */
function formatRemaining(remainingMs: number): {
  label: string;
  status: "future" | "soon" | "past";
} {
  if (remainingMs <= 0) return { label: "発火済", status: "past" };
  const totalSec = Math.ceil(remainingMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const label =
    hours > 0
      ? `あと ${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `あと ${minutes}:${String(seconds).padStart(2, "0")}`;
  // 3 分以内は "soon" 強調 (= Issue #607 の 「3 分前事前告知」)。
  return { label, status: remainingMs <= 180_000 ? "soon" : "future" };
}

export function PhaseCountdown({ deployedAt, entries }: PhaseCountdownProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    // 1 秒間隔で時刻を進める (= 完全 client-side、 polling 不要)。 unmount で clear。
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (entries.length === 0) return null;

  return (
    <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
      {entries.map((entry) => {
        const fireMs = computeFireMs(deployedAt, entry.afterMinutes);
        const remainingMs = fireMs !== undefined ? fireMs - nowMs : undefined;
        const formatted = remainingMs !== undefined ? formatRemaining(remainingMs) : undefined;
        const badgeColor: "blue" | "red" | "grey" =
          formatted?.status === "past" ? "grey" : entry.variant === "disruption" ? "red" : "blue";
        return (
          <li key={entry.id}>
            <Badge color={badgeColor}>+{entry.afterMinutes} 分</Badge> <strong>{entry.name}</strong>{" "}
            {formatted && (
              <Box
                variant="span"
                color={
                  formatted.status === "soon"
                    ? "text-status-warning"
                    : formatted.status === "past"
                      ? "text-status-inactive"
                      : "text-status-info"
                }
              >
                ({formatted.label})
              </Box>
            )}
            {!formatted && (
              <Box variant="span" color="text-status-inactive">
                (deploy 時刻未確定)
              </Box>
            )}
            {entry.description && <Box variant="p">{entry.description}</Box>}
          </li>
        );
      })}
    </ul>
  );
}
