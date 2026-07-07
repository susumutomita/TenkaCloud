import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const pathnameMock = vi.fn(() => "/" as string | null);
vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock(),
}));

import { HeaderLangSwitch } from "./HeaderLangSwitch";

afterEach(cleanup);

describe("HeaderLangSwitch", () => {
  it("should mark JA current and link English to the page's EN mirror on a JA route", () => {
    pathnameMock.mockReturnValue("/catalog/");
    render(<HeaderLangSwitch />);
    const ja = screen.getByRole("link", { name: "日本語" });
    const en = screen.getByRole("link", { name: "English" });
    expect(ja).toHaveAttribute("aria-current", "page");
    expect(ja).toHaveAttribute("href", "/catalog/");
    expect(en).toHaveAttribute("href", "/en/catalog/");
    expect(en).not.toHaveAttribute("aria-current");
  });

  it("should mark EN current and link 日本語 to the page's JA mirror on an EN route", () => {
    pathnameMock.mockReturnValue("/en/catalog/");
    render(<HeaderLangSwitch />);
    const ja = screen.getByRole("link", { name: "日本語" });
    const en = screen.getByRole("link", { name: "English" });
    expect(en).toHaveAttribute("aria-current", "page");
    expect(en).toHaveAttribute("href", "/en/catalog/");
    expect(ja).toHaveAttribute("href", "/catalog/");
  });

  it("should fall back to the JA home when usePathname returns null", () => {
    pathnameMock.mockReturnValue(null);
    render(<HeaderLangSwitch />);
    expect(screen.getByRole("link", { name: "日本語" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "English" })).toHaveAttribute("href", "/en/");
  });
});
