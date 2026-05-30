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
});
