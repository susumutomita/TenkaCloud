import { afterEach, describe, expect, it } from "vitest";
import type { EventStatus, EventSummary } from "../api/events-client";
import {
  deriveSetupGuideProgress,
  readSetupGuideDismissed,
  resolveSetupStepHref,
  SETUP_GUIDE_DISMISSED_KEY,
  writeSetupGuideDismissed,
} from "./setup-guide";

/**
 * Issue #1773: Tenant Admin 初回セットアップガイドの完了判定 (純関数) を pin する。
 * 完了状態は tenant 内の既存データ (EventSummary 一覧) からのみ導出する:
 *   - create_event: event が 1 件以上
 *   - select_problems: いずれかの event に problem が 1 件以上
 *   - register_teams: いずれかの event に team が 1 件以上
 *   - deploy: いずれかの event が deploy 起動済 status (DEPLOYING/READY/ENDED/TEARDOWN)
 */

const ev = (over: Partial<EventSummary> = {}): EventSummary => ({
  eventId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
  name: "Ev",
  status: "DRAFT",
  teamCount: 0,
  problemCount: 0,
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-01T00:00:00Z",
  expiresAt: 0,
  ...over,
});

const stepById = (events: readonly EventSummary[], id: string) => {
  const step = deriveSetupGuideProgress(events).steps.find((s) => s.id === id);
  if (!step) throw new Error(`step not found: ${id}`);
  return step;
};

describe("deriveSetupGuideProgress", () => {
  it("should mark every step incomplete when the tenant has no events", () => {
    const progress = deriveSetupGuideProgress([]);
    expect(progress.steps.map((s) => s.id)).toEqual([
      "create_event",
      "select_problems",
      "register_teams",
      "deploy",
    ]);
    expect(progress.steps.every((s) => !s.complete)).toBe(true);
    expect(progress.completedCount).toBe(0);
    expect(progress.totalCount).toBe(4);
    expect(progress.allComplete).toBe(false);
  });

  it("should complete create_event when at least one event exists while later steps stay incomplete", () => {
    const progress = deriveSetupGuideProgress([ev()]);
    expect(stepById([ev()], "create_event").complete).toBe(true);
    expect(progress.completedCount).toBe(1);
    expect(progress.allComplete).toBe(false);
  });

  it("should complete select_problems when any event has at least one problem", () => {
    expect(stepById([ev({ problemCount: 1 })], "select_problems").complete).toBe(true);
    expect(stepById([ev({ problemCount: 0 })], "select_problems").complete).toBe(false);
  });

  it("should complete register_teams when any event has at least one team", () => {
    expect(stepById([ev({ teamCount: 2 })], "register_teams").complete).toBe(true);
    expect(stepById([ev({ teamCount: 0 })], "register_teams").complete).toBe(false);
  });

  it("should complete deploy for every status that implies a deploy was requested", () => {
    const deployed: EventStatus[] = ["DEPLOYING", "READY", "ENDED", "TEARDOWN"];
    for (const status of deployed) {
      expect(stepById([ev({ status })], "deploy").complete).toBe(true);
    }
  });

  it("should keep deploy incomplete for DRAFT and ARCHIVED events", () => {
    const notDeployed: EventStatus[] = ["DRAFT", "ARCHIVED"];
    for (const status of notDeployed) {
      expect(stepById([ev({ status })], "deploy").complete).toBe(false);
    }
  });

  it("should derive each step independently across multiple events", () => {
    const events = [ev({ problemCount: 1 }), ev({ eventId: "e2", teamCount: 3 })];
    expect(stepById(events, "select_problems").complete).toBe(true);
    expect(stepById(events, "register_teams").complete).toBe(true);
    expect(stepById(events, "deploy").complete).toBe(false);
  });

  it("should report allComplete when a deployed event has problems and teams", () => {
    const progress = deriveSetupGuideProgress([
      ev({ status: "READY", problemCount: 2, teamCount: 3 }),
    ]);
    expect(progress.completedCount).toBe(4);
    expect(progress.allComplete).toBe(true);
  });
});

describe("resolveSetupStepHref", () => {
  it("should point create_event and register_teams at the event wizard and select_problems at the catalog", () => {
    expect(resolveSetupStepHref("create_event", [])).toBe("/events/new");
    expect(resolveSetupStepHref("register_teams", [])).toBe("/events/new");
    expect(resolveSetupStepHref("select_problems", [])).toBe("/problems");
  });

  it("should point deploy at the first non-archived event detail", () => {
    const events = [ev({ eventId: "old", status: "ARCHIVED" }), ev({ eventId: "e1" })];
    expect(resolveSetupStepHref("deploy", events)).toBe("/events/e1");
  });

  it("should point deploy at the event wizard when no deployable event exists", () => {
    expect(resolveSetupStepHref("deploy", [])).toBe("/events/new");
    expect(resolveSetupStepHref("deploy", [ev({ status: "ARCHIVED" })])).toBe("/events/new");
  });
});

describe("setup guide dismissal persistence", () => {
  afterEach(() => {
    window.localStorage.removeItem(SETUP_GUIDE_DISMISSED_KEY);
  });

  it("should read false while the dismissed flag is unset and true after writing it", () => {
    expect(readSetupGuideDismissed()).toBe(false);
    writeSetupGuideDismissed();
    expect(window.localStorage.getItem(SETUP_GUIDE_DISMISSED_KEY)).toBe("true");
    expect(readSetupGuideDismissed()).toBe(true);
  });

  it("should fail safe to visible (false) when localStorage is unavailable", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
      },
    });
    try {
      expect(readSetupGuideDismissed()).toBe(false);
      expect(() => writeSetupGuideDismissed()).not.toThrow();
    } finally {
      // original は jsdom が必ず提供する (= undefined 不到達) が、型上 optional なので guard。
      if (original) Object.defineProperty(window, "localStorage", original);
    }
  });
});
