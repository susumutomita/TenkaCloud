import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DocsSidebar } from "./DocsSidebar";

afterEach(cleanup);

describe("DocsSidebar", () => {
  it("should render the use-existing-pack organizer page in the Operate section", () => {
    render(<DocsSidebar />);

    const nav = screen.getByRole("navigation", { name: "Docs" });
    const useExistingPack = within(nav).getByRole("link", { name: "Use an existing pack" });

    expect(useExistingPack).toHaveAttribute("href", "/developers/docs/operate/use-existing-pack/");
    expect(useExistingPack.closest("div")).toHaveTextContent("Operate");
    expect(useExistingPack.closest("li")).toHaveTextContent("Preview");
  });
});
