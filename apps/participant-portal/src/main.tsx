import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { loadConfig } from "./config";
import { I18nProvider } from "./i18n";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

// LP からの iframe 埋め込み (= subpath `/portal-demo/` 配信) でも routing が動くよう、
// Vite の build `base` を BrowserRouter の basename に渡す。 production の SPA 単独配信
// (= base = `/`) では BASE_URL が `/` になり、 従来挙動と同等。
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
  .catch((err: Error) => {
    root.innerHTML = `<pre style="padding: 2rem; color: #a00; font-family: monospace;">Config load failed: ${err.message}</pre>`;
  });
