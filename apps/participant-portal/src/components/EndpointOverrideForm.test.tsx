import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParticipantEndpointView } from "../api/portal-client";
import { I18nProvider } from "../i18n";

vi.mock("../api/portal-client", async () => {
  const actual =
    await vi.importActual<typeof import("../api/portal-client")>("../api/portal-client");
  return {
    ...actual,
    putProblemEndpointOverride: vi.fn(),
    deleteProblemEndpointOverride: vi.fn(),
  };
});

const { putProblemEndpointOverride, deleteProblemEndpointOverride, PortalValidationError } =
  await import("../api/portal-client");
const { EndpointOverrideForm } = await import("./EndpointOverrideForm");

const mockPut = putProblemEndpointOverride as ReturnType<typeof vi.fn>;
const mockDelete = deleteProblemEndpointOverride as ReturnType<typeof vi.fn>;
const onEndpointsChange = vi.fn();

beforeEach(() => window.localStorage.setItem("tenkacloud.portal.locale", "ja"));
afterEach(() => {
  mockPut.mockReset();
  mockDelete.mockReset();
  onEndpointsChange.mockReset();
});

function withI18n(node: React.ReactNode) {
  return <I18nProvider>{node}</I18nProvider>;
}

const endpoint = (overrides: Partial<ParticipantEndpointView> = {}): ParticipantEndpointView => ({
  slot: "users",
  overridable: true,
  defaultKey: "BaseUrl",
  ...overrides,
});

const baseProps = {
  apiBaseUrl: "https://api.x",
  teamLoginKey: "k",
  problemId: "p1",
  listError: undefined,
  onEndpointsChange,
};

describe("EndpointOverrideForm (Issue #607 / #2661)", () => {
  it("should render the endpoint registry supplied by ProblemDetail", () => {
    render(
      withI18n(
        <EndpointOverrideForm
          {...baseProps}
          endpoints={[
            endpoint({
              label: "Users service",
              defaultUrl: "https://ec2/users",
              effectiveUrl: "https://ec2/users",
            }),
          ]}
        />,
      ),
    );
    expect(screen.getByText("Users service")).toBeInTheDocument();
    expect(screen.getByText("https://ec2/users")).toBeInTheDocument();
  });

  it("should show loading, list-error, and empty states without fetching independently", () => {
    const loading = render(withI18n(<EndpointOverrideForm {...baseProps} endpoints={undefined} />));
    expect(screen.getByText(/endpoint/i)).toBeInTheDocument();
    loading.unmount();

    const failed = render(
      withI18n(<EndpointOverrideForm {...baseProps} endpoints={undefined} listError="list boom" />),
    );
    expect(screen.getByText("list boom")).toBeInTheDocument();
    failed.unmount();

    const empty = render(withI18n(<EndpointOverrideForm {...baseProps} endpoints={[]} />));
    expect(empty.container.textContent).not.toContain("Endpoint 登録");
  });

  it("should show a fixed-slot note and a diagnostic default key while no URL exists", () => {
    render(
      withI18n(
        <EndpointOverrideForm
          {...baseProps}
          endpoints={[
            endpoint({
              slot: "fixed",
              label: "Fixed service",
              overridable: false,
              defaultKey: "RegisteredUrl",
            }),
          ]}
        />,
      ),
    );
    expect(screen.getByText(/この slot は override 不可/)).toBeInTheDocument();
    expect(screen.getByText("RegisteredUrl")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "登録" })).not.toBeInTheDocument();
  });

  it("should publish the server response after saving an override", async () => {
    const user = userEvent.setup();
    const next = [
      endpoint({
        defaultUrl: "https://ec2/users",
        overrideUrl: "https://lambda.example/",
        effectiveUrl: "https://lambda.example/",
      }),
    ];
    mockPut.mockResolvedValue({ teamId: "t1", endpoints: next });
    render(
      withI18n(
        <EndpointOverrideForm
          {...baseProps}
          endpoints={[
            endpoint({
              defaultUrl: "https://ec2/users",
              effectiveUrl: "https://ec2/users",
            }),
          ]}
        />,
      ),
    );

    await user.type(
      screen.getByPlaceholderText("https://example.com/api"),
      next[0]?.effectiveUrl ?? "",
    );
    await user.click(screen.getByRole("button", { name: "登録" }));

    await waitFor(() => expect(onEndpointsChange).toHaveBeenCalledWith(next));
  });

  it("should show a localized validation error", async () => {
    const user = userEvent.setup();
    mockPut.mockRejectedValue(new PortalValidationError("invalid_url"));
    render(withI18n(<EndpointOverrideForm {...baseProps} endpoints={[endpoint()]} />));
    await user.type(screen.getByPlaceholderText("https://example.com/api"), "not-a-url");
    await user.click(screen.getByRole("button", { name: "登録" }));
    expect(await screen.findByText(/URL の形式が不正です/)).toBeInTheDocument();
  });

  it("should publish the server response after clearing an override", async () => {
    const user = userEvent.setup();
    const current = endpoint({
      defaultUrl: "https://ec2/users",
      overrideUrl: "https://lambda/",
      effectiveUrl: "https://lambda/",
    });
    const next = [endpoint({ defaultUrl: current.defaultUrl, effectiveUrl: current.defaultUrl })];
    mockDelete.mockResolvedValue({ teamId: "t1", endpoints: next });
    render(withI18n(<EndpointOverrideForm {...baseProps} endpoints={[current]} />));

    await user.click(screen.getByRole("button", { name: "override 解除" }));

    await waitFor(() => expect(onEndpointsChange).toHaveBeenCalledWith(next));
  });

  it("should reject an empty override before calling the API", async () => {
    const user = userEvent.setup();
    render(withI18n(<EndpointOverrideForm {...baseProps} endpoints={[endpoint()]} />));
    await user.click(screen.getByRole("button", { name: "登録" }));
    expect(screen.getByText("URL を入力してください")).toBeInTheDocument();
    expect(mockPut).not.toHaveBeenCalled();
  });
});
