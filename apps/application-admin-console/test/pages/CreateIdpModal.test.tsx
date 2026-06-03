import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TenantIdpClient } from "../../src/api/idp-client";
import { CreateIdpModal } from "../../src/pages/CreateIdpModal";

// i18n: resolve against the real en.json so assertions check the actual shipped copy.
vi.mock("../../src/i18n", async () => {
  const en = (await import("../../src/i18n/locales/en.json")).default as Record<string, unknown>;
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
 * CreateIdpModal (SAML IdP 登録モーダル)。 client は prop なので module mock 不要。 submit
 * (create + onCreated / description 省略 / error→describeTenantIdpError / client null guard) と
 * 入力 / cancel / busy を pin する。 describeTenantIdpError は実物。
 */
const makeClient = (create: ReturnType<typeof vi.fn>) => ({ create }) as unknown as TenantIdpClient;
const props = (over = {}) => ({
  client: makeClient(vi.fn().mockResolvedValue(undefined)),
  cognitoDomain: "auth.example.com",
  onClose: vi.fn(),
  onCreated: vi.fn().mockResolvedValue(undefined),
  busy: false,
  setBusy: vi.fn(),
  ...over,
});
const metadataTextarea = () => screen.getAllByRole("textbox")[4] as HTMLTextAreaElement;
const metadataFileInput = () =>
  document.querySelector<HTMLInputElement>('input[type="file"]') as HTMLInputElement;
const metadataFile = (contents: string | Promise<string>, error?: Error) => {
  const file = new File(["ignored"], "metadata.xml", { type: "text/xml" });
  Object.defineProperty(file, "text", {
    value: error ? vi.fn().mockRejectedValue(error) : vi.fn().mockResolvedValue(contents),
  });
  return file;
};

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

  it("should load an uploaded XML file into the editable metadata textarea", async () => {
    render(<CreateIdpModal {...props()} />);
    const input = metadataFileInput();
    expect(input).toHaveAttribute("accept", ".xml,text/xml,application/xml");
    fireEvent.change(input, { target: { files: [metadataFile("<EntityDescriptor />")] } });
    await waitFor(() => expect(metadataTextarea()).toHaveValue("<EntityDescriptor />"));
    fireEvent.change(metadataTextarea(), { target: { value: "<edited />" } });
    expect(metadataTextarea()).toHaveValue("<edited />");
  });

  it("should surface an empty uploaded XML file and clear the error after manual paste", async () => {
    render(<CreateIdpModal {...props()} />);
    fireEvent.change(metadataFileInput(), { target: { files: [metadataFile("  ")] } });
    expect(await screen.findByText("The selected metadata XML file is empty.")).toBeInTheDocument();
    fireEvent.change(metadataTextarea(), { target: { value: "<pasted />" } });
    expect(screen.queryByText("The selected metadata XML file is empty.")).not.toBeInTheDocument();
  });

  it("should surface an XML file read failure and allow clearing the selected file", async () => {
    render(<CreateIdpModal {...props()} />);
    fireEvent.change(metadataFileInput(), {
      target: { files: [metadataFile("", new Error("disk read failed"))] },
    });
    expect(
      await screen.findByText(
        "Could not read the selected metadata XML file. Try another file or paste the XML below.",
      ),
    ).toBeInTheDocument();
    createWrapper(document.body).findFileUpload()?.findFileToken(1)?.findRemoveButton().click();
    await waitFor(() =>
      expect(
        screen.queryByText(
          "Could not read the selected metadata XML file. Try another file or paste the XML below.",
        ),
      ).not.toBeInTheDocument(),
    );
  });

  it("should ignore a stale XML file read after a newer upload finishes", async () => {
    let finishStaleRead: (contents: string) => void = () => undefined;
    const staleRead = new Promise<string>((resolve) => {
      finishStaleRead = resolve;
    });
    render(<CreateIdpModal {...props()} />);
    fireEvent.change(metadataFileInput(), { target: { files: [metadataFile(staleRead)] } });
    fireEvent.change(metadataFileInput(), { target: { files: [metadataFile("<current />")] } });
    await waitFor(() => expect(metadataTextarea()).toHaveValue("<current />"));
    await act(async () => {
      finishStaleRead("<stale />");
      await staleRead;
    });
    expect(metadataTextarea()).toHaveValue("<current />");
  });

  it("should derive the ACS URL from both bare and HTTPS Cognito domains", () => {
    const { rerender } = render(<CreateIdpModal {...props()} />);
    expect(screen.getByText("https://auth.example.com/saml2/idpresponse")).toBeInTheDocument();
    rerender(<CreateIdpModal {...props({ cognitoDomain: "https://auth.example.com" })} />);
    expect(screen.getByText("https://auth.example.com/saml2/idpresponse")).toBeInTheDocument();
    expect(screen.queryByText(/https:\/\/https:\/\//)).not.toBeInTheDocument();
  });

  it("should show provider-specific setup guides and copyable Cognito SP values", () => {
    render(<CreateIdpModal {...props()} />);
    expect(screen.getByText("Generic SAML setup guide")).toBeInTheDocument();
    expect(
      screen.getByText(/Give the IdP administrator the ACS URL, SP Entity ID, and email attribute/),
    ).toBeInTheDocument();
    expect(screen.getByText("urn:amazon:cognito:sp:<userPoolId>")).toBeInTheDocument();
    expect(
      screen.getByText(/Replace <userPoolId> with your User Pool ID from the AWS Cognito/),
    ).toBeInTheDocument();
    expect(screen.getByText(/identity\/claims\/emailaddress/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy ACS URL (Reply / SSO URL)" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Copy SP Entity ID / Identifier (Audience)" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Copy Email attribute mapping" })).toBeEnabled();

    fireEvent.click(screen.getByRole("radio", { name: "Microsoft Entra ID" }));
    expect(screen.getByText("Microsoft Entra ID setup guide")).toBeInTheDocument();
    expect(
      screen.getByText(
        "In Microsoft Entra ID, open Enterprise applications -> New application -> Single sign-on -> SAML.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Google Workspace" }));
    expect(screen.getByText("Google Workspace setup guide")).toBeInTheDocument();
    expect(
      screen.getByText(
        "In Google Workspace, open Admin console -> Apps -> Web and mobile apps -> Add custom SAML app.",
      ),
    ).toBeInTheDocument();
  });

  it("should show the real SP Entity ID (and 'set as-is' guidance) when userPoolId is known", () => {
    render(<CreateIdpModal {...props({ userPoolId: "ap-northeast-1_AbCd123" })} />);
    expect(screen.getByText("urn:amazon:cognito:sp:ap-northeast-1_AbCd123")).toBeInTheDocument();
    expect(screen.getByText(/Set this value as-is as the IdP's Audience/)).toBeInTheDocument();
    expect(screen.queryByText(/Replace <userPoolId>/)).not.toBeInTheDocument();
  });
});
