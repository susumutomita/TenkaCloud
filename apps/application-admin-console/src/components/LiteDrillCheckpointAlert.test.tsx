import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { LiteDrillCheckpointAlert } from "./LiteDrillCheckpointAlert";

const CODE = "TC{COMPETITOR-TRUST-OK}";

beforeEach(() => {
  window.localStorage.setItem("tenkacloud.application-admin.locale", "ja");
});

afterEach(() => {
  window.localStorage.clear();
});

function renderAlert(onDismiss?: () => void) {
  return render(
    <I18nProvider>
      <LiteDrillCheckpointAlert code={CODE} {...(onDismiss ? { onDismiss } : {})} />
    </I18nProvider>,
  );
}

describe("LiteDrillCheckpointAlert (#2696)", () => {
  it("should show the checkpoint code with the drill submission guidance", () => {
    renderAlert();
    expect(screen.getByText(CODE)).toBeInTheDocument();
    expect(screen.getByText("オンボーディングドリル: チェックポイント獲得!")).toBeInTheDocument();
    expect(screen.getByText(/自分の TenkaCloud Lite を立てる/)).toBeInTheDocument();
  });

  it("should not render a dismiss control when no onDismiss is given", () => {
    renderAlert();
    // copy ボタンのみ (= dismiss ボタン無し)。
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("should call onDismiss when the alert is dismissed", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    renderAlert(onDismiss);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    // copy ボタン (aria-label 付き) ではない方が Cloudscape の dismiss ボタン。
    const copyLabel = "チェックポイントコードをコピー";
    const dismissButton = buttons.find((b) => b.getAttribute("aria-label") !== copyLabel);
    expect(dismissButton).toBeDefined();
    await user.click(dismissButton as HTMLElement);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
