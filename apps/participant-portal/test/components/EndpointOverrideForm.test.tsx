import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ParticipantEndpointView, PortalValidationError } from "../../src/api/portal-client";

/**
 * Issue #607 / #2661: EndpointOverrideForm。 [Issue #2661] 以降 endpoints / listError は props で
 * 受ける controlled component (fetch は ProblemDetail の useProblemEndpoints が担う)。 このテストは
 * render 分岐 (effectiveUrl / overrideUrl / overridable / not-yet) と、 save / delete が API を叩き、
 * server 返却の endpoints を `onEndpointsChange` で親へ返すこと、 validation code の inline error を pin
 * する。 mount fetch / list error / cancelled guard は useProblemEndpoints.test に移した。
 */
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

const usersEp: ParticipantEndpointView = {
  slot: "users",
  label: "Users API",
  overridable: true,
  effectiveUrl: "https://override.example/users",
  overrideUrl: "https://override.example/users",
  defaultUrl: "https://default.example/users",
  defaultKey: "UsersBaseUrl",
};

const controlled = (
  over: {
    endpoints?: readonly ParticipantEndpointView[] | undefined;
    listError?: string | undefined;
    onEndpointsChange?: (next: readonly ParticipantEndpointView[]) => void;
  } = {},
) => ({
  apiBaseUrl: "https://api.example.com",
  teamLoginKey: "KEY",
  problemId: "p1",
  endpoints: over.endpoints,
  listError: over.listError,
  onEndpointsChange: over.onEndpointsChange ?? vi.fn(),
});

afterEach(() => vi.clearAllMocks());

describe("EndpointOverrideForm", () => {
  it("should render endpoints incl. overridable form, override-active note, and non-overridable slots", () => {
    const { container } = render(
      <EndpointOverrideForm
        {...controlled({
          endpoints: [usersEp, { slot: "orders", overridable: false, defaultKey: "OrdersBaseUrl" }],
        })}
      />,
    );
    expect(screen.getByText("Users API")).toBeInTheDocument();
    expect(container.textContent).toContain("https://override.example/users");
    expect(container.textContent).toContain("problem_detail.endpoint_override_active_label");
    expect(container.textContent).toContain("problem_detail.endpoint_not_overridable");
    expect(container.textContent).toContain("OrdersBaseUrl");
  });

  it("should show an error alert when the parent reports a list error", () => {
    render(<EndpointOverrideForm {...controlled({ listError: "list boom" })} />);
    expect(screen.getByText("list boom")).toBeInTheDocument();
  });

  it("should show a loading note before the parent has provided endpoints", () => {
    const { container } = render(
      <EndpointOverrideForm {...controlled({ endpoints: undefined })} />,
    );
    expect(container.textContent).toContain("problem_detail.endpoint_loading");
  });

  it("should render nothing for a no_endpoints error or an empty endpoint list", () => {
    const a = render(<EndpointOverrideForm {...controlled({ listError: "no_endpoints" })} />);
    expect(a.container.textContent).toBe("");
    a.unmount();

    const b = render(<EndpointOverrideForm {...controlled({ endpoints: [] })} />);
    expect(b.container.textContent).toBe("");
  });

  it("should reject an empty override URL before calling the API", () => {
    const { container } = render(
      <EndpointOverrideForm {...controlled({ endpoints: [usersEp] })} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "problem_detail.endpoint_override_submit" }),
    );
    expect(container.textContent).toContain("problem_detail.endpoint_override_url_empty");
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("should save an override and hand the response endpoints up to the parent (#2661)", async () => {
    mockPut.mockResolvedValue({ endpoints: [usersEp] });
    const onEndpointsChange = vi.fn();
    render(
      <EndpointOverrideForm
        {...controlled({ endpoints: [{ ...usersEp, overrideUrl: undefined }], onEndpointsChange })}
      />,
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
    // 単一 source を親 (= plugin にも配る側) へ返すことで両カードの表示が一致する。
    expect(onEndpointsChange).toHaveBeenCalledWith([usersEp]);
  });

  it("should map each PortalValidationError code (and plain errors) to a message", async () => {
    render(
      <EndpointOverrideForm
        {...controlled({ endpoints: [{ ...usersEp, overrideUrl: undefined }] })}
      />,
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
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => expect(screen.getByText(expected, { exact: false })).toBeInTheDocument());
    }
  });

  it("should clear an override via delete and hand the response up (#2661)", async () => {
    const cleared = [{ ...usersEp, overrideUrl: undefined, effectiveUrl: undefined }];
    mockDelete.mockResolvedValueOnce({ endpoints: cleared });
    const onEndpointsChange = vi.fn();
    render(<EndpointOverrideForm {...controlled({ endpoints: [usersEp], onEndpointsChange })} />);
    fireEvent.click(screen.getByRole("button", { name: "problem_detail.endpoint_override_clear" }));
    await waitFor(() =>
      expect(mockDelete).toHaveBeenCalledWith("https://api.example.com", "KEY", "p1", "users"),
    );
    expect(onEndpointsChange).toHaveBeenCalledWith(cleared);
  });

  it("should surface a delete error inline", async () => {
    mockDelete.mockRejectedValue(new PortalValidationError("slot_not_overridable"));
    const { container } = render(
      <EndpointOverrideForm {...controlled({ endpoints: [usersEp] })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "problem_detail.endpoint_override_clear" }));
    await waitFor(() =>
      expect(container.textContent).toContain("problem_detail.endpoint_error_slot_not_overridable"),
    );
  });

  it("should show an em-dash in the override-active note when there is no default URL", () => {
    const { container } = render(
      <EndpointOverrideForm
        {...controlled({ endpoints: [{ ...usersEp, defaultUrl: undefined }] })}
      />,
    );
    expect(container.textContent).toContain("—");
  });
});
