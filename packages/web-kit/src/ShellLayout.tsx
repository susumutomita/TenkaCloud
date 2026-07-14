/**
 * Issue #1418 web-kit: 2 管理 console (admin-console / application-admin-console) が共有する
 * app shell。Cloudscape の `TopNavigation` (locale switcher + optional user menu + sign-out) +
 * `SideNavigation` + `AppLayout` を 1 つにまとめた router 非依存の presentational component。
 *
 * 設計方針:
 *   - web-kit は react-router / 各 SPA の auth / i18n に依存しない。 そのため遷移 (`onNavigate`)、
 *     認証状態 (`isAuthenticated` / `onSignOut`)、 翻訳 (`t`)、 locale state は **props 注入**で受ける。
 *   - per-app の差分 (title / nav items / user menu / locale aria label) はすべて props 化し、
 *     shell 構造 (utility 並び順 / TopNav-AppLayout の組み立て) を 1 箇所に集約する。
 *
 * 参加者ポータルは team-key 型の別 shell なのでここは使わない。
 */

import AppLayout from "@cloudscape-design/components/app-layout";
import SideNavigation, {
  type SideNavigationProps,
} from "@cloudscape-design/components/side-navigation";
import TopNavigation, {
  type TopNavigationProps,
} from "@cloudscape-design/components/top-navigation";
import type { ReactNode } from "react";
import { createTenkaCloudTopNavigationIdentity } from "./brand";

/** TopNav 右上に出すサインインユーザー menu (= application-admin-console の email dropdown)。 */
export interface ShellUserMenu {
  /** menu のラベル (= サインインユーザーの email)。 */
  readonly label: string;
  /** menu trigger の `aria-label` (= スクリーンリーダー向け説明)。 */
  readonly ariaLabel: string;
  /** dropdown 内のサインアウト項目のラベル。 */
  readonly signOutLabel: string;
}

export interface ShellLayoutProps<L extends string> {
  /** AppLayout の content slot に描画する page 本体。 */
  readonly children: ReactNode;
  /** TenkaCloud wordmark の後に表示する product title。省略時も brand lockup は表示する。 */
  readonly title?: string;
  /** SideNavigation header text (= メニュー見出し)。 */
  readonly navHeaderText: string;
  /** SideNavigation の項目一覧 (per-app の nav 構造)。 */
  readonly navItems: readonly SideNavigationProps.Item[];
  /** 現在の path (= SideNavigation の activeHref)。 */
  readonly activeHref: string;
  /** internal link 遷移時に呼ぶ navigate (= react-router の useNavigate を注入)。 */
  readonly onNavigate: (href: string) => void;
  /** サインイン済みか (= auth.tokens の有無)。 false なら locale switcher だけ出す。 */
  readonly isAuthenticated: boolean;
  /** サインアウト処理 (= auth.logout + login へ遷移)。 */
  readonly onSignOut: () => void;
  /** 右上のユーザー menu。 指定時は plain な sign-out ボタンの代わりにこの dropdown を出す。 */
  readonly userMenu?: ShellUserMenu;
  /** 現在の locale。 */
  readonly locale: L;
  /** locale 切替 callback。 */
  readonly setLocale: (code: L) => void;
  /** 翻訳関数 (= 各 SPA の useI18n().t)。 sign-out ボタンのラベル解決に使う。 */
  readonly t: (key: string, params?: Readonly<Record<string, string | number>>) => string;
  /** 利用可能な locale 一覧。 */
  readonly supportedLocales: readonly L[];
  /** locale code → display 名 (= 言語切替 dropdown の表示)。 */
  readonly localeNames: Readonly<Record<L, string>>;
  /** locale switcher trigger の `aria-label`。 */
  readonly localeSwitcherAriaLabel: string;
}

/** locale display 名を引く (未知 code は code 自身に fallback)。 */
function localeLabel<L extends string>(names: Readonly<Record<L, string>>, code: L): string {
  return names[code] ?? code;
}

export function ShellLayout<L extends string>({
  children,
  title,
  navHeaderText,
  navItems,
  activeHref,
  onNavigate,
  isAuthenticated,
  onSignOut,
  userMenu,
  locale,
  setLocale,
  t,
  supportedLocales,
  localeNames,
  localeSwitcherAriaLabel,
}: ShellLayoutProps<L>) {
  const localeUtility: TopNavigationProps.Utility = {
    type: "menu-dropdown",
    iconName: "globe",
    ariaLabel: localeSwitcherAriaLabel,
    text: localeLabel(localeNames, locale),
    items: supportedLocales.map((code) => ({ id: code, text: localeLabel(localeNames, code) })),
    // dropdown items は supportedLocales を id にした派生なので detail.id は常に既知 locale。
    onItemClick: ({ detail }) => setLocale(detail.id as L),
  };

  const signOutButton: TopNavigationProps.Utility = {
    type: "button",
    text: t("auth.sign_out"),
    onClick: onSignOut,
  };

  const userMenuUtility: TopNavigationProps.Utility | undefined = userMenu
    ? {
        type: "menu-dropdown",
        iconName: "user-profile",
        text: userMenu.label,
        ariaLabel: userMenu.ariaLabel,
        items: [{ id: "signout", text: userMenu.signOutLabel, iconName: "external" }],
        // user menu の item は signout のみなので click は常に sign-out を意味する。
        onItemClick: onSignOut,
      }
    : undefined;

  return (
    <>
      <TopNavigation
        identity={createTenkaCloudTopNavigationIdentity(title)}
        utilities={
          isAuthenticated ? [localeUtility, userMenuUtility ?? signOutButton] : [localeUtility]
        }
      />
      <AppLayout
        navigation={
          <SideNavigation
            activeHref={activeHref}
            header={{ href: "/", text: navHeaderText }}
            items={navItems as SideNavigationProps.Item[]}
            onFollow={(e) => {
              if (!e.detail.external) {
                e.preventDefault();
                onNavigate(e.detail.href);
              }
            }}
          />
        }
        content={children}
        toolsHide
      />
    </>
  );
}
