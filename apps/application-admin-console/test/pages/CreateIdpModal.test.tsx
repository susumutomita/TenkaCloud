import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TenantIdpClient } from "../../src/api/idp-client";
import { CreateIdpModal } from "../../src/pages/CreateIdpModal";

/**
 * CreateIdpModal (SAML IdP 登録モーダル)。 client は prop なので module mock 不要。 submit
 * (create + onCreated / description 省略 / error→describeTenantIdpError / client null guard) と
 * 入力 / cancel / busy を pin する。 describeTenantIdpError は実物。
 */
const makeClient = (create: ReturnType<typeof vi.fn>) => ({ create }) as unknown as TenantIdpClient;
const props = (over = {}) => ({
  client: makeClient(vi.fn().mockResolvedValue(undefined)),
  onClose: vi.fn(),
  onCreated: vi.fn().mockResolvedValue(undefined),
  busy: false,
  setBusy: vi.fn(),
  ...over,
});

afterEach(() => vi.clearAllMocks());

describe("CreateIdpModal", () => {
  it("should create the IdP with the entered fields and refresh", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const onCreated = vi.fn().mockResolvedValue(undefined);
    const setBusy = vi.fn();
    render(<CreateIdpModal {...props({ client: makeClient(create), onCreated, setBusy })} />);
    const boxes = screen.getAllByRole("textbox"); // [idpId, displayName, description, email, metadata]
    fireEvent.change(boxes[0], { target: { value: "my-idp" } });
    fireEvent.change(boxes[1], { target: { value: "My IdP" } });
    fireEvent.change(boxes[2], { target: { value: "corp SAML" } });
    fireEvent.change(boxes[4], { target: { value: "<xml/>" } });
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          idpId: "my-idp",
          displayName: "My IdP",
          description: "corp SAML",
          metadataXml: "<xml/>",
          attributeMapping: { email: expect.stringContaining("emailaddress") },
          groupToRole: {},
        }),
      ),
    );
    expect(onCreated).toHaveBeenCalled();
    expect(setBusy).toHaveBeenCalledWith(true);
    expect(setBusy).toHaveBeenCalledWith(false);
  });

  it("should omit the description key when left blank", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    render(<CreateIdpModal {...props({ client: makeClient(create) })} />);
    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "idp" } });
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("description");
  });

  it("should surface a create error via describeTenantIdpError", async () => {
    const create = vi.fn().mockRejectedValue(new Error("metadata rejected"));
    render(<CreateIdpModal {...props({ client: makeClient(create) })} />);
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    expect(await screen.findByText("metadata rejected")).toBeInTheDocument();
  });

  it("should no-op submit when the client is null", () => {
    const setBusy = vi.fn();
    render(<CreateIdpModal {...props({ client: null, setBusy })} />);
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    expect(setBusy).not.toHaveBeenCalled();
  });

  it("should update all input fields", () => {
    render(<CreateIdpModal {...props()} />);
    const boxes = screen.getAllByRole("textbox");
    boxes.forEach((b, i) => {
      fireEvent.change(b, { target: { value: `v${i}` } });
    });
    expect(boxes[4]).toHaveValue("v4"); // metadata textarea
  });

  it("should close on cancel and disable cancel while busy", () => {
    const onClose = vi.fn();
    const { rerender } = render(<CreateIdpModal {...props({ onClose })} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    rerender(<CreateIdpModal {...props({ onClose, busy: true })} />);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});
