/**
 * Issue #1700: sanitize config と marked 連携は web-kit (`@tenkacloud/web-kit`) に集約した。
 * admin-console / participant-portal の両 SPA で同一の allowlist を共有するための DRY 化で、
 * 既存挙動 (Issue #661 / #865 の DOMPurify allowlist) は不変。 既存の import パスを壊さない
 * ため、 本モジュールは web-kit からの re-export として残す。
 */
export { renderMarkdownToSafeHtml } from "@tenkacloud/web-kit";
