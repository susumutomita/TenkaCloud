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
  samlIdpDirectory: {},
};

const EVENT_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";

const { formatNotificationSubmitError, isNotificationDraftValid, SendNotificationModal } =
  await import("../../src/components/SendNotificationModal");
const { I18nProvider } = await import("../../src/i18n");
const { ApiError } = await import("../../src/api/client");

function withI18n(node: React.ReactNode) {
  return <I18nProvider>{node}</I18nProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useApiClient.mockReturnValue({});
  window.localStorage.setItem("tenkacloud.application-admin.locale", "ja");
});

afterEach(() => vi.restoreAllMocks());

describe("SendNotificationModal", () => {
  it("should disable submit when title and body are empty (initial state)", () => {
    render(
      withI18n(
        <SendNotificationModal
          config={config}
          visible={true}
          eventId={EVENT_ID}
          onDismiss={vi.fn()}
          onSuccess={vi.fn()}
        />,
      ),
    );
    const submit = screen.getByRole("button", { name: "送信" });
    expect(submit).toBeDisabled();
  });

  it("should enable submit after title and body are filled", async () => {
    const user = userEvent.setup();
    render(
      withI18n(
        <SendNotificationModal
          config={config}
          visible={true}
          eventId={EVENT_ID}
          onDismiss={vi.fn()}
          onSuccess={vi.fn()}
        />,
      ),
    );
    await user.type(screen.getByLabelText("タイトル"), "テスト");
    await user.type(screen.getByLabelText("本文"), "本文");
    expect(screen.getByRole("button", { name: "送信" })).toBeEnabled();
  });

  it("should call createNotification with correct args and invoke onSuccess on success", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    mocks.createNotification.mockResolvedValueOnce({
      notificationId: "01J0",
      occurredAt: "2026-05-10T14:42:00.000Z",
    });

    render(
      withI18n(
        <SendNotificationModal
          config={config}
          visible={true}
          eventId={EVENT_ID}
          onDismiss={vi.fn()}
          onSuccess={onSuccess}
        />,
      ),
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

  it("should show API error in Alert and NOT call onSuccess on failure", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    mocks.createNotification.mockRejectedValueOnce(new Error("ddb throttled"));

    render(
      withI18n(
        <SendNotificationModal
          config={config}
          visible={true}
          eventId={EVENT_ID}
          onDismiss={vi.fn()}
          onSuccess={onSuccess}
        />,
      ),
    );
    await user.type(screen.getByLabelText("タイトル"), "T");
    await user.type(screen.getByLabelText("本文"), "B");
    await user.click(screen.getByRole("button", { name: "送信" }));

    await waitFor(() => expect(screen.getByText(/ddb throttled/)).toBeInTheDocument());
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("should show errorText and disable submit when title exceeds 120 characters", () => {
    render(
      withI18n(
        <SendNotificationModal
          config={config}
          visible={true}
          eventId={EVENT_ID}
          onDismiss={vi.fn()}
          onSuccess={vi.fn()}
        />,
      ),
    );
    const titleInput = screen.getByLabelText("タイトル");
    fireEvent.change(titleInput, { target: { value: "a".repeat(121) } });
    fireEvent.change(screen.getByLabelText("本文"), { target: { value: "b" } });
    expect(screen.getByText(/120 文字以内/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "送信" })).toBeDisabled();
  });
});

describe("SendNotificationModal helpers", () => {
  it("should allow submit when title and body are non-empty and within limits", () => {
    expect(isNotificationDraftValid({ title: "T", body: "B" })).toBe(true);
  });

  it("should disallow submit when title or body is empty or exceeds the limit", () => {
    expect(isNotificationDraftValid({ title: "", body: "B" })).toBe(false);
    expect(isNotificationDraftValid({ title: "T", body: "" })).toBe(false);
    expect(isNotificationDraftValid({ title: "a".repeat(121), body: "B" })).toBe(false);
    expect(isNotificationDraftValid({ title: "T", body: "b".repeat(2001) })).toBe(false);
  });

  it("should format ApiError into a message that includes status", () => {
    expect(formatNotificationSubmitError(new ApiError(403, "forbidden"))).toBe(
      "403: API 403: forbidden",
    );
  });

  it("should stringify values that are not Error", () => {
    expect(formatNotificationSubmitError("failed")).toBe("failed");
  });
});
