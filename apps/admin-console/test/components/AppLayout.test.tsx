import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * System Admin console の shell: TopNavigation (手動更新 + locale switcher + サインアウト) +
 * SideNavigation。 未 sign-in (locale のみ) / sign-in (refresh + locale + signout) の utility
 * 状態、 locale 切替、 SideNavigation の link navigate、 samlSso flag による nav 出し分け、
 * そして「最新の状態に更新」が route content を remount することを pin する。
 * useAuth / useI18n / react-router を mock、 SUPPORTED_LOCALES は実物。 Cloudscape は
 * test-utils で駆動する ([[feedback_cloudscape_multiselect_testutils]])。
 */
const { mockAuth, mockNav, mockSetLocale } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockNav: vi.fn(),
  mockSetLocale: vi.fn(),
}));

vi.mock("react-router", () => ({
  useLocation: () => ({ pathname: "/tenants" }),
  useNavigate: () => mockNav,
}));
vi.mock("../../src/auth/AuthProvider", () => ({ useAuth: mockAuth }));
vi.mock("../../src/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/i18n")>();
  return {
    ...actual,
    useI18n: () => ({ locale: "ja", setLocale: mockSetLocale, t: (key: string) => key }),
  };
});

const { ShellLayout } = await import("../../src/components/AppLayout");

/** test-utils の finder は null を返しうるので、 見つからなければ即 fail させて型を狭める。 */
function must<T>(value: T | null | undefined, what: string): T {
  if (!value) throw new Error(`expected ${what} to exist`);
  return value;
}

const logout = vi.fn();
const renderShell = () => render(<ShellLayout>child-content</ShellLayout>);
const topNav = (container: HTMLElement) =>
  must(createWrapper(container).findTopNavigation(), "top navigation");
const sideNav = (container: HTMLElement) =>
  must(createWrapper(container).findSideNavigation(), "side navigation");

beforeEach(() => {
  mockAuth.mockReturnValue({ tokens: null, logout });
  mockNav.mockClear();
  mockSetLocale.mockClear();
  logout.mockClear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("ShellLayout", () => {
  it("should render the page content and the console title", () => {
    const { container } = renderShell();
    expect(container).toHaveTextContent("child-content");
    expect(topNav(container).findTitle()?.getElement()).toHaveTextContent("app.title");
  });

  it("should render only the locale switcher when signed out and switch the locale", () => {
    const { container } = renderShell();
    const localeMenu = must(
      must(topNav(container).findUtility(1), "utility 1").findMenuDropdownType(),
      "locale menu",
    );
    localeMenu.openDropdown();
    must(localeMenu.findItemById("en"), "en item").click();
    expect(mockSetLocale).toHaveBeenCalledWith("en");
  });

  it("should not offer the refresh action while signed out", () => {
    const { container } = renderShell();
    // utilities = [locale(1)] のみ。 未認証で更新ボタンを出しても叩ける data が無い。
    expect(topNav(container).findUtility(2)).toBeFalsy();
  });

  it("should expose a header refresh action that remounts the current route content", () => {
    mockAuth.mockReturnValue({ tokens: { idToken: "tok" }, logout });
    let mountCount = 0;
    function RouteContent() {
      const [mountId] = useState(() => ++mountCount);
      return <span>route-mount-{mountId}</span>;
    }
    const { container } = render(
      <ShellLayout>
        <RouteContent />
      </ShellLayout>,
    );

    expect(container).toHaveTextContent("route-mount-1");
    // utilities = [refresh(1), locale(2), signout(3)]
    const refresh = must(
      must(topNav(container).findUtility(1), "refresh utility").findButtonLinkType(),
      "refresh button",
    );
    expect(refresh.getElement()).toHaveTextContent("nav.refresh_latest");
    refresh.click();
    // remount = page 側の useEffect / usePolling の初回 fetch が再実行される。
    expect(container).toHaveTextContent("route-mount-2");
  });

  it("should sign out and return to the login route", () => {
    mockAuth.mockReturnValue({ tokens: { idToken: "tok" }, logout });
    const { container } = renderShell();
    const signout = must(
      must(topNav(container).findUtility(3), "utility 3").findButtonLinkType(),
      "signout button",
    );
    signout.click();
    expect(logout).toHaveBeenCalled();
    expect(mockNav).toHaveBeenCalledWith("/login");
  });

  it("should navigate via side navigation links", () => {
    const { container } = renderShell();
    must(sideNav(container).findLinkByHref("/usage"), "usage link").click();
    expect(mockNav).toHaveBeenCalledWith("/usage");
    mockNav.mockClear();
    must(sideNav(container).findLinkByHref("/operations"), "operations link").click();
    expect(mockNav).toHaveBeenCalledWith("/operations");
  });

  it("should show the Identity providers nav link only when samlSsoEnabled is true", () => {
    const idpLink = (c: HTMLElement) =>
      createWrapper(c).findSideNavigation()?.findLinkByHref("/identity-providers");
    const off = render(<ShellLayout>child-content</ShellLayout>);
    expect(idpLink(off.container)).toBeFalsy();
    const on = render(<ShellLayout samlSsoEnabled>child-content</ShellLayout>);
    expect(idpLink(on.container)).toBeTruthy();
  });
});
