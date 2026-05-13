import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { loadConfig } from "./config";
import { I18nProvider } from "./i18n";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

loadConfig()
  .then((config) => {
    createRoot(root).render(
      <StrictMode>
        <I18nProvider>
          <BrowserRouter>
            <App config={config} />
          </BrowserRouter>
        </I18nProvider>
      </StrictMode>,
    );
  })
  .catch((err: Error) => {
    root.innerHTML = `<pre style="padding: 2rem; color: #a00; font-family: monospace;">Config load failed: ${err.message}</pre>`;
  });
