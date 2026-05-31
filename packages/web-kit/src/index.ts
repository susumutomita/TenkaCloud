/**
 * Issue #1366: design system barrel export。
 *
 * 規約 (DESIGN-SYSTEM.html "12. Enforcement"):
 *   - 任意の page は EmptyState / ErrorState / LoadingState / StatusBadge をここから import する。
 *   - Cloudscape の Badge / Alert / Spinner を **直接** 触るのではなく、 一段抽象を挟むことで
 *     視覚 token (= 色 / 余白 / icon) を全 SPA 一括で変更できる。
 */
export { EmptyState, type EmptyStateAction, type EmptyStateProps } from "./EmptyState";
export { ErrorState, type ErrorStateProps } from "./ErrorState";
export { LoadingState, type LoadingStateProps } from "./LoadingState";
export { StatusBadge, type StatusBadgeProps, type StatusTone, statusToTone } from "./StatusBadge";
