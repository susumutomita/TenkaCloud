/**
 * Issue #658 / #814: Jobs page (Provisioning / Deprovisioning タブ) 共通の表示加工 helper。
 *
 * `Jobs.tsx` から SRP 分離 (#refactor)。 execution status → badge 色 と、 start/end ISO →
 * 経過時間ラベルの 2 つは Provisioning / Deprovisioning 両タブで使う pure 関数なので、
 * ページ component とは別ファイル (lib) に置いて単体テスト可能にする。 React / AWS SDK には
 * 依存しない。
 */

/** Cloudscape `<Badge>` が受ける status 色のサブセット。 */
export type JobStatusColor = "blue" | "green" | "grey" | "red";

const STATUS_COLOR: Record<string, JobStatusColor> = {
  InProgress: "blue",
  Running: "blue",
  Succeeded: "green",
  Failed: "red",
  Cancelled: "grey",
  Stopped: "grey",
  Stopping: "grey",
  Superseded: "grey",
};

/** execution status を Cloudscape badge 色に写像する。 未知 status は灰色にフォールバック。 */
export function colorFor(status: string): JobStatusColor {
  return STATUS_COLOR[status] ?? "grey";
}

/**
 * start / end の ISO 文字列から経過時間ラベルを作る。
 *   - start 不在 / parse 不能 → "—"
 *   - end 不在 → 現在時刻まで (= 進行中 execution の経過)
 *   - 1h 以上 → "Hh Mm" / 1m 以上 → "Mm Ss" / それ未満 → "Ss"
 */
export function formatElapsed(startIso: string | undefined, endIso: string | undefined): string {
  if (!startIso) return "—";
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return "—";
  const end = endIso ? Date.parse(endIso) : Date.now();
  const ms = Math.max(0, end - start);
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
