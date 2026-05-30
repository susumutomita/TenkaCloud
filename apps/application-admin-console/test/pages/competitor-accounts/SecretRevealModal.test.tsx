import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateCompetitorAccountResponse } from "../../../src/api/competitor-accounts-client";
import { SecretRevealModal } from "../../../src/pages/competitor-accounts/SecretRevealModal";

/**
 * SecretRevealModal: secret null → 非表示、 secret あり → launch button / copy-all / manual
 * (CopyableField) を描画。 copy-all で payload を clipboard へ + ✓ feedback → 2 秒で reset。
 * templateUrl の有無で manual link を切替。 useT は安定 echo、 competitor-bootstrap lib は実物。
 */
vi.mock("../../../src/i18n", () => {
  const t = (key: string) => key;
  return { useT: () => t };
});

const secret: CreateCompetitorAccountResponse = {
  tenkaCloudAccountId: "999988887777",
  externalId: "ext-abc",
  competitorRoleName: "TenkaCompetitorRole",
} as CreateCompetitorAccountResponse;

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  writeText.mockClear();
});

afterEach(() => vi.useRealTimers());

describe("SecretRevealModal", () => {
  it("should render nothing when secret is null", () => {
    const { container } = render(<SecretRevealModal secret={null} onDismiss={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("should reveal the secret fields, launch button, and dismiss", () => {
    const onDismiss = vi.fn();
    render(<SecretRevealModal secret={secret} onDismiss={onDismiss} />);
    expect(screen.getByText("competitor_accounts.secret_modal_header")).toBeInTheDocument();
    expect(screen.getByText("999988887777")).toBeInTheDocument(); // CopyableField value
    expect(screen.getByText("ext-abc")).toBeInTheDocument();
    // launch は href 付き Button = link role。
    expect(
      screen.getByRole("link", { name: "competitor_accounts.secret_modal_launch_button" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "competitor_accounts.secret_modal_close" }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("should copy the full payload and flip to the done state, then reset after 2s", async () => {
    vi.useFakeTimers();
    render(<SecretRevealModal secret={secret} onDismiss={vi.fn()} />);
    fireEvent.click(
      screen.getByRole("button", { name: "competitor_accounts.secret_modal_copy_all" }),
    );
    await act(async () => {
      await Promise.resolve(); // flush onCopyAll → setAllCopied(true)
    });
    expect(writeText).toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "competitor_accounts.secret_modal_copy_done" }),
    ).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000); // reset
    });
    expect(
      screen.getByRole("button", { name: "competitor_accounts.secret_modal_copy_all" }),
    ).toBeInTheDocument();
  });

  it("should use the supplied templateUrl for the manual download link", () => {
    render(
      <SecretRevealModal
        secret={secret}
        onDismiss={vi.fn()}
        templateUrl="https://custom.example.com/bootstrap.yaml"
      />,
    );
    const link = screen.getByRole("link", { name: "competitor-bootstrap.yaml (raw)" });
    expect(link).toHaveAttribute("href", "https://custom.example.com/bootstrap.yaml");
  });
});
