import { fileURLToPath } from "node:url";
import { buildHosting } from "./build";
const root = fileURLToPath(new URL("../../", import.meta.url));
void buildHosting(root).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
