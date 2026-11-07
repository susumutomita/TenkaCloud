import { fileURLToPath } from "node:url";
import { buildHosting } from "./build";

export function parseHostBuildOptions(args: string[]): { acceptanceProvenance: boolean } {
  if (args.length === 0) return { acceptanceProvenance: false };
  if (args.length === 1 && args[0] === "--acceptance-provenance")
    return { acceptanceProvenance: true };
  throw new Error("Usage: bun run build:host [--acceptance-provenance]");
}

async function main(): Promise<void> {
  const options = parseHostBuildOptions(process.argv.slice(2));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  await buildHosting(root, "full", options);
}

if (import.meta.main)
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
