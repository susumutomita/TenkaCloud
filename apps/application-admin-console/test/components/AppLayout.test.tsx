import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ShellLayout: TopNavigation (locale switcher + sign-in user menu / sign-out button) +
 * SideNavigation の shell。 未 sign-in (locale のみ) / sign-in+email (locale + user menu →
 * signout) / sign-in+no-email (locale + signout button) の 3 utility 状態、 locale 切替、
 * SideNavigation の link navigate を pin する。 useAuth / decodeIdToken / useI18n /
 * react-router を mock、 SUPPORTED_LOCALES は実物。 Cloudscape は test-utils で駆動。
 */
const { mockAuth, mockDecode, mockNav, mockSetLocale } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDecode: vi.fn(),
  mockNav: vi.fn(),
  mockSetLocale: vi.fn(),
}));

vi.mock("react-router", () => ({
  useLocation: () => ({ pathname: "/" }),
  useNavigate: () => mockNav,
}));
vi.mock("../../src/auth/AuthProvider", () => ({ useAuth: mockAuth }));
vi.mock("../../src/auth/claims", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/auth/claims")>();
  return { ...actual, decodeIdToken: mockDecode };
});
vi.mock("../../src/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/i18n")>();
  return {
    ...actual,
    useI18n: () => ({ locale: "ja", setLocale: mockSetLocale, t: (k: string) => k }),
  };
});

const { ShellLayout } = await import("../../src/components/AppLayout");

/** test-utils の finder は null を返しうるので、 見つからなければ即 fail させて型を狭める。 */
function must<T>(value: T | null | undefined, what: string): T {
  if (!value) throw new Error(`expected ${what} to exist`);
  return value;
}

const logout = vi.fn();
const renderShell = (educationGraphEnabled = false) =>
  render(<ShellLayout educationGraphEnabled={educationGraphEnabled}>child-content</ShellLayout>);
const topNav = (container: HTMLElement) =>
  must(createWrapper(container).findTopNavigation(), "top navigation");

beforeEach(() => {
  mockAuth.mockReturnValue({ tokens: null, logout });
  mockDecode.mockReturnValue(null);
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

  it("should group navigation by operator jobs and navigate via side links", () => {
    mockAuth.mockReturnValue({ tokens: { idToken: "tok" }, logout });
    mockDecode.mockReturnValue({ "custom:userRole": "TenantAdmin" });
    // Education graph nav is feature-flagged (default OFF); enable it so this test can
    // exercise its side link. Default-off visibility is covered in AppLayout.education-graph.test.
    const { container } = renderShell(true);
    expect(container).toHaveTextContent("nav.event_ops_section");
    expect(container).toHaveTextContent("nav.content_section");

    const problemsLink = must(
      must(createWrapper(container).findSideNavigation(), "side nav").findLinkByHref("/problems"),
      "problems link",
    );
    problemsLink.click();
    expect(mockNav).toHaveBeenCalledWith("/problems");
    mockNav.mockClear();
    const educationGraphLink = must(
      must(createWrapper(container).findSideNavigation(), "side nav").findLinkByHref(
        "/education-graph",
      ),
      "education graph link",
    );
    educationGraphLink.click();
    expect(mockNav).toHaveBeenCalledWith("/education-graph");
    mockNav.mockClear();
    const usersLink = must(
      must(createWrapper(container).findSideNavigation(), "side nav").findLinkByHref("/users"),
      "users link",
    );
    usersLink.click();
    expect(mockNav).toHaveBeenCalledWith("/users");
  });

  it("should hide the TenantAdmin-only education graph from operators and viewers", () => {
    mockAuth.mockReturnValue({ tokens: { idToken: "tok" }, logout });
    mockDecode.mockReturnValue({ "custom:userRole": "TenantOperator" });
    const { container } = renderShell();

    expect(
      createWrapper(container).findSideNavigation()?.findLinkByHref("/education-graph"),
    ).toBeFalsy();
  });

  it("should show the Identity providers nav link only when samlSsoEnabled is true", () => {
    const idpLink = (c: HTMLElement) =>
      createWrapper(c).findSideNavigation()?.findLinkByHref("/identity-providers");
    const off = render(<ShellLayout>child-content</ShellLayout>);
    expect(idpLink(off.container)).toBeFalsy();
    const on = render(<ShellLayout samlSsoEnabled>child-content</ShellLayout>);
    expect(idpLink(on.container)).toBeTruthy();
  });

  it("should show the user menu and sign out when an email claim is present", () => {
    mockAuth.mockReturnValue({ tokens: { idToken: "tok" }, logout });
    mockDecode.mockReturnValue({ email: "user@example.com" });
    const { container } = renderShell();
    // utilities = [locale(1), userMenu(2)]
    const userMenu = must(
      must(topNav(container).findUtility(2), "utility 2").findMenuDropdownType(),
      "user menu",
    );
    userMenu.openDropdown();
    must(userMenu.findItemById("signout"), "signout item").click();
    expect(logout).toHaveBeenCalled();
    expect(mockNav).toHaveBeenCalledWith("/login");
  });

  it("should show a plain sign-out button when signed in without an email claim", () => {
    mockAuth.mockReturnValue({ tokens: { idToken: "tok" }, logout });
    mockDecode.mockReturnValue(null); // no email → userMenuUtility undefined
    const { container } = renderShell();
    // utilities = [locale(1), signout-button(2)]
    const signout = must(
      must(topNav(container).findUtility(2), "utility 2").findButtonLinkType(),
      "signout button",
    );
    signout.click();
    expect(logout).toHaveBeenCalled();
    expect(mockNav).toHaveBeenCalledWith("/login");
  });
});
