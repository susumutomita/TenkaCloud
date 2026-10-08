import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ScrollableProblemList } from "../../../src/pages/event-create/ScrollableProblemList";

vi.mock("../../../src/i18n", () => ({ useT: () => (key: string) => key }));
afterEach(() => vi.unstubAllGlobals());

it("shows only real continuation, updates for scrolling and resize, and releases its observer", () => {
  let resized: (() => void) | undefined;
  const disconnected = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe = vi.fn();
      disconnect = disconnected;
    },
  );
  const { unmount } = render(
    <ScrollableProblemList label="Problems">
      <div>items</div>
    </ScrollableProblemList>,
  );
  const region = screen.getByRole("region", { name: "Problems" });
  expect(region).toHaveAttribute("tabindex", "0");
  expect(screen.queryByText(/more_below/)).not.toBeInTheDocument();
  Object.defineProperty(region, "clientHeight", { configurable: true, value: 100 });
  Object.defineProperty(region, "scrollHeight", { configurable: true, value: 300 });
  act(() => resized?.());
  expect(screen.getByText(/more_below/)).toBeInTheDocument();
  expect(screen.queryByText(/more_above/)).not.toBeInTheDocument();
  region.scrollTop = 199.5;
  fireEvent.scroll(region);
  expect(screen.queryByText(/more_below/)).not.toBeInTheDocument();
  expect(screen.getByText(/more_above/)).toBeInTheDocument();
  region.scrollTop = 0;
  Object.defineProperty(region, "scrollHeight", { configurable: true, value: 90 });
  act(() => resized?.());
  expect(screen.queryByText(/more_above|more_below/)).not.toBeInTheDocument();
  unmount();
  expect(disconnected).toHaveBeenCalledOnce();
});
