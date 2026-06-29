import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CommandSearch } from "./CommandSearch";

// jsdom does not implement <dialog>.showModal/close; provide minimal shims so the
// command palette can open and the focus contract can be asserted.
beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.open = true;
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function close() {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    };
  }
});

afterEach(cleanup);

describe("CommandSearch", () => {
  it("should move keyboard focus to the search input when opened with the shortcut", async () => {
    const user = userEvent.setup();
    render(<CommandSearch />);

    await user.keyboard("{Meta>}k{/Meta}");

    const input = screen.getByRole("searchbox", { name: "Search docs and API operations" });
    expect(input).toHaveFocus();
  });

  it("should find docs headings and body content", async () => {
    const user = userEvent.setup();
    render(<CommandSearch />);
    await user.click(screen.getByRole("button", { name: "Open search" }));

    const input = screen.getByRole("searchbox", { name: "Search docs and API operations" });
    await user.type(input, "scoring kinds");

    // A docs heading result.
    expect(screen.getByText(/Scoring kinds/)).toBeInTheDocument();
  });

  it("should find API operation names", async () => {
    const user = userEvent.setup();
    render(<CommandSearch />);
    await user.click(screen.getByRole("button", { name: "Open search" }));

    const input = screen.getByRole("searchbox", { name: "Search docs and API operations" });
    await user.type(input, "listPacks");

    expect(screen.getByText("GET /packs")).toBeInTheDocument();
  });
});
