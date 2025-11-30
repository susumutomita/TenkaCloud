import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import RootLayout from "../layout";

describe("RootLayout コンポーネント", () => {
  it("children を正しくレンダリングすべき", () => {
    render(
      <RootLayout>
        <div>テストコンテンツ</div>
      </RootLayout>,
    );
    expect(screen.getByText("テストコンテンツ")).toBeInTheDocument();
  });

  it('html 要素に lang="ja" を設定すべき', () => {
    const { container } = render(
      <RootLayout>
        <div>テスト</div>
      </RootLayout>,
    );
    const html = container.closest("html");
    expect(html).toHaveAttribute("lang", "ja");
  });

  it("body 要素内に children を配置すべき", () => {
    render(
      <RootLayout>
        <div data-testid="child">子要素</div>
      </RootLayout>,
    );
    const child = screen.getByTestId("child");
    expect(child.closest("body")).toBeInTheDocument();
  });
});
