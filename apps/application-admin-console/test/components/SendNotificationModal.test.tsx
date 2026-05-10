import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useApiClient: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock("../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/client")>();
  return {
    ...actual,
    useApiClient: mocks.useApiClient,
  };
});

vi.mock("../../src/api/events-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/events-client")>();
  return {
    ...actual,
    createNotification: mocks.createNotification,
  };
});

import type { AppConfig } from "../../src/config";

const config: AppConfig = {
  cognitoDomain: "https://example.auth.ap-northeast-1.amazoncognito.com",
  cognitoClientId: "abc",
  redirectUri: "http://localhost:5174/callback",
  scope: "openid email profile",
  tenantId: "tenant-test",
  tenantName: "Test Tenant",
  apiBaseUrl: "https://api.example.com/prod",
};

const EVENT_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";

const { SendNotificationModal } = await import("../../src/components/SendNotificationModal");

beforeEach(() => {
  vi.clearAllMocks();
  // useApiClient はテストごとに「認証済」 stub を返す。
  mocks.useApiClient.mockReturnValue({});
});

afterEach(() => vi.restoreAllMocks());

describe("SendNotificationModal", () => {
  it("初期状態: title / body 空で 送信 disabled", () => {
    render(
      <SendNotificationModal
        config={config}
        visible={true}
        eventId={EVENT_ID}
        onDismiss={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    const submit = screen.getByRole("button", { name: "送信" });
    expect(submit).toBeDisabled();
  });

  it("title + body 入力後は 送信 enabled", async () => {
    const user = userEvent.setup();
    render(
      <SendNotificationModal
        config={config}
        visible={true}
        eventId={EVENT_ID}
        onDismiss={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    await user.type(screen.getByLabelText("タイトル"), "テスト");
    await user.type(screen.getByLabelText("本文"), "本文");
    expect(screen.getByRole("button", { name: "送信" })).toBeEnabled();
  });

  it("送信成功: createNotification を正しい args で呼び onSuccess を呼ぶ", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    mocks.createNotification.mockResolvedValueOnce({
      notificationId: "01J0",
      occurredAt: "2026-05-10T14:42:00.000Z",
    });

    render(
      <SendNotificationModal
        config={config}
        visible={true}
        eventId={EVENT_ID}
        onDismiss={vi.fn()}
        onSuccess={onSuccess}
      />,
    );
    await user.type(screen.getByLabelText("タイトル"), "scoring 再開");
    await user.type(screen.getByLabelText("本文"), "メンテ完了");
    await user.click(screen.getByRole("button", { name: "送信" }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(mocks.createNotification).toHaveBeenCalledWith({}, EVENT_ID, {
      title: "scoring 再開",
      body: "メンテ完了",
      severity: "info",
    });
  });

  it("送信失敗: API error を Alert に表示し onSuccess は呼ばない", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    mocks.createNotification.mockRejectedValueOnce(new Error("ddb throttled"));

    render(
      <SendNotificationModal
        config={config}
        visible={true}
        eventId={EVENT_ID}
        onDismiss={vi.fn()}
        onSuccess={onSuccess}
      />,
    );
    await user.type(screen.getByLabelText("タイトル"), "T");
    await user.type(screen.getByLabelText("本文"), "B");
    await user.click(screen.getByRole("button", { name: "送信" }));

    await waitFor(() => expect(screen.getByText(/ddb throttled/)).toBeInTheDocument());
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("title が 120 文字超なら errorText を出して 送信 disabled", () => {
    render(
      <SendNotificationModal
        config={config}
        visible={true}
        eventId={EVENT_ID}
        onDismiss={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    const titleInput = screen.getByLabelText("タイトル");
    fireEvent.change(titleInput, { target: { value: "a".repeat(121) } });
    fireEvent.change(screen.getByLabelText("本文"), { target: { value: "b" } });
    expect(screen.getByText(/120 文字以内/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "送信" })).toBeDisabled();
  });
});
