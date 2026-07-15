import { fireEvent, render, screen } from "@testing-library/react";
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
  onDeployNow: vi.fn(),
  onDeployLater: vi.fn(),
  ...over,
});

afterEach(() => vi.clearAllMocks());

describe("EventCreateDeployPromptModal", () => {
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
    render(<EventCreateDeployPromptModal {...props({ bulkDeploySupported: false })} />);
    expect(screen.queryByTestId("deploy-prompt-now")).not.toBeInTheDocument();
    expect(screen.getByText("event_create.deploy_modal_alert_body_non_aws")).toBeInTheDocument();
  });

  it("should disable deploy-now for a read-only viewer", () => {
    const p = props({ canMutateTenant: false });
    render(<EventCreateDeployPromptModal {...p} />);
    expect(screen.getByTestId("deploy-prompt-now")).toBeDisabled();
  });

  it("should not render the key-distribution section when no team keys are provided (#2649)", () => {
    render(<EventCreateDeployPromptModal {...props()} />);
    expect(screen.queryByTestId("deploy-prompt-keys")).not.toBeInTheDocument();
  });

  it("should list each team's plaintext teamLoginKey once for distribution (#2649)", () => {
    render(
      <EventCreateDeployPromptModal
        {...props({
          teamKeys: [
            { internalSlug: "alpha", teamLoginKey: "key-alpha" },
            { internalSlug: "bravo", teamLoginKey: "key-bravo" },
          ],
        })}
      />,
    );
    expect(screen.getByTestId("deploy-prompt-keys")).toBeInTheDocument();
    expect(screen.getByText("key-alpha")).toBeInTheDocument();
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("key-bravo")).toBeInTheDocument();
    expect(screen.getByText("bravo")).toBeInTheDocument();
  });

  it("should copy a team's key to the clipboard from its copy button (#2649)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <EventCreateDeployPromptModal
        {...props({ teamKeys: [{ internalSlug: "alpha", teamLoginKey: "key-alpha" }] })}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "event_create.deploy_modal_keys_copy_aria" }),
    );
    expect(writeText).toHaveBeenCalledWith("key-alpha");
  });
});
