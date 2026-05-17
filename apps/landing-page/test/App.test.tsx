import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";
import type { AppConfig } from "../src/config";

const baseConfig: AppConfig = {
  waitlistFormUrl: null,
  participantPortalUrl: null,
  adminConsoleUrl: null,
  githubRepoUrl: "https://github.com/example/repo",
};

describe("LandingPage App", () => {
  it("ヒーロー見出しに TenkaCloud を表示するべき", () => {
    render(<App config={baseConfig} />);
    expect(screen.getByRole("heading", { level: 1, name: /TenkaCloud/ })).toBeInTheDocument();
  });

  it("Google Form 未設定なら waitlist セクションは案内 Alert を出すべき", () => {
    render(<App config={baseConfig} />);
    expect(screen.getByText(/Google Form 未設定/)).toBeInTheDocument();
  });

  it("Google Form URL が設定されていれば iframe を埋め込むべき", () => {
    const config: AppConfig = {
      ...baseConfig,
      waitlistFormUrl: "https://docs.google.com/forms/d/e/FORM_ID/viewform?embedded=true",
    };
    render(<App config={config} />);
    const iframe = screen.getByTitle(/TenkaCloud waitlist/);
    expect(iframe).toBeInTheDocument();
    expect(iframe.tagName.toLowerCase()).toBe("iframe");
  });

  it("waitlist CTA は formUrl が設定されているときだけ出すべき", () => {
    const { rerender } = render(<App config={baseConfig} />);
    expect(screen.queryByRole("link", { name: /ウェイトリストに登録/ })).toBeNull();
    rerender(
      <App
        config={{
          ...baseConfig,
          waitlistFormUrl: "https://docs.google.com/forms/d/e/FORM_ID/viewform?embedded=true",
        }}
      />,
    );
    expect(screen.getByRole("link", { name: /ウェイトリストに登録/ })).toBeInTheDocument();
  });
});
