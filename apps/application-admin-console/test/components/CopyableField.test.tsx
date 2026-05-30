import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopyableField } from "../../src/components/CopyableField";

/**
 * CopyableField (1-click copy 付き値表示, #662) の render + copy → ✓ feedback → 2 秒後 reset を
 * pin する。 navigator.clipboard を stub。
 */
const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  writeText.mockClear();
});

afterEach(() => vi.useRealTimers());

describe("CopyableField", () => {
  it("should render the value and copy it on click, then reset the icon after 2s", async () => {
    vi.useFakeTimers();
    render(<CopyableField value="acct-123" ariaLabel="Copy account id" valueClassName="break" />);
    expect(screen.getByText("acct-123")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy account id" }));
      await Promise.resolve(); // flush onCopy → setCopied(true)
    });
    expect(writeText).toHaveBeenCalledWith("acct-123");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000); // setTimeout → setCopied(false)
    });
    // value / button still present (no crash through the copied→reset cycle)
    expect(screen.getByRole("button", { name: "Copy account id" })).toBeInTheDocument();
  });
});
