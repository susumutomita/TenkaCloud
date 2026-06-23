import { renderBootError } from "@tenkacloud/web-kit";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { loadConfig } from "./config";
import { I18nProvider } from "./i18n";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

// Issue #1954: Vite の build `base` を BrowserRouter の basename に渡す (= participant-portal と同じ)。
// `/demo/` ホスティング (base=/TenkaCloud/admin-demo/) で routing と asset path の両方を解決する。
// SPA 単独配信 (base=`/`) では BASE_URL が `/` になり従来挙動と同等。
const ROUTER_BASENAME = import.meta.env.BASE_URL.replace(/\/$/, "") || "/";

loadConfig()
  .then((config) => {
    createRoot(root).render(
      <StrictMode>
        <I18nProvider>
          <BrowserRouter basename={ROUTER_BASENAME}>
            <App config={config} />
          </BrowserRouter>
        </I18nProvider>
      </StrictMode>,
    );
  })
  .catch((err: unknown) => {
    renderBootError(root, err);
  });
