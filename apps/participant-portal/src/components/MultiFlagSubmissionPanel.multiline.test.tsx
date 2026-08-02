import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppConfigProvider } from "../config-context";
import { I18nProvider } from "../i18n";
import { MultiFlagSubmissionPanel } from "./MultiFlagSubmissionPanel";

const apiMocks = vi.hoisted(() => ({ submitFlag: vi.fn() }));

vi.mock("../api/portal-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/portal-client")>();
  return { ...actual, submitFlag: apiMocks.submitFlag };
});

function renderPanel() {
  return render(
    <AppConfigProvider
      config={{
        apiBaseUrl: "https://api.example.com",
        eventTitle: "Test event",
        eventRegion: "ap-northeast-1",
        mode: "backend",
        cloudMode: "real",
      }}
    >
      <I18nProvider>
        <MemoryRouter>
          <MultiFlagSubmissionPanel
            apiBaseUrl="https://api.example.com"
            sessionToken="team-key"
            problemId="ac26-w2-secret-sharing"
            flags={[
              {
                id: "share-and-reconstruct",
                label: "Share and reconstruct",
                points: 50,
                solved: false,
              },
            ]}
            onScored={async () => undefined}
          />
        </MemoryRouter>
      </I18nProvider>
    </AppConfigProvider>,
  );
}

describe("MultiFlagSubmissionPanel multiline submissions", () => {
  beforeEach(() => {
    window.localStorage.setItem("tenkacloud.portal.locale", "en");
    apiMocks.submitFlag.mockReset();
  });

  it("preserves Python newlines and indentation when submitting a checkpoint", async () => {
    const source = [
      "def reconstruct(shares, modulus):",
      "    total = 0",
      "    for share in shares:",
      "        total += share",
      "    return total % modulus",
    ].join("\n");
    apiMocks.submitFlag.mockResolvedValue({
      kind: "wrong",
      scoreDelta: 0,
      totalScore: 0,
      wrongCount: 1,
    });

    const user = userEvent.setup();
    renderPanel();
    const field = screen.getByRole("textbox", { name: "Share and reconstruct" });
    expect(field.tagName).toBe("TEXTAREA");
    await user.click(field);
    await user.paste(source);
    await user.click(screen.getByRole("button", { name: /^Submit/ }));

    await waitFor(() =>
      expect(apiMocks.submitFlag).toHaveBeenCalledWith(
        "https://api.example.com",
        "team-key",
        "ac26-w2-secret-sharing",
        source,
        "share-and-reconstruct",
      ),
    );
  });
});
