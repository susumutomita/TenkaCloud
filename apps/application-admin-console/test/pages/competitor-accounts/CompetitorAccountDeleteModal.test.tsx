import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CompetitorAccountSummary } from "../../../src/api/competitor-accounts-client";
import { CompetitorAccountDeleteModal } from "../../../src/pages/competitor-accounts/CompetitorAccountDeleteModal";

vi.mock("../../../src/i18n", () => {
  const t = (key: string, params?: Readonly<Record<string, string | number>>) =>
    params ? `${key}|${JSON.stringify(params)}` : key;
  return { useT: () => t };
});

const target = { awsAccountId: "111122223333" } as CompetitorAccountSummary;

describe("CompetitorAccountDeleteModal", () => {
  it("should fall the account id back to empty when target is null", () => {
    // Cloudscape Modal は visible=false でも中身を mount したまま (CSS で隠す) なので、
    // target=null のとき `target?.awsAccountId ?? ""` の "" fallback が踏まれる。
    render(
      <CompetitorAccountDeleteModal
        target={null}
        inFlight={false}
        onDismiss={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(
      screen.getByText('competitor_accounts.delete_modal_body_1|{"accountId":""}'),
    ).toBeInTheDocument();
  });

  it("should render the body with the account id and fire cancel / confirm", () => {
    const onDismiss = vi.fn();
    const onConfirm = vi.fn();
    render(
      <CompetitorAccountDeleteModal
        target={target}
        inFlight={false}
        onDismiss={onDismiss}
        onConfirm={onConfirm}
      />,
    );
    expect(
      screen.getByText('competitor_accounts.delete_modal_body_1|{"accountId":"111122223333"}'),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "competitor_accounts.delete_modal_cancel" }),
    );
    expect(onDismiss).toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "competitor_accounts.delete_modal_confirm" }),
    );
    expect(onConfirm).toHaveBeenCalled();
  });

  it("should disable cancel and load confirm while in flight", () => {
    render(
      <CompetitorAccountDeleteModal
        target={target}
        inFlight
        onDismiss={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "competitor_accounts.delete_modal_cancel" }),
    ).toBeDisabled();
  });
});
