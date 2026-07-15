import type { TopNavigationProps } from "@cloudscape-design/components/top-navigation";
import { tenkaCloudAppIconDataUri } from "./logo-data-uri";

const TENKACLOUD_WORDMARK = "TenkaCloud";

/**
 * Cloudscape TopNavigation 向けの TenkaCloud brand lockup。
 *
 * ブランドは常に Summit mark (logo) が担う。context (どのコンソール / どのイベントか) がある
 * ときは、その識別子だけを title に据える。
 *
 * [Issue #2662] 以前は `${WORDMARK} · ${contextTitle}` と 1 本に連結していたが、Cloudscape
 * TopNavigation は title を単一行として扱い、幅が足りないと**末尾から**省略する
 * (`white-space: nowrap` + `text-overflow: ellipsis`)。連結順が固定なので、狭いと必ず語尾の
 * 識別子側が消え、ブランド接頭辞だけが残る = どちらのコンソールを開いているか判別できなくなる。
 * 識別子を優先し、ブランドは隣接する mark に委ねることで、切り詰めが識別子を犠牲にしないようにする。
 *
 * title は Cloudscape の theme token を継ぐため light / dark 双方で contrast を保つ。mark は
 * context 表示時に唯一のブランド表現となるため accessible name を持たせ、wordmark を title に
 * 出す (context 無し) ときだけ重複回避で decorative に戻す。
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
