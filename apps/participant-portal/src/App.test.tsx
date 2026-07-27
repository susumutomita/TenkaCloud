import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { AppConfig, CloudMode } from "./config";

/**
 * `/course-tracks` が URL として生きているかどうか。
 *
 * nav から link を外しただけでは、URL を直接開けば同じ画面が出る。それは
 * 「導線は塞いだが到達経路は残っている」状態で、公開デモの URL は共有もブックマークも
 * されるため、link を消した分だけ気づきにくくなる。ここは route 登録そのものを見る。
 */

vi.mock("./auth/AuthProvider", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("./auth/RequireAuth", () => ({
  RequireAuth: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("./components/AppLayout", () => ({
  ShellLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("./pages/CourseTracks", () => ({
  CourseTracksPage: () => <div>course-tracks-page</div>,
}));
vi.mock("./pages/RootEntry", () => ({
  RootEntryPage: () => <div>root-entry-page</div>,
}));

function renderAt(path: string, cloudMode: CloudMode) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App config={{ cloudMode } as AppConfig} />
    </MemoryRouter>,
  );
}

describe("App routing for the course tracks", () => {
  it("should serve /course-tracks in local mode", () => {
    renderAt("/course-tracks", "local");
    expect(screen.getByText("course-tracks-page")).toBeTruthy();
  });

  it.each(["real", "mock"] as const)("should not serve /course-tracks in %s mode", (mode) => {
    renderAt("/course-tracks", mode);
    // 未登録の path は既存の catch-all で `/` に replace される。落ちるのではなく
    // Home に着く = 共有された URL を踏んでも壊れない。
    expect(screen.queryByText("course-tracks-page")).toBeNull();
    expect(screen.getByText("root-entry-page")).toBeTruthy();
  });
});
