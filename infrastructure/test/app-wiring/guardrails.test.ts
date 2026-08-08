import { describe, expect, it } from "vitest";
import { budgetNotificationEmails } from "../../lib/app-wiring/wire/guardrails";

describe("budgetNotificationEmails", () => {
  it("should not subscribe the system administrator implicitly", () => {
    expect(
      budgetNotificationEmails({
        systemAdminEmail: "admin@example.com",
        budgetAlarmEmails: undefined,
      }),
    ).toBeUndefined();
  });

  it("should subscribe only explicitly configured budget recipients", () => {
    expect(
      budgetNotificationEmails({
        systemAdminEmail: "admin@example.com",
        budgetAlarmEmails: ["billing@example.com", "billing@example.com", "ops@example.com"],
      }),
    ).toEqual(["billing@example.com", "ops@example.com"]);
  });

  it("should treat an explicit empty list as no subscriptions", () => {
    expect(
      budgetNotificationEmails({
        systemAdminEmail: "admin@example.com",
        budgetAlarmEmails: [],
      }),
    ).toBeUndefined();
  });
});
