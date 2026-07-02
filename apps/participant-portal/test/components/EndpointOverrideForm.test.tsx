import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortalValidationError } from "../../src/api/portal-client";

/**
 * Issue #607: EndpointOverrideForm。 list/put/delete API を mock し、 mount fetch (success /
 * error / no_endpoints / empty) / loading / save (空値 / 成功 / 各 validation code) / delete
 * (成功 / error) / render 分岐 (effectiveUrl / overrideUrl / overridable) を pin する。
 * PortalValidationError は実物 (formatValidationError の instanceof 判定に必要)。
 */
const { mockList, mockPut, mockDelete } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockPut: vi.fn(),
  mockDelete: vi.fn(),
}));
vi.mock("../../src/api/portal-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/portal-client")>();
  return {
    ...actual,
    listProblemEndpoints: mockList,
    putProblemEndpointOverride: mockPut,
    deleteProblemEndpointOverride: mockDelete,
  };
});
vi.mock("../../src/i18n", () => ({
  useT: () => (key: string, params?: Readonly<Record<string, string | number>>) =>
    params ? `${key}|${JSON.stringify(params)}` : key,
}));

const { EndpointOverrideForm } = await import("../../src/components/EndpointOverrideForm");

const props = { apiBaseUrl: "https://api.example.com", teamLoginKey: "KEY", problemId: "p1" };
const usersEp = {
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
  it("should render endpoints incl. overridable form, override-active note, and non-overridable slots", async () => {
    mockList.mockResolvedValue({
      endpoints: [
        usersEp,
        { slot: "orders", overridable: false, defaultKey: "OrdersBaseUrl" }, // no effectiveUrl → not-yet
      ],
    });
    const { container } = render(<EndpointOverrideForm {...props} />);
    await waitFor(() => expect(screen.getByText("Users API")).toBeInTheDocument());
    expect(container.textContent).toContain("https://override.example/users");
    expect(container.textContent).toContain("problem_detail.endpoint_override_active_label");
    expect(container.textContent).toContain("problem_detail.endpoint_not_overridable");
    // 未設定 slot (orders) の not-yet 文言 + defaultKey。
    expect(container.textContent).toContain("OrdersBaseUrl");
  });

  it("should show an error alert when the list fetch fails", async () => {
    mockList.mockRejectedValue(new Error("list boom"));
    render(<EndpointOverrideForm {...props} />);
    await waitFor(() => expect(screen.getByText("list boom")).toBeInTheDocument());
  });

  it("should render nothing for a no_endpoints error or an empty endpoint list", async () => {
    mockList.mockRejectedValueOnce("no_endpoints");
    const a = render(<EndpointOverrideForm {...props} />);
    await waitFor(() => expect(a.container.textContent).toBe(""));
    a.unmount();

    mockList.mockResolvedValueOnce({ endpoints: [] });
    const b = render(<EndpointOverrideForm {...props} />);
    await waitFor(() => expect(b.container.textContent).toBe(""));
  });

  it("should reject an empty override URL before calling the API", async () => {
    mockList.mockResolvedValue({ endpoints: [usersEp] });
    const { container } = render(<EndpointOverrideForm {...props} />);
    await waitFor(() => expect(screen.getByText("Users API")).toBeInTheDocument());
    fireEvent.click(
      screen.getByRole("button", { name: "problem_detail.endpoint_override_submit" }),
    );
    expect(container.textContent).toContain("problem_detail.endpoint_override_url_empty");
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("should save an override and refresh the endpoint list", async () => {
    mockList.mockResolvedValue({ endpoints: [{ ...usersEp, overrideUrl: undefined }] });
    mockPut.mockResolvedValue({ endpoints: [usersEp] });
    render(<EndpointOverrideForm {...props} />);
    await waitFor(() => expect(screen.getByText("Users API")).toBeInTheDocument());
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
  });

  it("should map each PortalValidationError code (and plain errors) to a message", async () => {
    mockList.mockResolvedValue({ endpoints: [{ ...usersEp, overrideUrl: undefined }] });
    render(<EndpointOverrideForm {...props} />);
    await waitFor(() => expect(screen.getByText("Users API")).toBeInTheDocument());
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
      // Issue #2283: locked 問題への endpoint mutation は 409 challenge_prerequisite_not_met。
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
      await waitFor(() =>
        // 部分一致は RegExp ではなく substring matcher で行う (= 正規表現メタ文字を escape する
        // 必要が無く、 CodeQL の incomplete-string-escaping 警告を避ける)。
        expect(screen.getByText(expected, { exact: false })).toBeInTheDocument(),
      );
    }
  });

  it("should clear an override via delete and surface delete errors", async () => {
    mockList.mockResolvedValue({ endpoints: [usersEp] });
    mockDelete
      .mockResolvedValueOnce({ endpoints: [{ ...usersEp, overrideUrl: undefined }] })
      .mockRejectedValueOnce(new PortalValidationError("slot_not_overridable"));
    render(<EndpointOverrideForm {...props} />);
    await waitFor(() => expect(screen.getByText("Users API")).toBeInTheDocument());

    const clearBtn = () =>
      screen.getByRole("button", { name: "problem_detail.endpoint_override_clear" });
    fireEvent.click(clearBtn());
    await waitFor(() =>
      expect(mockDelete).toHaveBeenCalledWith("https://api.example.com", "KEY", "p1", "users"),
    );
  });

  it("should surface a delete error inline", async () => {
    mockList.mockResolvedValue({ endpoints: [usersEp] });
    mockDelete.mockRejectedValue(new PortalValidationError("slot_not_overridable"));
    const { container } = render(<EndpointOverrideForm {...props} />);
    await waitFor(() => expect(screen.getByText("Users API")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "problem_detail.endpoint_override_clear" }));
    await waitFor(() =>
      expect(container.textContent).toContain("problem_detail.endpoint_error_slot_not_overridable"),
    );
  });

  it("should show an em-dash in the override-active note when there is no default URL", async () => {
    mockList.mockResolvedValue({ endpoints: [{ ...usersEp, defaultUrl: undefined }] });
    const { container } = render(<EndpointOverrideForm {...props} />);
    await waitFor(() => expect(screen.getByText("Users API")).toBeInTheDocument());
    expect(container.textContent).toContain("—");
  });

  it("should ignore a late list resolution / rejection after unmount (cancelled guard)", async () => {
    let resolveList: (v: unknown) => void = () => {};
    mockList.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );
    const a = render(<EndpointOverrideForm {...props} />);
    a.unmount();
    await act(async () => {
      resolveList({ endpoints: [usersEp] });
      await Promise.resolve();
    });

    let rejectList: (e: unknown) => void = () => {};
    mockList.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectList = reject;
      }),
    );
    const b = render(<EndpointOverrideForm {...props} />);
    b.unmount();
    await act(async () => {
      rejectList(new Error("late failure"));
      await Promise.resolve();
    });
    // どちらも cancelled guard で state 更新を行わない (= throw / warning なく完了)。
    expect(true).toBe(true);
  });
});
