import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type ConsoleAuthCopy, ConsoleAuthShell } from "../src/ConsoleAuthShell";

/**
 * ConsoleAuthShell (= 2 管理 console 共有の sign-in 二段組 shell) の振る舞いを固定する。
 * 検証観点: plane ごとの装飾 opcard (system=tenants / app=counters) / JA-EN トグルが
 * onLocale を呼ぶ / foot 有無 / children (= step area) の描画。
 */
const copy: ConsoleAuthCopy = {
  planeLabel: "Control Plane",
  eyebrow: "SYSTEM ADMIN",
  headlineLead: "Operate the platform, ",
  headlineEm: "from one console.",
  lede: "Govern the whole control plane.",
  kicker: "System admin",
  title: "System Admin Console",
  subtitle: "Sign in with your platform administrator account.",
  footEvent: "ap-northeast-1 · control-plane",
};

function renderShell(over: Partial<Parameters<typeof ConsoleAuthShell>[0]> = {}) {
  const onLocale = vi.fn();
  render(
    <ConsoleAuthShell plane="system" copy={copy} locale="ja" onLocale={onLocale} {...over}>
      <button type="button">step-area</button>
    </ConsoleAuthShell>,
  );
  return { onLocale };
}

describe("ConsoleAuthShell", () => {
  it("should render the system stage with the decorative tenants card", () => {
    renderShell();
    expect(screen.getByText("Control Plane")).toBeInTheDocument();
    expect(screen.getByText("System Admin Console")).toBeInTheDocument();
    expect(screen.getByText("from one console.")).toBeInTheDocument();
    expect(screen.getByText("TENANTS")).toBeInTheDocument();
    expect(screen.getByText("acme-corp")).toBeInTheDocument();
    expect(screen.getByText("step-area")).toBeInTheDocument();
  });

  it("should render the app stage with the decorative deploy counters card", () => {
    renderShell({ plane: "app" });
    expect(screen.getByText("OPEN ARENA · SEASON 01")).toBeInTheDocument();
    expect(screen.getByText("16 teams")).toBeInTheDocument();
    expect(screen.getByText("COMPLETE")).toBeInTheDocument();
    // system-only content is not rendered for the app plane.
    expect(screen.queryByText("TENANTS")).not.toBeInTheDocument();
  });

  it("should mark the active locale and call onLocale on toggle", () => {
    const { onLocale } = renderShell();
    expect(screen.getByRole("button", { name: "JA" })).toHaveClass("on");
    fireEvent.click(screen.getByRole("button", { name: "EN" }));
    expect(onLocale).toHaveBeenCalledWith("en");
    fireEvent.click(screen.getByRole("button", { name: "JA" }));
    expect(onLocale).toHaveBeenCalledWith("ja");
  });

  it("should render an optional footer when provided and omit it otherwise", () => {
    const { unmount } = render(
      <ConsoleAuthShell
        plane="system"
        copy={copy}
        locale="en"
        onLocale={vi.fn()}
        foot={<span>operator-foot</span>}
      >
        <span>child</span>
      </ConsoleAuthShell>,
    );
    expect(screen.getByText("operator-foot")).toBeInTheDocument();
    unmount();
    renderShell();
    expect(screen.queryByText("operator-foot")).not.toBeInTheDocument();
  });
});
