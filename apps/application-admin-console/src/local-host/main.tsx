import { renderBootError } from "@tenkacloud/web-kit";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { AuthProvider } from "../auth/AuthProvider";
import type { AppConfig } from "../config";
import { I18nProvider } from "../i18n";
import { HostApp } from "./HostApp";

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element.");

async function boot(root: HTMLElement): Promise<void> {
  const response = await fetch("/runtime-config.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Host configuration is unavailable.");
  const runtime = (await response.json()) as {
    mode?: string;
    role?: string;
    apiBaseUrl?: string;
    participantPortalUrl?: string;
  };
  const origin = window.location.origin;
  if (
    runtime.mode !== "local-host" ||
    runtime.role !== "admin" ||
    runtime.apiBaseUrl !== `${origin}/api`
  )
    throw new Error("Invalid local-host configuration. No demo fallback is permitted.");
  const config: AppConfig = {
    apiBaseUrl: runtime.apiBaseUrl,
    tenantId: "local-host",
    tenantName: "Local competition",
    samlIdpDirectory: {},
    // Only the shared memory-only provider's revocation/logout wire protocol is
    // reused. Login is the real host-key exchange below, never a Cognito redirect.
    cognitoDomain: `${origin}/api/host`,
    cognitoClientId: "local-host",
    redirectUri: `${origin}/callback`,
    scope: "",
    participantPortalUrl: runtime.participantPortalUrl,
  };
  createRoot(root).render(
    <StrictMode>
      <I18nProvider>
        <BrowserRouter>
          <AuthProvider config={config}>
            <HostApp config={config} />
          </AuthProvider>
        </BrowserRouter>
      </I18nProvider>
    </StrictMode>,
  );
}
void boot(root).catch((error) => renderBootError(root, error));
