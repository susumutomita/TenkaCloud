import { realpathSync } from "node:fs";
import { build } from "vite";
import { pluginVersionsPlugin } from "../../../build/plugin-versions";

const result = await build({
  configFile: false,
  root: realpathSync(process.argv[2]),
  logLevel: "silent",
  plugins: [pluginVersionsPlugin()],
  build: { minify: false },
});
const output = (Array.isArray(result) ? result[0] : result) as {
  output: { code?: string }[];
};
process.stdout.write(JSON.stringify(output.output.map((item) => item.code ?? "").join("\n")));
