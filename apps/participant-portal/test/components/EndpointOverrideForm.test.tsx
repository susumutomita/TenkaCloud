import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ParticipantEndpointView, PortalValidationError } from "../../src/api/portal-client";

const { mockPut, mockDelete } = vi.hoisted(() => ({
  mockPut: vi.fn(),
  mockDelete: vi.fn(),
}));
vi.mock("../../src/api/portal-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/portal-client")>();
  return {
    ...actual,
    putProblemEndpointOverride: mockPut,
    deleteProblemEndpointOverride: mockDelete,
  };
});
vi.mock("../../src/i18n", () => ({
  useT: () => (key: string, params?: Readonly<Record<string, string | number>>) =>
    params ? `${key}|${JSON.stringify(params)}` : key,
}));

const { EndpointOverrideForm } = await import("../../src/components/EndpointOverrideForm");

const onEndpointsChange = vi.fn();
const props = {
  apiBaseUrl: "https://api.example.com",
  teamLoginKey: "KEY",
  problemId: "p1",
  listError: undefined,
  onEndpointsChange,
};
const usersEp: ParticipantEndpointView = {
  slot: "users",
  label: "Users API",
  overridable: true,
  effectiveUrl: "https://override.example/users",
  overrideUrl: "https://override.example/users",
  defaultUrl: "https://default.example/users",
  defaultKey: "UsersBaseUrl",
};

afterEach(() => vi.clearAllMocks());

describe("EndpointOverrideForm", () => {
  it("should render override, fixed-slot, and missing-default states", () => {
    const { container } = render(
      <EndpointOverrideForm
        {...props}
        endpoints={[usersEp, { slot: "orders", overridable: false, defaultKey: "OrdersBaseUrl" }]}
      />,
    );
    expect(container.textContent).toContain("https://override.example/users");
    expect(container.textContent).toContain("problem_detail.endpoint_override_active_label");
    expect(container.textContent).toContain("problem_detail.endpoint_not_overridable");
    expect(container.textContent).toContain("OrdersBaseUrl");
  });

  it("should render nothing for no_endpoints or an empty registry", () => {
    const noEndpoints = render(
      <EndpointOverrideForm {...props} endpoints={undefined} listError="no_endpoints" />,
    );
    expect(noEndpoints.container.textContent).toBe("");
    noEndpoints.unmount();

    const empty = render(<EndpointOverrideForm {...props} endpoints={[]} />);
    expect(empty.container.textContent).toBe("");
  });

  it("should reject an empty override URL before calling the API", () => {
    const { container } = render(<EndpointOverrideForm {...props} endpoints={[usersEp]} />);
    fireEvent.click(
      screen.getByRole("button", { name: "problem_detail.endpoint_override_submit" }),
    );
    expect(container.textContent).toContain("problem_detail.endpoint_override_url_empty");
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("should save an override and publish the shared endpoint registry", async () => {
    const next = [{ ...usersEp, effectiveUrl: "https://my.example/users" }];
    mockPut.mockResolvedValue({ endpoints: next });
    render(
      <EndpointOverrideForm {...props} endpoints={[{ ...usersEp, overrideUrl: undefined }]} />,
    );
    fireEvent.change(screen.getByPlaceholderText("https://example.com/api"), {
      target: { value: "https://my.example/users" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "problem_detail.endpoint_override_submit" }),
    );
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith(
        "https://api.example.com",
        "KEY",
        "p1",
        "users",
        "https://my.example/users",
      ),
    );
    expect(onEndpointsChange).toHaveBeenCalledWith(next);
  });

  it("should map each mutation error to a competitor-facing message", async () => {
    render(
      <EndpointOverrideForm {...props} endpoints={[{ ...usersEp, overrideUrl: undefined }]} />,
    );
    const input = screen.getByPlaceholderText("https://example.com/api");
    const save = () =>
      fireEvent.click(
        screen.getByRole("button", { name: "problem_detail.endpoint_override_submit" }),
      );

    const cases: [unknown, string][] = [
      [new PortalValidationError("invalid_url"), "problem_detail.endpoint_error_invalid_url"],
      [
        new PortalValidationError("slot_not_overridable"),
        "problem_detail.endpoint_error_slot_not_overridable",
      ],
      [new PortalValidationError("unknown_slot"), "problem_detail.endpoint_error_unknown_slot"],
      [new PortalValidationError("no_endpoints"), "problem_detail.endpoint_error_no_endpoints"],
      [
        new PortalValidationError("challenge_prerequisite_not_met"),
        "problem_detail.endpoint_error_prerequisite_locked",
      ],
      [new PortalValidationError("weird_code"), "problem_detail.endpoint_error_generic"],
      [new Error("plain failure"), "plain failure"],
      ["string-failure", "string-failure"],
    ];
    for (const [thrown, expected] of cases) {
      mockPut.mockRejectedValueOnce(thrown);
      fireEvent.change(input, { target: { value: "https://x.example" } });
      save();
      await waitFor(() => expect(screen.getByText(expected, { exact: false })).toBeInTheDocument());
    }
  });

  it("should clear an override and publish the default endpoint", async () => {
    const next = [
      {
        ...usersEp,
        overrideUrl: undefined,
        effectiveUrl: usersEp.defaultUrl,
      },
    ];
    mockDelete.mockResolvedValue({ endpoints: next });
    render(<EndpointOverrideForm {...props} endpoints={[usersEp]} />);
    fireEvent.click(screen.getByRole("button", { name: "problem_detail.endpoint_override_clear" }));
    await waitFor(() =>
      expect(mockDelete).toHaveBeenCalledWith("https://api.example.com", "KEY", "p1", "users"),
    );
    expect(onEndpointsChange).toHaveBeenCalledWith(next);
  });

  it("should surface delete errors and show no-default override context", async () => {
    mockDelete.mockRejectedValue(new PortalValidationError("slot_not_overridable"));
    const { container } = render(
      <EndpointOverrideForm {...props} endpoints={[{ ...usersEp, defaultUrl: undefined }]} />,
    );
    expect(container.textContent).toContain("—");
    fireEvent.click(screen.getByRole("button", { name: "problem_detail.endpoint_override_clear" }));
    await waitFor(() =>
      expect(container.textContent).toContain("problem_detail.endpoint_error_slot_not_overridable"),
    );
  });
});
