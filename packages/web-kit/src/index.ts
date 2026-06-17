/**
 * @tenkacloud/web-kit: 3 SPA で共有する UI primitives + i18n core (Issue #1418 / #1366)。
 *
 * design-system 規約 (DESIGN-SYSTEM.html "12. Enforcement"):
 *   - 任意の page は EmptyState / ErrorState / LoadingState / StatusBadge をここから import する。
 *   - Cloudscape の Badge / Alert / Spinner を **直接** 触るのではなく、 一段抽象を挟むことで
 *     視覚 token (= 色 / 余白 / icon) を全 SPA 一括で変更できる。
 */
export { AuthProvider, type AuthState, useAuth } from "./auth";
export { renderBootError } from "./boot-error";
export { EmptyState, type EmptyStateAction, type EmptyStateProps } from "./EmptyState";
export { ErrorState, type ErrorStateProps } from "./ErrorState";
export { toErrorMessage } from "./error-message";
export {
  type FeatureRegistry,
  type FeatureSpec,
  type FeatureStability,
  type ResolvedFeatures,
  resolveFeatureFlags,
} from "./feature-flags";
export {
  createI18n,
  type I18nConfig,
  type I18nContextValue,
  type I18nKit,
  interpolate,
  resolveKey,
} from "./i18n";
export { LoadingState, type LoadingStateProps } from "./LoadingState";
export { Markdown, type MarkdownProps, renderMarkdownToSafeHtml } from "./markdown";
export { StatusBadge, type StatusBadgeProps, type StatusTone, statusToTone } from "./StatusBadge";
export { useNowMs } from "./useNowMs";
export { type UsePollingOptions, usePolling } from "./usePolling";
