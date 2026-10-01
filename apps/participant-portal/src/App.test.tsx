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
vi.mock("./pages/SsoCredentials", () => ({
  SsoCredentialsPage: () => <div>sso-credentials-page</div>,
}));

function renderAt(
  path: string,
  cloudMode: CloudMode,
  hasAws?: boolean,
  courseTracksEnabled = false,
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App
        config={
          {
            cloudMode,
            courseTracksEnabled,
            ...(hasAws !== undefined ? { hasAws } : {}),
          } as AppConfig
        }
      />
    </MemoryRouter>,
  );
}

describe("App routing for the course tracks", () => {
  it("should serve /course-tracks in local mode", () => {
    renderAt("/course-tracks", "local");
    expect(screen.getByText("course-tracks-page")).toBeTruthy();
  });

  it("serves the local-host course route without switching provider or authentication mode", () => {
    renderAt("/course-tracks", "real", false, true);
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

/**
 * Issue #2474 / local-host: /tools/sso is an AWS-only page (Console federation). The old
 * self-paced local mode (`cloudMode === "local"`) already hid it; the local-host build
 * (`make host`, no AWS at all) reuses `cloudMode: "real"` on purpose and signals this
 * separately via `hasAws: false`. Both must keep the route unregistered, not just the nav
 * link, so a direct/bookmarked visit does not render the AWS page.
 */
describe("App routing for the AWS-only SSO Credentials page", () => {
  it("should serve /tools/sso when AWS features are available (real cloud mode)", () => {
    renderAt("/tools/sso", "real");
    expect(screen.getByText("sso-credentials-page")).toBeTruthy();
  });

  it("should not serve /tools/sso in local cloud mode (self-paced practice)", () => {
    renderAt("/tools/sso", "local");
    expect(screen.queryByText("sso-credentials-page")).toBeNull();
    expect(screen.getByText("root-entry-page")).toBeTruthy();
  });

  it("should not serve /tools/sso for the local-host build (real cloud mode, hasAws=false)", () => {
    renderAt("/tools/sso", "real", false);
    expect(screen.queryByText("sso-credentials-page")).toBeNull();
    expect(screen.getByText("root-entry-page")).toBeTruthy();
  });
});
