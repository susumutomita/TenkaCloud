import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";

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

beforeEach(() => {
  window.localStorage.setItem("tenkacloud.portal.locale", "ja");
});

afterEach(() => {
  mockList.mockReset();
  mockPut.mockReset();
  mockDelete.mockReset();
});

function withI18n(node: React.ReactNode) {
  return <I18nProvider>{node}</I18nProvider>;
}

const baseProps = {
  apiBaseUrl: "https://api.x",
  teamLoginKey: "k",
  problemId: "p1",
};

describe("EndpointOverrideForm (Issue #607)", () => {
  it("should call listProblemEndpoints on mount and render the result", async () => {
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
    render(withI18n(<EndpointOverrideForm {...baseProps} />));
    await waitFor(() => expect(screen.getByText("Users service")).toBeInTheDocument());
    expect(screen.getByText("https://ec2/users")).toBeInTheDocument();
    expect(mockList).toHaveBeenCalledWith("https://api.x", "k", "p1");
  });

  it("should not render the registration form and instead show a note for slots with overridable=false", async () => {
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
    render(withI18n(<EndpointOverrideForm {...baseProps} />));
    await waitFor(() => expect(screen.getByText(/この slot は override 不可/)).toBeInTheDocument());
    // overridable=false なら 「登録」 button は出ない
    expect(screen.queryByRole("button", { name: "登録" })).not.toBeInTheDocument();
  });

  it("should not render the section at all when endpoints is empty", async () => {
    mockList.mockResolvedValue({ teamId: "t1", endpoints: [] });
    const { container } = render(withI18n(<EndpointOverrideForm {...baseProps} />));
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    // 「Endpoint 登録」 header が出ていない (= null render)
    expect(container.textContent).not.toContain("Endpoint 登録");
  });

  it("#703: should show a hint including the CFn Output key name instead of raw `-` when effectiveUrl is not yet available (= deploy not complete)", async () => {
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
    render(withI18n(<EndpointOverrideForm {...baseProps} />));
    await waitFor(() => expect(screen.getByText("Users service")).toBeInTheDocument());
    // raw em-dash は表示しない
    expect(screen.queryByText("—")).not.toBeInTheDocument();
    // CFn Output key 名は表示する (= operator 切り分け diagnostic)
    expect(screen.getByText("BaseUrl")).toBeInTheDocument();
    expect(screen.getByText(/まだ取得できていません/)).toBeInTheDocument();
  });

  it("should call putProblemEndpointOverride on the register button and re-render with response endpoints", async () => {
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
    render(withI18n(<EndpointOverrideForm {...baseProps} />));
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

  it("should show a competitor-facing Japanese inline error for PortalValidationError with invalid_url", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({
      teamId: "t1",
      endpoints: [{ slot: "users", overridable: true }],
    });
    mockPut.mockRejectedValue(new PortalValidationError("invalid_url"));
    render(withI18n(<EndpointOverrideForm {...baseProps} />));
    await waitFor(() => expect(screen.getByRole("button", { name: "登録" })).toBeInTheDocument());

    const input = screen.getByPlaceholderText("https://example.com/api");
    await user.type(input, "not-a-url");
    await user.click(screen.getByRole("button", { name: "登録" }));

    await waitFor(() => expect(screen.getByText(/URL の形式が不正です/)).toBeInTheDocument());
  });

  it("should call deleteProblemEndpointOverride when the override-clear button is pressed", async () => {
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
    render(withI18n(<EndpointOverrideForm {...baseProps} />));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "override 解除" })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "override 解除" }));
    await waitFor(() =>
      expect(mockDelete).toHaveBeenCalledWith("https://api.x", "k", "p1", "users"),
    );
  });

  it("should not call the API and show an inline error when trying to register an empty string", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({
      teamId: "t1",
      endpoints: [{ slot: "users", overridable: true }],
    });
    render(withI18n(<EndpointOverrideForm {...baseProps} />));
    await waitFor(() => expect(screen.getByRole("button", { name: "登録" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "登録" }));
    await waitFor(() => expect(screen.getByText("URL を入力してください")).toBeInTheDocument());
    expect(mockPut).not.toHaveBeenCalled();
  });
});
