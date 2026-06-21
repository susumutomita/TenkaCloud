import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductLoginShell } from "../../src/components/ProductLoginShell";

/**
 * ProductLoginShell (Application Plane sign-in, ConsoleAuthShell-based). idle (SSO button)
 * vs signing-in (redirect spinner) / error-line 有無 / JA-EN トグル (ja active・click で
 * setLocale) / SSO button の onSignIn を pin する。 useI18n / useT を mock。
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
  it("should render the SSO button (idle), the error line, fire onSignIn, and switch locale", () => {
    const p = props({ errorMessage: "boom" });
    render(<ProductLoginShell {...p} />);
    expect(screen.getByText("Login Title")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument(); // error line
    expect(screen.getByRole("button", { name: "JA" })).toHaveClass("on");
    const en = screen.getByRole("button", { name: "EN" });
    expect(en).not.toHaveClass("on");
    fireEvent.click(en);
    expect(mockSetLocale).toHaveBeenCalledWith("en");
    fireEvent.click(screen.getByRole("button", { name: /Sign in/ }));
    expect(p.onSignIn).toHaveBeenCalled();
  });

  it("should show the redirect spinner (no SSO button / no error) while signing in", () => {
    render(<ProductLoginShell {...props({ signingIn: true })} />);
    expect(screen.getByText("Redirecting…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sign in/ })).not.toBeInTheDocument();
    expect(screen.queryByText("login.error_header")).not.toBeInTheDocument();
  });
});
