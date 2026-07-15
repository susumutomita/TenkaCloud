import type { TopNavigationProps } from "@cloudscape-design/components/top-navigation";
import { tenkaCloudAppIconDataUri } from "./logo-data-uri";

const TENKACLOUD_WORDMARK = "TenkaCloud";

/**
 * Cloudscape TopNavigation 向けの TenkaCloud brand lockup。
 *
 * ブランドは Summit mark が担い、context があるときは console / event の識別子だけを
 * title に据える。Cloudscape は title を単一行の末尾から省略するため、wordmark を先頭へ
 * 連結すると幅不足時に識別子側から失われる。context が無いときだけ wordmark を title に戻す。
 *
 * context 表示時は mark が唯一のブランド表現なので accessible name を持たせ、wordmark が
 * title に出るときは意味の重複を避けるため decorative にする。
 */
export function createTenkaCloudTopNavigationIdentity(
  contextTitle?: string,
): TopNavigationProps.Identity {
  return {
    href: "/",
    title: contextTitle || TENKACLOUD_WORDMARK,
    logo: { src: tenkaCloudAppIconDataUri, alt: contextTitle ? TENKACLOUD_WORDMARK : "" },
  };
}
