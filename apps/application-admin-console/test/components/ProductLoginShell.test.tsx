import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductLoginShell } from "../../src/components/ProductLoginShell";

/**
 * Issue #1329: ProductLoginShell (Cognito redirect 前のログイン shell)。 idle (sign-in button) vs
 * signing-in (spinner) / error alert 有無 / locale switcher (ja active・en inactive + click で
 * setLocale) / sign-in button の onSignIn を pin する。 useI18n / useT を mock、 SUPPORTED_LOCALES
 * は実物。
 */
const { mockSetLocale } = vi.hoisted(() => ({ mockSetLocale: vi.fn() }));
vi.mock("../../src/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/i18n")>();
  return {
    ...actual,
    useT: () => (k: string) => k,
    useI18n: () => ({ locale: "ja", setLocale: mockSetLocale, t: (k: string) => k }),
  };
});

const props = (over: Partial<Parameters<typeof ProductLoginShell>[0]> = {}) => ({
  title: "Login Title",
  subtitle: "Login Subtitle",
  signInLabel: "Sign in",
  signingInLabel: "Redirecting…",
  signingIn: false,
  errorMessage: undefined,
  onSignIn: vi.fn(),
  ...over,
});

afterEach(() => vi.clearAllMocks());

describe("ProductLoginShell", () => {
  it("should render the sign-in button (idle), fire onSignIn, and switch locale", () => {
    const p = props({ errorMessage: "boom" });
    render(<ProductLoginShell {...p} />);
    expect(screen.getByText("Login Title")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument(); // error alert
    // locale switcher: ja active / en inactive。
    expect(screen.getByRole("button", { name: "日本語" })).toHaveAttribute("aria-pressed", "true");
    const en = screen.getByRole("button", { name: "English" });
    expect(en).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(en);
    expect(mockSetLocale).toHaveBeenCalledWith("en");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(p.onSignIn).toHaveBeenCalled();
  });

  it("should show the spinner (no sign-in button / no error) while signing in", () => {
    render(<ProductLoginShell {...props({ signingIn: true })} />);
    expect(screen.getByText("Redirecting…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
    expect(screen.queryByText("login.error_header")).not.toBeInTheDocument();
  });
});
