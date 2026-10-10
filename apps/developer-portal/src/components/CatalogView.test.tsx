import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CATALOG_DATA } from "@/content/catalog-data";
import * as catalog from "@/lib/catalog";
import { CatalogView } from "./CatalogView";

afterEach(cleanup);

describe("CatalogView", () => {
  it("should render the Japanese catalog heading and a known problem id", () => {
    render(<CatalogView locale="ja" />);
    expect(screen.getByRole("heading", { level: 1, name: "問題カタログ" })).toBeInTheDocument();
    // Every generated problem id is rendered as a card subtitle.
    const anId = CATALOG_DATA.problems[0]?.id ?? "";
    expect(screen.getByText(anId, { selector: "code" })).toBeInTheDocument();
  });

  it("should render a card for every public problem", () => {
    render(<CatalogView locale="ja" />);
    expect(screen.getAllByRole("article")).toHaveLength(CATALOG_DATA.problems.length);
    for (const problem of CATALOG_DATA.problems) {
      // Tags may share an ID's text; only the card's ID is its identity.
      expect(screen.getByText(problem.id, { selector: "code" })).toBeInTheDocument();
    }
  });

  it("should badge ready problems as Available and draft problems as In development (EN)", () => {
    render(<CatalogView locale="en" />);
    const hasReady = CATALOG_DATA.problems.some((problem) => problem.status === "ready");
    const hasDraft = CATALOG_DATA.problems.some((problem) => problem.status === "draft");
    if (hasReady) {
      expect(screen.getAllByText("Available").length).toBeGreaterThan(0);
    }
    if (hasDraft) {
      expect(screen.getAllByText("In development").length).toBeGreaterThan(0);
    }
  });

  it("should switch language to the English catalog mirror", () => {
    render(<CatalogView locale="ja" />);
    expect(screen.getByRole("link", { name: "English" })).toHaveAttribute("href", "/en/catalog/");
  });

  it("should show the localized problem name for the active locale", () => {
    const bilingual = CATALOG_DATA.problems.find((problem) => problem.name.ja !== problem.name.en);
    if (bilingual === undefined) {
      return;
    }
    render(<CatalogView locale="en" />);
    expect(screen.getByText(bilingual.name.en)).toBeInTheDocument();
  });
});

it("renders explicit co-author credits on public cards in either locale", () => {
  vi.spyOn(catalog, "groupedCatalog").mockReturnValue([
    {
      category: "Challenge",
      problems: [
        {
          id: "credited",
          category: "Challenge",
          status: "ready",
          difficulty: 1,
          tags: [],
          name: { ja: "問題", en: "Problem" },
          authors: [
            { name: "問題作者", profileUrl: "https://example.com/profile" },
            { name: "共同作者" },
          ],
        },
      ],
    },
  ]);
  try {
    const { rerender } = render(<CatalogView locale="ja" />);
    expect(screen.getByRole("link", { name: "問題作者" })).toHaveAttribute(
      "href",
      "https://example.com/profile",
    );
    expect(screen.getByText(/共同作者/)).toBeInTheDocument();
    rerender(<CatalogView locale="en" />);
    expect(screen.getByText("Authors:")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "問題作者" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
  } finally {
    vi.restoreAllMocks();
  }
});
