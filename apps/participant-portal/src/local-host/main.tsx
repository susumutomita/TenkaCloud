import { renderBootError } from "@tenkacloud/web-kit";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "../App";
import { AppConfigProvider } from "../config-context";
import { I18nProvider } from "../i18n";
import { localCompetitionConfig } from "./config";

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element.");

async function boot(root: HTMLElement): Promise<void> {
  const response = await fetch("/runtime-config.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Competition configuration is unavailable.");
  const runtime = (await response.json()) as {
    mode?: string;
    role?: string;
    apiBaseUrl?: string;
    hasAws?: boolean;
  };
  const config = localCompetitionConfig(runtime, window.location.origin);
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
