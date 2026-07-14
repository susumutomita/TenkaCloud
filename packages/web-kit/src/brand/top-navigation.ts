import type { TopNavigationProps } from "@cloudscape-design/components/top-navigation";
import { tenkaCloudAppIconDataUri } from "./logo-data-uri";

const TENKACLOUD_WORDMARK = "TenkaCloud";

/**
 * Cloudscape TopNavigation 向けの TenkaCloud brand lockup。
 *
 * Summit mark と wordmark を常に一組で表示し、各 SPA の product / event 名は middle dot で
 * 分離する。title は Cloudscape の theme token を継ぐため、light / dark mode の双方で
 * contrast を保つ。mark は隣接する wordmark と意味が重複しないよう decorative image にする。
 */
export function createTenkaCloudTopNavigationIdentity(
  contextTitle?: string,
): TopNavigationProps.Identity {
  return {
    href: "/",
    title: contextTitle ? `${TENKACLOUD_WORDMARK} · ${contextTitle}` : TENKACLOUD_WORDMARK,
    logo: { src: tenkaCloudAppIconDataUri, alt: "" },
  };
}
