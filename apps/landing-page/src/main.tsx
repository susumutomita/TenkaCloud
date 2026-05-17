import "@cloudscape-design/global-styles/index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { loadConfig } from "./config";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

loadConfig()
  .then((config) => {
    createRoot(root).render(
      <StrictMode>
        <App config={config} />
      </StrictMode>,
    );
  })
  .catch((err: Error) => {
    root.innerHTML = `<pre style="padding: 2rem; color: #a00; font-family: monospace;">Config load failed: ${err.message}</pre>`;
  });
