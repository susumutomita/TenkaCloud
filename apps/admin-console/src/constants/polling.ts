/**
 * admin-console の polling 間隔を集約する単一の正本 (#simplify constant centralization)。
 *
 * SSE/WebSocket は使わず polling で Lambda 運用と整合させる方針なので、各 page は
 * `usePolling` (web-kit) にこの定数を渡す。値の意味ごとに別 export を保ち、 数値が同じでも
 * 用途が異なるものは collapse しない。
 */

/**
 * 一般的な System Admin 画面の polling 間隔 (= 60 秒)。
 *
 * Tenant Provisioning Jobs / Tenant 詳細 / Operations スナップショット / 利用量ダッシュボード
 * など、 ほぼリアルタイム性が要る画面の標準値。
 */
export const ADMIN_POLL_INTERVAL_MS = 60_000;

/**
 * コスト予算消化パネルの polling 間隔 (= 5 分)。
 *
 * budget は AWS 側で日次更新されるため polling 圧は最小で十分。 DescribeBudget は無料。
 * 一般画面の {@link ADMIN_POLL_INTERVAL_MS} (60 秒) より長く保つ cost-guardrail なので
 * collapse しない。
 */
export const COST_POLL_INTERVAL_MS = 300_000;
