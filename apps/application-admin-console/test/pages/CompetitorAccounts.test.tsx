import { LITE_DRILL_CHECKPOINTS } from "@tenkacloud/portal-contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config";

/**
 * CompetitorAccountsPage: useCompetitorAccounts の state を受けて header/table/modals を配線する
 * orchestration page。 hook は mock、 子 (Table / AddAccountModal / SecretRevealModal /
 * DeleteModal) は callback を expose する stub に差し替えて wiring を pin。 loading / bootstrap
 * 警告 / error / add→secret→reload / request-delete→confirm(remove) / 空 target guard を網羅。
 */
const { mockHook } = vi.hoisted(() => ({ mockHook: vi.fn() }));

vi.mock("../../src/i18n", () => {
  const t = (key: string) => key;
  return { useT: () => t };
});
vi.mock("../../src/pages/competitor-accounts/useCompetitorAccounts", () => ({
  useCompetitorAccounts: mockHook,
}));
vi.mock("../../src/pages/competitor-accounts/TeamCloudCredentialsPanel", () => ({
  TeamCloudCredentialsPanel: () => <div data-testid="team-cloud-credentials" />,
}));
vi.mock("../../src/pages/competitor-accounts/CompetitorAccountsTable", () => ({
  // biome-ignore lint/suspicious/noExplicitAny: stub props。
  CompetitorAccountsTable: ({ onVerify, onRequestDelete, onAdd }: any) => (
    <div data-testid="accounts-table">
      <button type="button" onClick={() => onVerify("acct-1")}>
        stub-verify
      </button>
      <button type="button" onClick={() => onRequestDelete({ awsAccountId: "acct-1" })}>
        stub-request-delete
      </button>
      <button type="button" onClick={onAdd}>
        stub-empty-add
      </button>
    </div>
  ),
}));
vi.mock("../../src/pages/competitor-accounts/AddAccountModal", () => ({
  // biome-ignore lint/suspicious/noExplicitAny: stub props。
  AddAccountModal: ({ visible, onSuccess, onDismiss }: any) =>
    visible ? (
      <div data-testid="add-modal">
        <button type="button" onClick={() => onSuccess({ tenkaCloudAccountId: "x" })}>
          stub-add-success
        </button>
        <button type="button" onClick={onDismiss}>
          stub-add-dismiss
        </button>
      </div>
    ) : null,
}));
vi.mock("../../src/pages/competitor-accounts/SecretRevealModal", () => ({
  // biome-ignore lint/suspicious/noExplicitAny: stub props。
  SecretRevealModal: ({ secret, onDismiss }: any) =>
    secret ? (
      <div data-testid="secret-modal">
        <button type="button" onClick={onDismiss}>
          stub-secret-dismiss
        </button>
      </div>
    ) : null,
}));
vi.mock("../../src/pages/competitor-accounts/CompetitorAccountDeleteModal", () => ({
  // biome-ignore lint/suspicious/noExplicitAny: stub props。
  CompetitorAccountDeleteModal: ({ target, onConfirm, onDismiss }: any) => (
    <div>
      <span data-testid="delete-target">{target?.awsAccountId ?? "no-target"}</span>
      <button type="button" onClick={onConfirm}>
        stub-confirm-delete
      </button>
      <button type="button" onClick={onDismiss}>
        stub-delete-dismiss
      </button>
    </div>
  ),
}));

const { CompetitorAccountsPage } = await import("../../src/pages/CompetitorAccounts");

const remove = vi.fn().mockResolvedValue(undefined);
const verify = vi.fn();
const reload = vi.fn().mockResolvedValue(undefined);
const clearLastVerified = vi.fn();
const hookState = (over: Record<string, unknown> = {}) => ({
  items: [],
  error: null,
  verifyInFlight: null,
  deleteInFlight: false,
  canMutateTenant: true,
  lastVerified: null,
  clearLastVerified,
  reload,
  verify,
  remove,
  ...over,
});
const config = (over: Partial<AppConfig> = {}) =>
  ({ competitorBootstrapTemplateUrl: "https://x/bootstrap.yaml", ...over }) as AppConfig;
const renderPage = (cfg = config()) => render(<CompetitorAccountsPage config={cfg} />);

beforeEach(() => {
  mockHook.mockReturnValue(hookState());
  // #2696 follow-up (2026-07-21): the drill checkpoint's "already shown" state lives in
  // localStorage so it survives remounts within one browser — reset it between tests too.
  window.localStorage.clear();
});
afterEach(() => vi.clearAllMocks());

describe("CompetitorAccountsPage", () => {
  it("should show a spinner while loading (no items, no error)", () => {
    mockHook.mockReturnValue(hookState({ items: undefined, error: null }));
    renderPage();
    expect(screen.getByText("competitor_accounts.loading_spinner")).toBeInTheDocument();
  });

  it("should render the table and the bootstrap warning when the template URL is missing", () => {
    renderPage(config({ competitorBootstrapTemplateUrl: "" }));
    expect(screen.getByTestId("accounts-table")).toBeInTheDocument();
    expect(screen.getByText("competitor_accounts.bootstrap_url_missing_body")).toBeInTheDocument();
  });

  it("should hide the bootstrap warning when the template URL is set", () => {
    renderPage();
    expect(
      screen.queryByText("competitor_accounts.bootstrap_url_missing_body"),
    ).not.toBeInTheDocument();
  });

  it("should hide the non-AWS team cloud credentials panel by default (feature off)", () => {
    renderPage();
    expect(screen.queryByTestId("team-cloud-credentials")).not.toBeInTheDocument();
  });

  it("should disable the add button for a read-only viewer", () => {
    mockHook.mockReturnValue(hookState({ canMutateTenant: false }));
    renderPage();
    expect(screen.getByRole("button", { name: "competitor_accounts.add_button" })).toBeDisabled();
  });

  it("should show the non-AWS team cloud credentials panel when featureNonAwsRuntime is on", () => {
    renderPage(
      config({
        features: {
          samlSso: false,
          nonAwsRuntime: true,
          redTeam: false,
          challengePrerequisiteGate: false,
        },
      }),
    );
    expect(screen.getByTestId("team-cloud-credentials")).toBeInTheDocument();
  });

  it("should show a friendly error alert (items undefined → table gets [])", () => {
    // items undefined + error → loading は抜けて table に items ?? [] の [] が渡る。
    mockHook.mockReturnValue(hookState({ items: undefined, error: { title: "load boom" } }));
    renderPage();
    expect(screen.getByText("load boom")).toBeInTheDocument();
    expect(screen.getByTestId("accounts-table")).toBeInTheDocument();
  });

  it("should verify an account via the table callback", () => {
    renderPage();
    fireEvent.click(screen.getByText("stub-verify"));
    expect(verify).toHaveBeenCalledWith("acct-1");
  });

  it("should open the add modal, reveal the secret on success, and reload", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "competitor_accounts.add_button" }));
    fireEvent.click(screen.getByText("stub-add-success"));
    expect(screen.getByTestId("secret-modal")).toBeInTheDocument();
    expect(reload).toHaveBeenCalled();
    // secret modal dismiss → 閉じる。
    fireEvent.click(screen.getByText("stub-secret-dismiss"));
    expect(screen.queryByTestId("secret-modal")).not.toBeInTheDocument();
  });

  it("should open the add modal from the table's empty-state add action", () => {
    renderPage();
    fireEvent.click(screen.getByText("stub-empty-add"));
    expect(screen.getByTestId("add-modal")).toBeInTheDocument();
  });

  it("should close the add modal on dismiss", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "competitor_accounts.add_button" }));
    expect(screen.getByTestId("add-modal")).toBeInTheDocument();
    fireEvent.click(screen.getByText("stub-add-dismiss"));
    expect(screen.queryByTestId("add-modal")).not.toBeInTheDocument();
  });

  it("should set the delete target then remove it on confirm", async () => {
    renderPage();
    fireEvent.click(screen.getByText("stub-request-delete"));
    expect(screen.getByTestId("delete-target")).toHaveTextContent("acct-1");
    fireEvent.click(screen.getByText("stub-confirm-delete"));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("acct-1"));
    expect(screen.getByTestId("delete-target")).toHaveTextContent("no-target");
  });

  it("should clear the delete target on dismiss", () => {
    renderPage();
    fireEvent.click(screen.getByText("stub-request-delete"));
    expect(screen.getByTestId("delete-target")).toHaveTextContent("acct-1");
    fireEvent.click(screen.getByText("stub-delete-dismiss"));
    expect(screen.getByTestId("delete-target")).toHaveTextContent("no-target");
  });

  it("should no-op confirm when there is no delete target", () => {
    renderPage();
    fireEvent.click(screen.getByText("stub-confirm-delete")); // target null
    expect(remove).not.toHaveBeenCalled();
  });

  it("should reveal the Lite drill checkpoint after a verified trust check in Lite mode (#2696)", () => {
    mockHook.mockReturnValue(hookState({ lastVerified: { awsAccountId: "acct-1" } }));
    renderPage(config({ tenantId: "local" }));
    expect(screen.getByText(LITE_DRILL_CHECKPOINTS.competitorVerified.code)).toBeInTheDocument();
  });

  it("should keep the checkpoint alert visible across the reload re-render after verify (2026-07-21)", () => {
    // Regression: verify() sets lastVerified, then awaits reload() (a separate render pass).
    // Recomputing liteDrillCheckpointCode() fresh on that later render would report "already
    // shown" (since the effect already marked it after the first render) and hide the alert
    // before the learner can read it. The revealed code must stay pinned in local state.
    mockHook.mockReturnValue(hookState({ lastVerified: { awsAccountId: "acct-1" } }));
    const { rerender } = renderPage(config({ tenantId: "local" }));
    expect(screen.getByText(LITE_DRILL_CHECKPOINTS.competitorVerified.code)).toBeInTheDocument();

    rerender(<CompetitorAccountsPage config={config({ tenantId: "local" })} />);
    expect(screen.getByText(LITE_DRILL_CHECKPOINTS.competitorVerified.code)).toBeInTheDocument();
  });

  it("should keep the drill checkpoint hidden outside Lite mode even after a verified check", () => {
    mockHook.mockReturnValue(hookState({ lastVerified: { awsAccountId: "acct-1" } }));
    renderPage(config({ tenantId: "pooled" }));
    expect(
      screen.queryByText(LITE_DRILL_CHECKPOINTS.competitorVerified.code),
    ).not.toBeInTheDocument();
  });

  it("should clear the drill checkpoint signal when the alert is dismissed", () => {
    mockHook.mockReturnValue(hookState({ lastVerified: { awsAccountId: "acct-1" } }));
    renderPage(config({ tenantId: "local" }));
    // LiteDrillCheckpointAlert は実物を render。 Cloudscape Alert の dismiss button は
    // aria-label を持たないため、 modal テストと同じ class selector で特定する。
    const dismiss = document.querySelector('button[class*="dismiss"]');
    expect(dismiss).not.toBeNull();
    fireEvent.click(dismiss as HTMLElement);
    expect(clearLastVerified).toHaveBeenCalledTimes(1);
  });
});
