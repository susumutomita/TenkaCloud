import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProblemAuthors } from "../src/ProblemAuthors";

describe("ProblemAuthors", () => {
  it("renders nothing for legacy problems", () => {
    const { container } = render(<ProblemAuthors label="作者" />);
    expect(container).toBeEmptyDOMElement();
  });
  it("renders escaped Japanese and long names and safe links for co-authors", () => {
    const longName = "共同作者".repeat(100);
    const { container } = render(
      <ProblemAuthors
        label="作者"
        authors={[
          { name: "山田 <script>悪意</script>", profileUrl: "https://example.com/" },
          { name: longName },
          { name: "不正リンク", profileUrl: ["javascript", "alert(1)"].join(":") },
        ]}
      />,
    );
    const link = screen.getByRole("link", { name: "山田 <script>悪意</script>" });
    expect(link).toHaveAttribute("href", "https://example.com/");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByText(longName, { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/不正リンク/)).toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(container.querySelector("script")).toBeNull();
    expect(container.firstChild).toHaveStyle({ overflowWrap: "anywhere" });
  });
});
