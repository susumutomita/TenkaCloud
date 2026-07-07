import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CATALOG_DATA } from "@/content/catalog-data";
import { CatalogView } from "./CatalogView";

afterEach(cleanup);

describe("CatalogView", () => {
  it("should render the Japanese catalog heading and a known problem id", () => {
    render(<CatalogView locale="ja" />);
    expect(screen.getByRole("heading", { level: 1, name: "問題カタログ" })).toBeInTheDocument();
    // Every generated problem id is rendered as a card subtitle.
    const anId = CATALOG_DATA.problems[0]?.id ?? "";
    expect(screen.getByText(anId)).toBeInTheDocument();
  });

  it("should render a card for every public problem", () => {
    render(<CatalogView locale="ja" />);
    for (const problem of CATALOG_DATA.problems) {
      expect(screen.getByText(problem.id)).toBeInTheDocument();
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
