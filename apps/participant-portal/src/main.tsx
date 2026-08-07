import { renderBootError } from "@tenkacloud/web-kit";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { loadConfig } from "./config";
import { AppConfigProvider } from "./config-context";
import { applyRuntimeProblemCatalog } from "./data/catalog-source";
import { I18nProvider } from "./i18n";
import { initializeBrowserDemoAnalytics } from "./onboarding-analytics";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

// LP からの iframe 埋め込み (= subpath `/portal-demo/` 配信) でも routing が動くよう、
// Vite の build `base` を BrowserRouter の basename に渡す。 production の SPA 単独配信
// (= base = `/`) では BASE_URL が `/` になり、 従来挙動と同等。
const ROUTER_BASENAME = import.meta.env.BASE_URL.replace(/\/$/, "") || "/";

loadConfig()
  .then(async (config) => {
    // [#2925 / #2926] local mode はカタログを control plane から取る。 render 前に解決させる
    // ことで、 カタログを読む画面は従来どおり同期 API のままでよい。
    await applyRuntimeProblemCatalog(config);
    initializeBrowserDemoAnalytics({ mode: config.mode, production: import.meta.env.PROD });
    createRoot(root).render(
      <StrictMode>
        <I18nProvider>
          <AppConfigProvider config={config}>
            <BrowserRouter basename={ROUTER_BASENAME}>
              <App config={config} />
            </BrowserRouter>
          </AppConfigProvider>
        </I18nProvider>
      </StrictMode>,
    );
  })
  .catch((err: unknown) => {
    renderBootError(root, err);
  });
