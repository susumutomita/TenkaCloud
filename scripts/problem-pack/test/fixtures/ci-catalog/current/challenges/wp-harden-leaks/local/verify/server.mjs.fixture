import { existsSync } from "node:fs";
import { createServer } from "node:http";

/**
 * wp-harden-leaks — the loopback `/verify` the TenkaCloud scorer delegates to, acting as
 * an EXTERNAL SCANNER for a remediation problem (state-based, no flags).
 *
 * The player closes each leak the previous operator left; for each checkpoint this
 * service HTTP-probes the LIVE WordPress container over the compose network
 * (http://wordpress/ — the internal :80, NOT the host-published :18080) and returns
 * `correct: true` only when that surface is genuinely no longer reachable. The submission
 * is just a re-scan trigger. Nothing secret lives here.
 *
 * Contract (platform side: scripts/local-play/verify-client.ts):
 *   request  { checkpointId, submission, context }
 *   response { checkpointId, correct, message }
 * MUST return HTTP 200 even when the hole is still open (a still-open hole is
 * `correct:false`, not an error), MUST echo the requested checkpointId, and MUST NOT
 * return `points` (the platform holds them). The message must not spoil the fix. Bound to
 * 127.0.0.1 by the compose file; listens on 0.0.0.0 inside the container.
 */

const WP = "http://wordpress"; // compose service-name DNS, internal port 80
const CHECKPOINTS = new Set(["close-backup", "close-config", "close-listing", "close-debug"]);

/**
 * The marker `wpinit` writes as the last thing it does, on the docroot volume this
 * container mounts read-only.
 *
 * Every check below is "the scanner can no longer reach this", and **an unseeded site is
 * indistinguishable from a perfectly remediated one**: nothing has been planted, so every
 * probe 404s and every checkpoint reads as closed. Without this gate a scan that landed
 * before `wpinit` finished would hand over all 200 points for doing nothing, and it would
 * do it silently — a green result, no error anywhere.
 *
 * So the scanner refuses to score until the marker exists. Checked per request rather
 * than once at boot, because the compose ordering is a `depends_on` condition and this is
 * the check that has to hold even if that ordering is ever weakened. Failing this way
 * costs a participant a confusing minute at startup; failing the other way costs the
 * problem its entire meaning.
 */
const SEED_MARKER = "/wp/.tenkacloud-seeded";

// Probe helper: fetch with a hard timeout, no redirect following, small body cap.
// Returns { status, body }; status 0 means the site was unreachable (→ cannot confirm
// the hole is closed, so we treat it as "not closed yet").
async function probe(path, { readBody = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${WP}${path}`, {
      redirect: "manual",
      signal: controller.signal,
      headers: { "user-agent": "tenkacloud-scanner" },
    });
    let body = "";
    if (readBody) body = (await res.text()).slice(0, 8192);
    return { status: res.status, body };
  } catch {
    return { status: 0, body: "" };
  } finally {
    clearTimeout(timer);
  }
}

// A leftover file is still exposed when Apache serves it with 200. Once removed, the
// path answers 404 (or 403) — that is "closed". status 0 = site unreachable.
const stillServed = (status) => status === 200;

async function isClosed(checkpointId) {
  switch (checkpointId) {
    case "close-backup": {
      const { status } = await probe("/wp-content/backups/db-backup.sql");
      return status !== 0 && !stillServed(status);
    }
    case "close-config": {
      const { status } = await probe("/wp-config.php.bak");
      return status !== 0 && !stillServed(status);
    }
    case "close-listing": {
      const { status, body } = await probe("/internal/", { readBody: true });
      if (status === 0) return false; // unreachable → cannot confirm
      // Closed if /internal/ no longer produces an Apache autoindex listing: a 403/404
      // (listing disabled or folder removed), or a 200 that is a real index page (an
      // index.html was added) rather than the "Index of /internal" autoindex.
      if (status !== 200) return true;
      return !/Index of \/internal/i.test(body);
    }
    case "close-debug": {
      // The trap: hit the homepage first so a still-on debug logger REGENERATES the log,
      // then probe the log. Only the real fix (WP_DEBUG off) keeps it gone.
      await probe("/");
      await new Promise((resolve) => setTimeout(resolve, 250)); // let the write flush
      const { status } = await probe("/wp-content/debug.log");
      return status !== 0 && !stillServed(status);
    }
    default:
      return false;
  }
}

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

const server = createServer(async (request, response) => {
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
  if (!CHECKPOINTS.has(checkpointId)) {
    return send(response, 400, { error: "unknown_checkpoint" });
  }
  const submission = typeof body?.submission === "string" ? body.submission : "";
  if (submission.length < 1 || submission.length > 200) {
    return send(response, 400, { checkpointId, error: "invalid_submission" });
  }

  if (!existsSync(SEED_MARKER)) {
    // Fail closed. 200 with correct:false keeps the platform contract (a not-yet-closed
    // hole is not an error) while making it impossible to score an unseeded site.
    return send(response, 200, {
      checkpointId,
      correct: false,
      message: "The site is still starting up. Wait a moment, then re-scan.",
    });
  }

  let closed = false;
  try {
    closed = await isClosed(checkpointId);
  } catch {
    closed = false;
  }
  // Echo the checkpointId; never return points; never spoil how to fix it.
  send(response, 200, {
    checkpointId,
    correct: closed,
    message: closed
      ? "Closed — the scanner can no longer reach it."
      : "Still reachable from the outside — not closed yet. Fix it, then re-scan.",
  });
});

server.listen(8081, "0.0.0.0", () => console.log("scanner/verify on :8081"));
