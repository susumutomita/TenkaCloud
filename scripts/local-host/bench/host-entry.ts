import { writeSync } from "node:fs";
import { runLocalHost } from "../main";

/** The benchmark uses the production engine and listeners, with a private parent-only key pipe. */
void runLocalHost(process.argv.slice(2), {
  onReady(host) {
    // Benchmark state belongs to this run; a retained database needs a fresh key on restart.
    const key = host.organizerKey ?? host.rotateOrganizerKey();
    writeSync(3, `${key}\n`);
  },
}).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
