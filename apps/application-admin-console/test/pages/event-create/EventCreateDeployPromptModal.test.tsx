import { LITE_DRILL_CHECKPOINTS } from "@tenkacloud/portal-contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EventCreateDeployPromptModal,
  type EventCreateDeployPromptModalProps,
} from "../../../src/pages/event-create/EventCreateDeployPromptModal";

/**
 * Issue #1067: Event 作成後の deploy 促し modal。 deploy now / later の押下、 X dismiss の
 * deployStarting 分岐 (進行中は no-op、 そうでなければ later)、 deployStarting で button が
 * loading/disabled になることを pin。 useT echo。
 */
vi.mock("../../../src/i18n", () => ({ useT: () => (k: string) => k }));

const props = (
  over: Partial<EventCreateDeployPromptModalProps> = {},
): EventCreateDeployPromptModalProps => ({
  visible: true,
  canMutateTenant: true,
  deployStarting: false,
  teams: [
    { teamId: "team-1", internalSlug: "team-a", teamLoginKey: "KEY-A" },
    { teamId: "team-2", internalSlug: "team-b", teamLoginKey: "KEY-B" },
  ],
  participantPortalUrl: "https://portal.example.com/",
  onDeployNow: vi.fn(),
  onDeployLater: vi.fn(),
  ...over,
});

afterEach(() => vi.clearAllMocks());

describe("EventCreateDeployPromptModal", () => {
  it("should show every one-time login key and copy the complete handoff list", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<EventCreateDeployPromptModal {...props()} />);

    expect(screen.getByText("KEY-A")).toBeInTheDocument();
    expect(screen.getByText("KEY-B")).toBeInTheDocument();
    expect(screen.getByText("event_create.login_keys_key")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "event_create.login_keys_copy_all" }));
    expect(writeText).toHaveBeenCalledWith("team-a\tKEY-A\nteam-b\tKEY-B");
    await screen.findByRole("button", { name: "event_create.login_keys_copied" });
    fireEvent.click(
      screen.getAllByRole("button", { name: "event_create.login_keys_copy_invite" })[0] as Element,
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith("https://portal.example.com/login#invite=KEY-A"),
    );
  });

  it("should prevent dismissal until clipboard feedback is available", async () => {
    let finishCopy: (() => void) | undefined;
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: () =>
          new Promise<void>((resolve) => {
            finishCopy = resolve;
          }),
      },
      configurable: true,
    });
    const p = props();
    render(<EventCreateDeployPromptModal {...p} />);

    fireEvent.click(screen.getByRole("button", { name: "event_create.login_keys_copy_all" }));
    expect(screen.getByRole("button", { name: "event_create.deploy_modal_later" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "event_create.deploy_modal_later" }));
    expect(p.onDeployLater).not.toHaveBeenCalled();

    finishCopy?.();
    expect(
      await screen.findByRole("button", { name: "event_create.login_keys_copied" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "event_create.deploy_modal_later" })).toBeEnabled();
  });

  it("should trigger deploy-now and deploy-later from the footer buttons", () => {
    const p = props();
    render(<EventCreateDeployPromptModal {...p} />);
    fireEvent.click(screen.getByTestId("deploy-prompt-now"));
    expect(p.onDeployNow).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "event_create.deploy_modal_later" }));
    expect(p.onDeployLater).toHaveBeenCalled();
  });

  it("should treat the X dismiss as deploy-later when not starting", () => {
    const p = props({ deployStarting: false });
    render(<EventCreateDeployPromptModal {...p} />);
    fireEvent.click(
      document.querySelector('button[class*="dismiss-control"]') as HTMLButtonElement,
    );
    expect(p.onDeployLater).toHaveBeenCalled();
  });

  it("should ignore the X dismiss while a deploy is starting", () => {
    const p = props({ deployStarting: true });
    render(<EventCreateDeployPromptModal {...p} />);
    fireEvent.click(
      document.querySelector('button[class*="dismiss-control"]') as HTMLButtonElement,
    );
    expect(p.onDeployLater).not.toHaveBeenCalled();
  });

  it("should hide deploy-now and show single-deploy guidance for a non-AWS event (#2563)", () => {
    render(
      <EventCreateDeployPromptModal
        {...props({ bulkDeploySupported: false, participantPortalUrl: undefined })}
      />,
    );
    expect(screen.queryByTestId("deploy-prompt-now")).not.toBeInTheDocument();
    expect(screen.queryByText("event_create.login_keys_invite")).not.toBeInTheDocument();
    expect(screen.getByText("event_create.deploy_modal_alert_body_non_aws")).toBeInTheDocument();
  });

  it("should disable deploy-now for a read-only viewer", () => {
    const p = props({ canMutateTenant: false });
    render(<EventCreateDeployPromptModal {...p} />);
    expect(screen.getByTestId("deploy-prompt-now")).toBeDisabled();
  });

  it("should surface the Lite drill checkpoint code when the caller passes one (#2696)", () => {
    render(
      <EventCreateDeployPromptModal
        {...props({ liteDrillCheckpointCode: LITE_DRILL_CHECKPOINTS.firstEventCreated.code })}
      />,
    );
    expect(screen.getByText(LITE_DRILL_CHECKPOINTS.firstEventCreated.code)).toBeInTheDocument();
    expect(screen.getByText("lite_drill.checkpoint_header")).toBeInTheDocument();
  });

  it("should omit the Lite drill checkpoint outside Lite mode (no code passed)", () => {
    render(<EventCreateDeployPromptModal {...props()} />);
    expect(screen.queryByText("lite_drill.checkpoint_header")).not.toBeInTheDocument();
  });

  /**
   * [Issue #3169] The capacity warning has to be visible on this screen.
   *
   * It travelled from the API into the response and was dropped by the console,
   * so an operator created an oversized event, pressed "Deploy now", and was
   * refused with no earlier signal. This modal is the last screen before they
   * leave the creation flow, which makes it the last cheap moment to change the
   * team roster.
   */
  it("should show every capacity warning the API returned", () => {
    render(
      <EventCreateDeployPromptModal
        {...props({
          capacityWarnings: [
            'problem "ac26-crypto-battle" will not fit 99 teams on the dynamodb backend',
            'problem "other-battle" will not fit 99 teams on the dynamodb backend',
          ],
        })}
      />,
    );

    expect(screen.getByText(/ac26-crypto-battle/)).toBeInTheDocument();
    expect(screen.getByText(/other-battle/)).toBeInTheDocument();
  });

  it("should show nothing when the event fits", () => {
    // The common case. An empty list must not leave an empty alert box behind.
    render(<EventCreateDeployPromptModal {...props({ capacityWarnings: [] })} />);

    expect(screen.queryByText("event_create.capacity_warning_header")).not.toBeInTheDocument();
  });
});
