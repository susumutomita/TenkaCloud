import { renderBootError } from "@tenkacloud/web-kit";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "../App";
import type { AppConfig } from "../config";
import { AppConfigProvider } from "../config-context";
import { I18nProvider } from "../i18n";

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element.");

async function boot(root: HTMLElement): Promise<void> {
  const response = await fetch("/runtime-config.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Competition configuration is unavailable.");
  const runtime = (await response.json()) as {
    mode?: string;
    role?: string;
    apiBaseUrl?: string;
  };
  const expected = `${window.location.origin}/api`;
  if (
    runtime.mode !== "local-host" ||
    runtime.role !== "participant" ||
    runtime.apiBaseUrl !== expected
  )
    throw new Error(
      "Invalid competition configuration. No demo or automatic-login fallback is permitted.",
    );
  // The normal competition portal and its real team-key login are reused. This
  // entry cannot acquire localTeamLoginKey or activate the individual-practice UI.
  const config: AppConfig = {
    apiBaseUrl: expected,
    eventTitle: "TenkaCloud Local Competition",
    eventRegion: "local",
    mode: "backend",
    cloudMode: "real",
  };
  createRoot(root).render(
    <StrictMode>
      <I18nProvider>
        <AppConfigProvider config={config}>
          <BrowserRouter>
            <App config={config} />
          </BrowserRouter>
        </AppConfigProvider>
      </I18nProvider>
    </StrictMode>,
  );
}
void boot(root).catch((error) => renderBootError(root, error));
