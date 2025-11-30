import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SettingsPage from "../page";

describe("SettingsPage コンポーネント", () => {
  it("タイトルを表示すべき", () => {
    render(<SettingsPage />);
    expect(screen.getByText("設定")).toBeInTheDocument();
  });

  it("説明文を表示すべき", () => {
    render(<SettingsPage />);
    expect(
      screen.getByText("プラットフォームの設定を管理します"),
    ).toBeInTheDocument();
  });

  it("準備中メッセージを表示すべき", () => {
    render(<SettingsPage />);
    expect(screen.getByText("準備中です")).toBeInTheDocument();
  });

  it("コンテンツカードのスタイルが正しいべき", () => {
    const { container } = render(<SettingsPage />);
    const card = container.querySelector(".rounded-lg");
    expect(card).toBeInTheDocument();
    expect(card).toHaveClass("border");
  });
});
