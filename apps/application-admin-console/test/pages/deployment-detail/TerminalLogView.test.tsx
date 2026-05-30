import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LogLine } from "../../../src/lib/deploy-phases";
import { TerminalLogView } from "../../../src/pages/deployment-detail/TerminalLogView";

/**
 * TerminalLogView の行 key 生成。 同一 (timestamp|header|text) が 2 回現れたとき、
 * 2 行目以降は `#1` suffix を付けて key を一意化する (dup>0 経路)。
 */
describe("TerminalLogView", () => {
  it("should render every line including exact duplicates with unique keys", () => {
    const dup: LogLine = { header: false, timestamp: "2026-06-01T00:00:00Z", text: "same line" };
    const lines: readonly LogLine[] = [
      { header: true, timestamp: "2026-06-01T00:00:00Z", text: "section" },
      dup,
      dup, // 完全重複 → key は `...#1` に分岐 (dup>0)。
    ];
    render(<TerminalLogView lines={lines} />);
    expect(screen.getByTestId("terminal-log")).toBeInTheDocument();
    // 重複行も両方描画される (行番号 002 / 003)。
    expect(screen.getAllByText("same line")).toHaveLength(2);
  });

  it("should render a line that has no timestamp", () => {
    render(<TerminalLogView lines={[{ header: false, text: "no ts" }]} />);
    expect(screen.getByText("no ts")).toBeInTheDocument();
  });
});
