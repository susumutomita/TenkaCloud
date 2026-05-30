import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CompetitorAccountSummary } from "../../../src/api/competitor-accounts-client";
import { CompetitorAccountsTable } from "../../../src/pages/competitor-accounts/CompetitorAccountsTable";

vi.mock("../../../src/i18n", () => {
  const t = (key: string) => key;
  return { useT: () => t };
});

const account = (over: Partial<CompetitorAccountSummary>): CompetitorAccountSummary =>
  ({
    awsAccountId: "111122223333",
    region: "ap-northeast-1",
    competitorRoleName: "Role",
    verified: false,
    ...over,
  }) as CompetitorAccountSummary;

const items = [
  account({ awsAccountId: "acct-1", alias: "Alpha", verified: true }),
  account({ awsAccountId: "acct-2", verified: false }), // no alias
];

describe("CompetitorAccountsTable", () => {
  it("should render rows with verified/alias status and fire verify/delete callbacks", () => {
    const onVerify = vi.fn();
    const onRequestDelete = vi.fn();
    render(
      <CompetitorAccountsTable
        items={items}
        verifyInFlight={null}
        onVerify={onVerify}
        onRequestDelete={onRequestDelete}
      />,
    );
    expect(screen.getByText("acct-1")).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("competitor_accounts.alias_unset")).toBeInTheDocument(); // acct-2
    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(screen.getByText("Unverified")).toBeInTheDocument();
    // labels: verified row → verify_again, unverified → verify
    fireEvent.click(screen.getByRole("button", { name: "competitor_accounts.verify_again" }));
    expect(onVerify).toHaveBeenCalledWith("acct-1");
    fireEvent.click(screen.getByRole("button", { name: "competitor_accounts.verify" }));
    expect(onVerify).toHaveBeenCalledWith("acct-2");
    fireEvent.click(screen.getAllByRole("button", { name: "competitor_accounts.delete" })[0]);
    expect(onRequestDelete).toHaveBeenCalledWith(items[0]);
  });

  it("should mark the in-flight row loading and disable the others", () => {
    render(
      <CompetitorAccountsTable
        items={items}
        verifyInFlight="acct-1"
        onVerify={vi.fn()}
        onRequestDelete={vi.fn()}
      />,
    );
    // acct-2 (not in-flight) の verify button は disabled。
    expect(screen.getByRole("button", { name: "competitor_accounts.verify" })).toBeDisabled();
  });

  it("should render the empty state with no items", () => {
    render(
      <CompetitorAccountsTable
        items={[]}
        verifyInFlight={null}
        onVerify={vi.fn()}
        onRequestDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("competitor_accounts.table_empty")).toBeInTheDocument();
  });
});
