import { createHash } from "node:crypto";
import { createServer } from "node:http";

/**
 * wp-exposed-backup — the loopback `/verify` the TenkaCloud scorer delegates to.
 *
 * This is a multi-checkpoint problem (TenkaCloud#2252): the previous operator
 * left four independent leftovers in the public web root, each with its own audit
 * passphrase. The scorer forwards a submission together with the `checkpointId`
 * it is asking about; this service holds the flags (derived from FLAG_SEED exactly
 * as the WordPress container's seed-and-start.sh derives them, so nothing secret
 * is committed and every deploy is unique) and judges that one checkpoint.
 *
 * Contract (platform side: scripts/local-play/verify-client.ts):
 *   request  { checkpointId, submission, context }
 *   response { checkpointId, correct, message }
 * The response MUST echo the requested checkpointId (the platform rejects a
 * mismatch as a transport failure), MUST NOT return `points` (the platform holds
 * the points; a container override is rejected for multi-verify), and the message
 * must never leak the flag, the expected value, the seed, or a stack trace.
 * Bound to 127.0.0.1 only by the compose file.
 */

const FLAG_SEED = process.env.FLAG_SEED ?? "local-dev-seed";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// checkpointId → flag, matching seed-and-start.sh's flag_for(). The key set here
// is the source of truth for which checkpoints exist; an unknown id is a 4xx.
const FLAG_PREFIX = {
  "public-backup": "wpbackup",
  "exposed-config": "wpconfig",
  "debug-log": "wpdebug",
  "dir-listing": "wpindex",
};
const flagFor = (checkpointId) =>
  `TC{${FLAG_PREFIX[checkpointId]}_${sha256(`flag:${checkpointId}:${FLAG_SEED}`).slice(0, 20)}}`;

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

const verify = createServer(async (request, response) => {
  if (request.method === "GET" && (request.url ?? "/") === "/healthz") {
    return send(response, 200, { status: "ok" });
  }
  if (request.method !== "POST" || (request.url ?? "/") !== "/verify") {
    return send(response, 404, { error: "not_found" });
  }

  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) {
      request.destroy();
      return send(response, 413, { error: "too_large" });
    }
    chunks.push(chunk);
  }

  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return send(response, 400, { error: "invalid_json" });
  }

  const checkpointId = typeof body?.checkpointId === "string" ? body.checkpointId : "";
  // Unknown / missing checkpoint → 4xx. The platform normally rejects unknown ids
  // first (they are not in metadata), so this is defence in depth.
  if (!Object.hasOwn(FLAG_PREFIX, checkpointId)) {
    return send(response, 400, { error: "unknown_checkpoint" });
  }

  const submission = typeof body?.submission === "string" ? body.submission : "";
  if (submission.length < 1 || submission.length > 200) {
    return send(response, 400, { checkpointId, error: "invalid_submission" });
  }

  const correct = submission.trim() === flagFor(checkpointId);
  // Echo the checkpointId; never leak the expected flag or scoring internals.
  send(response, 200, {
    checkpointId,
    correct,
    message: correct ? "Checkpoint cleared." : "That is not the passphrase for this checkpoint.",
  });
});

verify.listen(8081, "0.0.0.0", () => console.log("verify on :8081"));
