import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OneTimeSecretCopyButton } from "../../src/components/OneTimeSecretCopyButton";

const labels = {
  copyLabel: "Copy secret",
  copyingLabel: "Copying",
  copiedLabel: "Copied",
  failedLabel: "Copy failed",
};

afterEach(() => vi.clearAllMocks());

describe("OneTimeSecretCopyButton", () => {
  it("should keep the caller busy until clipboard success feedback is visible", async () => {
    let finishCopy: (() => void) | undefined;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCopy = resolve;
        }),
    );
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const onPendingChange = vi.fn();
    render(
      <OneTimeSecretCopyButton
        {...labels}
        textToCopy="ONE-TIME-SECRET"
        onPendingChange={onPendingChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy secret" }));
    expect(writeText).toHaveBeenCalledWith("ONE-TIME-SECRET");
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole("button", { name: "Copying" })).toBeDisabled();

    finishCopy?.();
    expect(await screen.findByRole("button", { name: "Copied" })).toBeEnabled();
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
  });

  it("should show copy failure and release the caller so the operator can retry", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const onPendingChange = vi.fn();
    render(
      <OneTimeSecretCopyButton
        {...labels}
        textToCopy="ONE-TIME-SECRET"
        onPendingChange={onPendingChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy secret" }));

    expect(await screen.findByRole("button", { name: "Copy failed" })).toBeEnabled();
    await waitFor(() => expect(onPendingChange).toHaveBeenLastCalledWith(false));
  });

  it("should show copy failure when the Clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    render(<OneTimeSecretCopyButton {...labels} textToCopy="ONE-TIME-SECRET" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy secret" }));

    expect(await screen.findByRole("button", { name: "Copy failed" })).toBeEnabled();
  });

  it("should not start a copy while its owner is busy", () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<OneTimeSecretCopyButton {...labels} textToCopy="ONE-TIME-SECRET" disabled />);

    fireEvent.click(screen.getByRole("button", { name: "Copy secret" }));

    expect(writeText).not.toHaveBeenCalled();
  });
});
