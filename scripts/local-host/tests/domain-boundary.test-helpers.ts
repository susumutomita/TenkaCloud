import { assertPortableDomain } from "../../quality/portable-domain";

if (!process.send) throw new Error("Checker requires its private test IPC channel.");
process.on("message", (request: { root: string; roots?: string[] }) => {
  try {
    process.send?.({ ok: true, files: assertPortableDomain(request.root, request.roots) });
  } catch (error) {
    process.send?.({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
process.send({ ready: true });
