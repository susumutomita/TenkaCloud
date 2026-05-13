import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #607 / ADR-012 Phase 3.A UI: EndpointOverrideForm の振る舞い pin。
 *
 * portal-client API を mock し、 list 成功 / validation error / delete の 3 path を検証。
 * cloudscape は実 component を render (= label / button / input が出ることだけ確認)。
 */

vi.mock("../api/portal-client", async () => {
  const actual =
    await vi.importActual<typeof import("../api/portal-client")>("../api/portal-client");
  return {
    ...actual,
    listProblemEndpoints: vi.fn(),
    putProblemEndpointOverride: vi.fn(),
    deleteProblemEndpointOverride: vi.fn(),
  };
});

const {
  listProblemEndpoints,
  putProblemEndpointOverride,
  deleteProblemEndpointOverride,
  PortalValidationError,
} = await import("../api/portal-client");
const { EndpointOverrideForm } = await import("./EndpointOverrideForm");

const mockList = listProblemEndpoints as ReturnType<typeof vi.fn>;
const mockPut = putProblemEndpointOverride as ReturnType<typeof vi.fn>;
const mockDelete = deleteProblemEndpointOverride as ReturnType<typeof vi.fn>;

afterEach(() => {
  mockList.mockReset();
  mockPut.mockReset();
  mockDelete.mockReset();
});

const baseProps = {
  apiBaseUrl: "https://api.x",
  teamLoginKey: "k",
  problemId: "p1",
};

describe("EndpointOverrideForm (Issue #607)", () => {
  it("mount 時に listProblemEndpoints を呼んで結果を render すべき", async () => {
    mockList.mockResolvedValue({
      teamId: "t1",
      endpoints: [
        {
          slot: "users",
          overridable: true,
          label: "Users service",
          defaultUrl: "https://ec2/users",
          effectiveUrl: "https://ec2/users",
        },
      ],
    });
    render(<EndpointOverrideForm {...baseProps} />);
    await waitFor(() => expect(screen.getByText("Users service")).toBeInTheDocument());
    expect(screen.getByText("https://ec2/users")).toBeInTheDocument();
    expect(mockList).toHaveBeenCalledWith("https://api.x", "k", "p1");
  });

  it("overridable=false の slot は登録 form を出さず注記を出すべき", async () => {
    mockList.mockResolvedValue({
      teamId: "t1",
      endpoints: [
        {
          slot: "fixed",
          overridable: false,
          defaultUrl: "https://fixed.example/",
          effectiveUrl: "https://fixed.example/",
        },
      ],
    });
    render(<EndpointOverrideForm {...baseProps} />);
    await waitFor(() => expect(screen.getByText(/この slot は override 不可/)).toBeInTheDocument());
    // overridable=false なら 「登録」 button は出ない
    expect(screen.queryByRole("button", { name: "登録" })).not.toBeInTheDocument();
  });

  it("endpoints が空配列なら section ごと render しないべき", async () => {
    mockList.mockResolvedValue({ teamId: "t1", endpoints: [] });
    const { container } = render(<EndpointOverrideForm {...baseProps} />);
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    // 「Endpoint 登録」 header が出ていない (= null render)
    expect(container.textContent).not.toContain("Endpoint 登録");
  });

  it("#703: effectiveUrl 未取得 (= deploy 未完) なら raw `-` ではなく CFn Output key 名入りの hint を出すべき", async () => {
    mockList.mockResolvedValue({
      teamId: "t1",
      endpoints: [
        {
          slot: "users",
          overridable: true,
          label: "Users service",
          defaultKey: "BaseUrl",
          // defaultUrl / effectiveUrl は undefined (= stackOutputs に BaseUrl がまだ無い)
        },
      ],
    });
    render(<EndpointOverrideForm {...baseProps} />);
    await waitFor(() => expect(screen.getByText("Users service")).toBeInTheDocument());
    // raw em-dash は表示しない
    expect(screen.queryByText("—")).not.toBeInTheDocument();
    // CFn Output key 名は表示する (= operator 切り分け diagnostic)
    expect(screen.getByText("BaseUrl")).toBeInTheDocument();
    expect(screen.getByText(/まだ取得できていません/)).toBeInTheDocument();
  });

  it("登録ボタンで putProblemEndpointOverride を呼び、 response の endpoints で再描画すべき", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({
      teamId: "t1",
      endpoints: [
        {
          slot: "users",
          overridable: true,
          defaultUrl: "https://ec2/users",
          effectiveUrl: "https://ec2/users",
        },
      ],
    });
    mockPut.mockResolvedValue({
      teamId: "t1",
      endpoints: [
        {
          slot: "users",
          overridable: true,
          defaultUrl: "https://ec2/users",
          overrideUrl: "https://lambda.example/",
          effectiveUrl: "https://lambda.example/",
        },
      ],
    });
    render(<EndpointOverrideForm {...baseProps} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "登録" })).toBeInTheDocument());

    const input = screen.getByPlaceholderText("https://example.com/api");
    await user.type(input, "https://lambda.example/");
    await user.click(screen.getByRole("button", { name: "登録" }));

    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        "https://api.x",
        "k",
        "p1",
        "users",
        "https://lambda.example/",
      );
    });
    // 再描画で effective URL が override 値になる
    await waitFor(() => expect(screen.getByText("https://lambda.example/")).toBeInTheDocument());
  });

  it("invalid_url の PortalValidationError は競技者向け日本語 inline error を出すべき", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({
      teamId: "t1",
      endpoints: [{ slot: "users", overridable: true }],
    });
    mockPut.mockRejectedValue(new PortalValidationError("invalid_url"));
    render(<EndpointOverrideForm {...baseProps} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "登録" })).toBeInTheDocument());

    const input = screen.getByPlaceholderText("https://example.com/api");
    await user.type(input, "not-a-url");
    await user.click(screen.getByRole("button", { name: "登録" }));

    await waitFor(() => expect(screen.getByText(/URL の形式が不正です/)).toBeInTheDocument());
  });

  it("override 解除ボタンで deleteProblemEndpointOverride を呼ぶべき", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({
      teamId: "t1",
      endpoints: [
        {
          slot: "users",
          overridable: true,
          defaultUrl: "https://ec2/users",
          overrideUrl: "https://lambda/",
          effectiveUrl: "https://lambda/",
        },
      ],
    });
    mockDelete.mockResolvedValue({
      teamId: "t1",
      endpoints: [
        {
          slot: "users",
          overridable: true,
          defaultUrl: "https://ec2/users",
          effectiveUrl: "https://ec2/users",
        },
      ],
    });
    render(<EndpointOverrideForm {...baseProps} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "override 解除" })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "override 解除" }));
    await waitFor(() =>
      expect(mockDelete).toHaveBeenCalledWith("https://api.x", "k", "p1", "users"),
    );
  });

  it("空文字を登録しようとしたら API を呼ばず inline error を出すべき", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({
      teamId: "t1",
      endpoints: [{ slot: "users", overridable: true }],
    });
    render(<EndpointOverrideForm {...baseProps} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "登録" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "登録" }));
    await waitFor(() => expect(screen.getByText("URL を入力してください")).toBeInTheDocument());
    expect(mockPut).not.toHaveBeenCalled();
  });
});
