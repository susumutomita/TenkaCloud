/**
 * Issue #1418 web-kit: ShellLayout (= 2 管理 console 共有の app shell) の振る舞いを固定する。
 *
 * Cloudscape の TopNavigation / SideNavigation / menu-dropdown は素朴な click では onChange /
 * onItemClick が発火しないため、 @cloudscape-design/components/test-utils/dom (createWrapper) で
 * dropdown を開いてから item を選ぶ。
 *
 * 検証観点:
 *   - TenkaCloud brand lockup + optional product title
 *   - 未認証時は locale switcher のみ、 認証時は sign-out (userMenu 無) / user menu (userMenu 有)
 *   - locale 切替が setLocale を呼ぶ / user menu の sign-out が onSignOut を呼ぶ
 *   - SideNavigation の internal link は preventDefault + onNavigate、 external link は素通し
 *   - localeNames に無い code は code 自身に fallback する (UI を壊さない)
 */

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { tenkaCloudAppIconDataUri } from "../src/brand";
import { ShellLayout, type ShellLayoutProps } from "../src/ShellLayout";

type Locale = "ja" | "en";

const LOCALE_NAMES: Record<Locale, string> = { ja: "日本語", en: "English" };

function renderShell(overrides: Partial<ShellLayoutProps<Locale>> = {}) {
  const props: ShellLayoutProps<Locale> = {
    children: <div>page-body</div>,
    navHeaderText: "Menu",
    navItems: [
      { type: "link", href: "/home", text: "Home" },
      { type: "link", href: "/events", text: "Events" },
    ],
    activeHref: "/home",
    onNavigate: vi.fn(),
    isAuthenticated: true,
    onSignOut: vi.fn(),
    locale: "ja",
    setLocale: vi.fn(),
    t: (key) => key,
    supportedLocales: ["ja", "en"],
    localeNames: LOCALE_NAMES,
    localeSwitcherAriaLabel: "switch language",
    ...overrides,
  };
  const view = render(<ShellLayout<Locale> {...props} />);
  const topNav = createWrapper(view.container).findTopNavigation();
  const sideNav = createWrapper(view.container).findSideNavigation();
  if (!topNav) throw new Error("TopNavigation not found");
  if (!sideNav) throw new Error("SideNavigation not found");
  return { ...view, props, topNav, sideNav };
}

describe("ShellLayout", () => {
  it("should render the page body in the content slot", () => {
    const { getByText } = renderShell();
    expect(getByText("page-body")).toBeInTheDocument();
  });

  it("should render the console identifier as the title and never truncate it behind the brand (#2662)", () => {
    const { topNav } = renderShell({ title: "Admin Console" });
    // 識別子だけを title に据える (ブランドは隣接の mark が担う)。`TenkaCloud ·` を前置しないので
    // Cloudscape の末尾省略が識別子を犠牲にしない。
    expect(topNav.findTitle()?.getElement()).toHaveTextContent("Admin Console");
    expect(topNav.findTitle()?.getElement().textContent).not.toContain("TenkaCloud");
    // context 表示時は mark が唯一のブランド表現なので accessible name を持つ。
    expect(topNav.findLogo()?.getElement()).toHaveAttribute("alt", "TenkaCloud");
  });

  it("should render the TenkaCloud brand lockup when the product title is omitted", () => {
    const { topNav } = renderShell();
    expect(topNav.findTitle()?.getElement()).toHaveTextContent("TenkaCloud");
    expect(topNav.findLogo()?.getElement()).toHaveAttribute("src", tenkaCloudAppIconDataUri);
    // context 無しでは wordmark が title に出るので、mark は重複回避で decorative (alt="")。
    expect(topNav.findLogo()?.getElement()).toHaveAttribute("alt", "");
  });

  it("should show only the locale switcher when unauthenticated", () => {
    const { topNav } = renderShell({ isAuthenticated: false });
    expect(topNav.findUtilities()).toHaveLength(1);
  });

  it("should show locale switcher + sign-out button when authenticated without a user menu", () => {
    const { topNav } = renderShell({ isAuthenticated: true, userMenu: undefined });
    const utilities = topNav.findUtilities();
    expect(utilities).toHaveLength(2);
    // 2 番目の utility は variant 無しの type:"button" = button-link type のサインアウト。
    expect(utilities[1]?.findButtonLinkType()).not.toBeNull();
  });

  it("should call onSignOut when the plain sign-out button is clicked", () => {
    const onSignOut = vi.fn();
    const { topNav } = renderShell({ onSignOut });
    topNav.findUtilities()[1]?.findButtonLinkType()?.click();
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("should render a user menu dropdown when userMenu is provided", () => {
    const { topNav } = renderShell({
      userMenu: { label: "alice@example.com", ariaLabel: "user menu", signOutLabel: "Sign out" },
    });
    const userMenu = topNav.findUtilities()[1]?.findMenuDropdownType();
    expect(userMenu).not.toBeNull();
    expect(userMenu?.findNativeButton().getElement().textContent).toContain("alice@example.com");
  });

  it("should call onSignOut when the user menu sign-out item is selected", () => {
    const onSignOut = vi.fn();
    const { topNav } = renderShell({
      onSignOut,
      userMenu: { label: "alice@example.com", ariaLabel: "user menu", signOutLabel: "Sign out" },
    });
    const userMenu = topNav.findUtilities()[1]?.findMenuDropdownType();
    userMenu?.openDropdown();
    userMenu?.findItemById("signout")?.click();
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("should call setLocale when a locale dropdown item is selected", () => {
    const setLocale = vi.fn();
    const { topNav } = renderShell({ setLocale });
    const localeMenu = topNav.findUtilities()[0]?.findMenuDropdownType();
    localeMenu?.openDropdown();
    localeMenu?.findItemById("en")?.click();
    expect(setLocale).toHaveBeenCalledWith("en");
  });

  it("should navigate (with preventDefault) when an internal nav link is followed", () => {
    const onNavigate = vi.fn();
    const { sideNav } = renderShell({ onNavigate });
    const link = sideNav.findLinkByHref("/events");
    expect(link).not.toBeNull();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link?.getElement().dispatchEvent(event);
    expect(onNavigate).toHaveBeenCalledWith("/events");
    expect(event.defaultPrevented).toBe(true);
  });

  it("should not navigate when an external nav link is followed", () => {
    const onNavigate = vi.fn();
    const { sideNav } = renderShell({
      onNavigate,
      navItems: [{ type: "link", href: "https://example.com", text: "External", external: true }],
    });
    const link = sideNav.findLinkByHref("https://example.com");
    expect(link).not.toBeNull();
    fireEvent.click(link?.getElement() as HTMLElement);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("should fall back to the locale code when it is missing from localeNames", () => {
    // localeNames が不完全でも UI を壊さず code 自身を表示する (防御的 fallback)。
    const { topNav } = renderShell({
      locale: "en",
      localeNames: { ja: "日本語" } as Record<Locale, string>,
    });
    expect(
      topNav.findUtilities()[0]?.findMenuDropdownType()?.findNativeButton().getElement()
        .textContent,
    ).toContain("en");
  });
});
