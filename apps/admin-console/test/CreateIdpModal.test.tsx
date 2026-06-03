import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { IdpClient } from "../src/api/idp-client";
import { CreateIdpModal } from "../src/pages/CreateIdpModal";

// i18n: resolve against the real en.json so assertions check the actual shipped copy.
vi.mock("../src/i18n", async () => {
  const en = (await import("../src/i18n/locales/en.json")).default as Record<string, unknown>;
  const resolve = (key: string): string => {
    const v = key
      .split(".")
      .reduce<unknown>(
        (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
        en,
      );
    return typeof v === "string" ? v : key;
  };
  return {
    useLang: () => "en",
    useT: () => (key: string, params?: Record<string, string | number>) => {
      let s = resolve(key);
      if (params)
        for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
      return s;
    },
  };
});

/**
 * Issue #1418: 未テストだった admin CreateIdpModal (SAML IdP 登録モーダル) を 100% に。
 * client は prop 注入なので mock client を渡し、 Cloudscape test-utils で input/textarea を駆動。
 * describe-error helper のみ module mock し coverage scope を modal に限定する。
 */
vi.mock("../src/api/idp-client", () => ({
  describeIdpError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

type Props = ComponentProps<typeof CreateIdpModal>;
const clientWith = (create: Mock): IdpClient => ({ create }) as unknown as IdpClient;
const makeProps = (over: Partial<Props> = {}): Props => ({
  client: clientWith(vi.fn().mockResolvedValue(undefined)),
  onClose: vi.fn(),
  onCreated: vi.fn().mockResolvedValue(undefined),
  busy: false,
  setBusy: vi.fn(),
  ...over,
});

// Cloudscape Modal は body にポータルされるので body を wrap する。
const body = () => createWrapper(document.body);
const register = () => screen.getByRole("button", { name: "Register" });

afterEach(() => vi.clearAllMocks());

describe("CreateIdpModal", () => {
  it("should submit including description and the email attribute when entered", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const props = makeProps({ client: clientWith(create) });
    render(<CreateIdpModal {...props} />);
    const inputs = body().findAllInputs(); // idpId, displayName, description, emailAttr
    inputs[0]?.setInputValue("my-idp");
    inputs[1]?.setInputValue("My IdP");
    inputs[2]?.setInputValue("a desc");
    inputs[3]?.setInputValue("urn:oid:0.9.2342.19200300.100.1.3"); // email attribute override
    body().findTextarea()?.setTextareaValue("<xml/>");
    fireEvent.click(register());
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        idpId: "my-idp",
        displayName: "My IdP",
        description: "a desc",
        metadataXml: "<xml/>",
        attributeMapping: { email: "urn:oid:0.9.2342.19200300.100.1.3" },
        groupToRole: {},
      }),
    );
    expect(props.setBusy).toHaveBeenCalledWith(true);
    expect(props.setBusy).toHaveBeenCalledWith(false);
  });

  it("should omit the description key when left blank", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const props = makeProps({ client: clientWith(create) });
    render(<CreateIdpModal {...props} />);
    const inputs = body().findAllInputs();
    inputs[0]?.setInputValue("idp2");
    inputs[1]?.setInputValue("IdP 2");
    body().findTextarea()?.setTextareaValue("<xml/>");
    fireEvent.click(register());
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).not.toHaveProperty("description");
  });

  it("should show an error alert when create rejects", async () => {
    const create = vi.fn().mockRejectedValue(new Error("invalid metadata"));
    const props = makeProps({ client: clientWith(create) });
    render(<CreateIdpModal {...props} />);
    body().findAllInputs()[0]?.setInputValue("idp3");
    fireEvent.click(register());
    expect(await screen.findByText("invalid metadata")).toBeInTheDocument();
    expect(props.onCreated).not.toHaveBeenCalled();
    expect(props.setBusy).toHaveBeenLastCalledWith(false); // finally で必ず解除
  });

  it("should do nothing on submit when the client is null", () => {
    const props = makeProps({ client: null });
    render(<CreateIdpModal {...props} />);
    fireEvent.click(register());
    expect(props.setBusy).not.toHaveBeenCalled();
    expect(props.onCreated).not.toHaveBeenCalled();
  });

  it("should call onClose on cancel", () => {
    const props = makeProps();
    render(<CreateIdpModal {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
