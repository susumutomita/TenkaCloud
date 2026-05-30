import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HandoffSection } from "../../../src/pages/deployment-detail/HandoffSection";

const t = (key: string) => key;

afterEach(() => vi.clearAllMocks());

describe("HandoffSection", () => {
  it("should render the team login key and copy it to the clipboard", () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<HandoffSection teamLoginKey="LOGIN-KEY-123" t={t} />);
    expect(screen.getByText("LOGIN-KEY-123")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "deployment_detail.copy_login_key_aria" }));
    expect(writeText).toHaveBeenCalledWith("LOGIN-KEY-123");
  });

  it("should not throw when the clipboard API is unavailable", () => {
    // navigator.clipboard を undefined にして optional-chain の short-circuit を踏む。
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    render(<HandoffSection teamLoginKey="LOGIN-KEY-123" t={t} />);
    fireEvent.click(screen.getByRole("button", { name: "deployment_detail.copy_login_key_aria" }));
    expect(screen.getByText("LOGIN-KEY-123")).toBeInTheDocument(); // no crash
  });
});
