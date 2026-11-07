import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { Agent, request } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";
import { SimulatorFixtureError } from "./simulator-fixture-process";

/** Stream even large WASM assets through a direct numeric socket with fixed bounds. */
async function servedDigest(url: URL, expectedSize: number): Promise<string> {
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    expectedSize > 64 * 1024 * 1024
  )
    throw new SimulatorFixtureError("Invalid fixture asset request.");
  const agent = new Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = () => createConnection({ host: "127.0.0.1", port: Number(url.port) });
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (digest?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      agent.destroy();
      if (digest) resolve(digest);
      else reject(new SimulatorFixtureError("The host did not serve the expected built UI asset."));
    };
    const outgoing = request(
      url,
      {
        agent,
        headers: { "accept-encoding": "identity" },
      },
      (incoming) => {
        if (
          incoming.statusCode !== 200 ||
          (incoming.headers["content-encoding"] ?? "identity") !== "identity"
        ) {
          incoming.destroy();
          finish();
          return;
        }
        const hash = createHash("sha256");
        let size = 0;
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > expectedSize) {
            incoming.destroy();
            finish();
          } else hash.update(chunk);
        });
        incoming.once("end", () => finish(size === expectedSize ? hash.digest("hex") : undefined));
        incoming.once("error", () => finish());
      },
    );
    const timer = setTimeout(() => {
      outgoing.destroy();
      finish();
    }, 5000);
    outgoing.once("error", () => finish());
    outgoing.end();
  });
}

/** Verify actual served bytes against the validated on-disk manifest, not just HTTP 200. */
export async function verifyServedFixtureAssets(
  root: string,
  provenance: { artifacts: readonly { path: string; sha256: string }[] },
  origins: { adminOrigin: string; participantOrigin: string },
): Promise<void> {
  for (const artifact of provenance.artifacts) {
    const [app, ...segments] = artifact.path.split("/");
    const origin =
      app === "application-admin-console" ? origins.adminOrigin : origins.participantOrigin;
    if (
      !["application-admin-console", "participant-portal"].includes(app ?? "") ||
      segments.length === 0 ||
      segments.some((segment) => !segment || segment === "." || segment === "..")
    )
      throw new SimulatorFixtureError("Invalid UI artifact path in the fixture manifest.");
    const pathname =
      segments.join("/") === "host.html" ? "/" : `/${segments.map(encodeURIComponent).join("/")}`;
    const size = statSync(join(root, ".tenkacloud/host-build", artifact.path)).size;
    if ((await servedDigest(new URL(pathname, origin), size)) !== artifact.sha256)
      throw new SimulatorFixtureError("The served UI asset differs from its build provenance.");
  }
}
