import { runLocalHost } from "./application";

export { runLocalHost } from "./application";

if (import.meta.main) {
  void runLocalHost(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
