import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

/**
 * wp2shell-local-lab -- a SELF-CONTAINED SIMULATOR for TenkaCloud local play.
 *
 * This is NOT WordPress and does not embed, vendor, or adapt any WordPress core
 * code. It is a from-scratch mock of a WordPress-SHAPED REST surface, written to
 * teach the *shape* of a real disclosed bug class -- an unauthenticated request
 * path that reaches a cross-component failure between REST "batch" routing and
 * SQL query construction -- without shipping, deploying, or exposing anything
 * that is actually exploitable against a real WordPress site. There is no shell
 * access, no child_process / exec / eval anywhere in this file, and no outbound
 * network call is ever made (the lab network is `internal: true`, and the second
 * network that exists only to publish the loopback ports has IP masquerade
 * disabled, so it has no return route either; see docker-compose.yml).
 * scripts/wp2shell-local-lab.test.ts asserts both of those facts so a regression
 * fails CI, not just a reviewer's eyeball.
 *
 * Two servers run in one process (same pattern as challenges/sqli-demo):
 *   :8080  the challenge surface (the mock REST API the participant attacks, then
 *          the /admin/* console the same participant, now acting as the
 *          responding SRE, uses to remediate)
 *   :8081  the loopback `/verify` endpoint the TenkaCloud scorer delegates to
 *          (multi-verify, 8 checkpoints)
 *
 * ---- The bug, in one paragraph -------------------------------------------
 * Two dispatchers exist: `singleDispatch` (the normal per-request path) and
 * `batchDispatch` (a bundling endpoint that lets a caller pack several
 * sub-requests into one POST -- a real, common REST feature). Both look up the
 * same ROUTES permission table, but disagree on *how* to normalize the path
 * before the lookup. `singleDispatch` always normalizes first, so it is
 * consistently gated. `batchDispatch`, when `routeIsolation` is off (the
 * default/broken state), looks up permission using the RAW un-normalized path
 * but resolves the HANDLER using the normalized path -- so a sub-request whose
 * path carries a trailing slash finds no permission entry (undefined), fails
 * OPEN to "public", and still reaches the real (internal-only) handler. That
 * handler in turn builds SQL by string concatenation when `parameterizedQueries`
 * is off, so the same unauthenticated request can also break out of the query
 * and UNION-select rows out of a table it was never meant to reach. Both are
 * genuine root causes -- fixing only one leaves the other exploitable, which is
 * exactly what checkpoints `fix-route` / `fix-query` / `replay-blocked` verify
 * independently (see AGENTS.md: "verify live state, not submitted trivia").
 */

/**
 * Parse a request target without letting a malformed one end the process.
 *
 * `GET //` is a protocol-relative reference with no host, and `new URL` rejects
 * it. This app serves its challenge surface and its `/verify` scorer from one
 * process, so an unguarded parse in the handler takes both down over a stray
 * slash. Leading slashes are collapsed (which is what the client meant) and
 * anything still unparseable becomes a target the router will not match, so a
 * malformed request is a 404 rather than a crash.
 */
function requestUrl(target, base) {
  try {
    return new URL(String(target ?? "/").replace(/^\/+/, "/"), base);
  } catch {
    return new URL("/__malformed_request__", base);
  }
}

const FLAG_SEED = process.env.FLAG_SEED ?? "local-dev-seed";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const flagFor = (checkId, label) => `TC{${label}_${sha256(`flag:${checkId}:${FLAG_SEED}`).slice(0, 20)}}`;

// Port overrides exist only so scripts/wp2shell-local-lab.test.ts can run this
// exact file as a real child process on unused ports without colliding with the
// Docker-published 8080/8081. docker-compose.yml never sets these -- the shipped
// container always uses the defaults below.
const CHALLENGE_PORT = Number(process.env.CHALLENGE_PORT ?? 8080);
const VERIFY_PORT = Number(process.env.VERIFY_PORT ?? 8081);

// The two flags a full, correct exploit chain yields. Both are derived from the
// per-deploy random FLAG_SEED, so nothing secret is committed and every deploy
// (every `make local` run) is unique.
const FLAG_CHAIN = flagFor("chain-discovery", "chain"); // proves: route-confusion bypass alone
const FLAG_VAULT = flagFor("compromise-proof", "vault"); // proves: bypass chained with the SQL flaw

function deriveToken(version) {
  return sha256(`sre-token:v${version}:${FLAG_SEED}`).slice(0, 32);
}

// ---------------------------------------------------------------------------
// Mutable lab state (all in-memory; resets on container restart).
// ---------------------------------------------------------------------------
const state = {
  // THE PLANTED FAULT (root causes). Both start false = broken, matching this
  // catalog's fix-by-settings bar: the player MODIFIES existing settings, never
  // creates a new resource.
  config: {
    routeIsolation: false,
    parameterizedQueries: false,
  },
  // Seeded as though a previous red-team run already exploited an identical lab
  // and left the aftermath, so this lab can teach full incident cleanup (not
  // only initial discovery) inside one safe, disposable sandbox.
  rogueAdminPresent: true,
  persistenceMarkerPresent: true,
  saltVersion: 0,
};
let currentToken = deriveToken(state.saltVersion);

// The normal, always-public blog content -- used by the "site stays healthy"
// checkpoint, never part of the vulnerable surface.
const POSTS = [
  { id: 1, title: "Welcome to Example Co", content: "We help small teams ship WordPress-like sites." },
  { id: 2, title: "Office hours moved", content: "Support office hours are now 9-17 JST, Mon-Fri." },
];

// The single-request router's permission table. `internal` means: only a caller
// holding the current SRE token may read it. This table is the SAME one both
// dispatchers consult -- the bug is in how each one NORMALIZES the path before
// looking a route up here, not in the table itself.
const ROUTES = {
  "/wp2shell-lab/v1/reports": { permission: "internal" },
};

// In-memory SQLite (same approach as challenges/sqli-demo): `reports` is the
// gated internal surface; `vault` is a table NO route ever legitimately selects
// from -- the only way data leaves it is the constrained SQL flaw below.
const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE reports (id INTEGER PRIMARY KEY, category TEXT, status TEXT, title TEXT, note TEXT);
  CREATE TABLE vault (id INTEGER PRIMARY KEY, audit_token TEXT, note TEXT);
`);
const insertReport = db.prepare(
  "INSERT INTO reports (category, status, title, note) VALUES (?, ?, ?, ?)",
);
insertReport.run("general", "open", "Status page", "All systems normal. Nothing sensitive here.");
insertReport.run("maintenance", "open", "Maintenance window", "Planned maintenance next Tuesday 02:00-03:00.");
insertReport.run(
  "internal-audit",
  "open",
  "Q3 internal access review",
  `Internal-only report. Reaching this without a token proves the route-confusion bypass. Audit token: ${FLAG_CHAIN}`,
);
db.prepare("INSERT INTO vault (audit_token, note) VALUES (?, ?)").run(
  FLAG_VAULT,
  "Deep vault row. No route ever legitimately SELECTs from this table.",
);

const REPORT_CATEGORIES = new Set(["general", "maintenance", "internal-audit"]);

/**
 * The single query builder both dispatch paths call AFTER their (different)
 * permission checks pass. This is root cause #2: string concatenation when
 * `parameterizedQueries` is off. The fix is not a denylist of "bad characters"
 * -- it is (a) an allow-list of known categories and (b) a real parameterized
 * statement, so there is no string context left to break out of at all.
 */
function runReportsQuery(category) {
  const value = typeof category === "string" ? category : "";
  if (state.config.parameterizedQueries) {
    if (!REPORT_CATEGORIES.has(value)) {
      return { status: 400, body: { error: "invalid_category" } };
    }
    const rows = db
      .prepare("SELECT id, title, note FROM reports WHERE status = 'open' AND category = ?")
      .all(value);
    return { status: 200, body: { reports: rows } };
  }
  // VULNERABLE PATH: string concatenation. A category like
  // `x' UNION SELECT id, audit_token, note FROM vault -- ` breaks out of the
  // quoted literal and unions in the vault table (constrained: SELECT-only, no
  // stacked statements, no write, no OS access -- exactly the "constrained
  // SQL-query flaw" the issue asks for).
  const sql = `SELECT id, title, note FROM reports WHERE status = 'open' AND category = '${value}'`;
  try {
    const rows = db.prepare(sql).all();
    return { status: 200, body: { reports: rows } };
  } catch {
    // A malformed injection throws a SQL syntax error -> no rows, not a crash.
    return { status: 200, body: { reports: [] } };
  }
}

/** The normal, correctly-gated single-request path. Always normalizes first. */
function singleDispatch(path, category, authorized) {
  const normalized = path.replace(/\/+$/, "");
  const entry = ROUTES[normalized];
  if (!entry) return { status: 404, body: { error: "rest_no_route" } };
  if (entry.permission === "internal" && !authorized) {
    return { status: 401, body: { error: "rest_forbidden" } };
  }
  return runReportsQuery(category);
}

/**
 * The batch sub-request path -- THE CONFUSION BUG lives here. See the top-of-file
 * comment for the full explanation. `routeIsolation` is the fix: once on, this
 * function normalizes before EVERY lookup, exactly like singleDispatch, so the
 * two dispatchers can never disagree again.
 */
function batchDispatch(path, category) {
  const normalized = path.replace(/\/+$/, "");
  const handlerEntry = ROUTES[normalized];
  if (!handlerEntry) return { status: 404, body: { error: "rest_no_route" } };

  const permissionEntry = state.config.routeIsolation
    ? ROUTES[normalized] // FIXED: identical normalization on both lookups.
    : ROUTES[path]; // BUG: raw, un-normalized path -- misses on a trailing slash.
  const effectivePermission = permissionEntry ? permissionEntry.permission : "public"; // fail-open
  if (effectivePermission === "internal") {
    return { status: 401, body: { error: "rest_forbidden" } };
  }
  return runReportsQuery(category);
}

function isAuthorized(headers) {
  const auth = headers.authorization ?? "";
  return auth === `Bearer ${currentToken}`;
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) {
        request.destroy();
        resolve("");
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(""));
  });
}

async function readJson(request) {
  const raw = await readBody(request);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const challenge = createServer(async (request, response) => {
  const url = requestUrl(request.url, "http://127.0.0.1");
  const { pathname, searchParams } = url;

  if (request.method === "GET" && pathname === "/healthz") {
    return send(response, 200, { status: "ok" });
  }

  if (request.method === "GET" && pathname === "/wp-json/") {
    return send(response, 200, {
      name: "Example Co",
      namespaces: ["wp/v2", "batch/v1", "wp2shell-lab/v1"],
    });
  }

  if (request.method === "GET" && pathname === "/wp-json/wp/v2/posts") {
    return send(response, 200, { posts: POSTS });
  }

  if (request.method === "GET" && pathname === "/wp-json/wp/v2/users") {
    const users = [{ id: 1, username: "owner", role: "admin" }];
    if (state.rogueAdminPresent) users.push({ id: 2, username: "svc-sync", role: "admin" });
    return send(response, 200, { users });
  }

  // The gated internal endpoint, reached the NORMAL way (single dispatch).
  if (request.method === "GET" && pathname.replace(/\/+$/, "") === "/wp-json/wp2shell-lab/v1/reports") {
    const category = searchParams.get("category") ?? "";
    const result = singleDispatch(
      "/wp2shell-lab/v1/reports",
      category,
      isAuthorized(request.headers),
    );
    return send(response, result.status, result.body);
  }

  // The batch bundling endpoint. Body: { requests: [{ method, path, body }] }.
  if (request.method === "POST" && pathname === "/wp-json/batch/v1") {
    const parsed = await readJson(request);
    const requests = Array.isArray(parsed.requests) ? parsed.requests : [];
    if (requests.length === 0 || requests.length > 5) {
      return send(response, 400, { error: "invalid_batch" });
    }
    const responses = requests.map((sub) => {
      const subPath = typeof sub?.path === "string" ? sub.path : "";
      const category = typeof sub?.body?.category === "string" ? sub.body.category : "";
      return batchDispatch(subPath, category);
    });
    return send(response, 200, { responses });
  }

  // ---- SRE console (the same participant, now defending instead of attacking) ----
  if (request.method === "GET" && pathname === "/admin/audit") {
    if (!isAuthorized(request.headers)) return send(response, 401, { error: "unauthorized" });
    return send(response, 200, {
      rogueAdminPresent: state.rogueAdminPresent,
      persistenceMarkerPresent: state.persistenceMarkerPresent,
      saltVersion: state.saltVersion,
      config: state.config,
    });
  }

  if (request.method === "POST" && pathname === "/admin/action") {
    if (!isAuthorized(request.headers)) return send(response, 401, { error: "unauthorized" });
    const body = await readJson(request);
    switch (body.action) {
      case "remove-rogue-admin":
        state.rogueAdminPresent = false;
        return send(response, 200, { ok: true, rogueAdminPresent: state.rogueAdminPresent });
      case "remove-persistence":
        state.persistenceMarkerPresent = false;
        return send(response, 200, { ok: true, persistenceMarkerPresent: state.persistenceMarkerPresent });
      case "rotate-salts": {
        state.saltVersion += 1;
        currentToken = deriveToken(state.saltVersion);
        console.log(`[sre-console] admin token rotated (v${state.saltVersion}): ${currentToken}`);
        return send(response, 200, { ok: true, saltVersion: state.saltVersion, newToken: currentToken });
      }
      case "set-config": {
        if (typeof body.routeIsolation === "boolean") state.config.routeIsolation = body.routeIsolation;
        if (typeof body.parameterizedQueries === "boolean") {
          state.config.parameterizedQueries = body.parameterizedQueries;
        }
        return send(response, 200, { ok: true, config: state.config });
      }
      default:
        return send(response, 400, { error: "unknown_action" });
    }
  }

  return send(response, 404, { error: "not_found" });
});

// ---------------------------------------------------------------------------
// :8081 /verify -- the multi-verify scorer delegate. See AGENTS.md #13: the
// platform holds no answer, it delegates each submission here with a
// checkpointId the response must echo back.
// ---------------------------------------------------------------------------

async function httpProbe(path, opts = {}) {
  const res = await fetch(`http://127.0.0.1:${CHALLENGE_PORT}${path}`, {
    method: opts.method ?? "GET",
    headers: opts.headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

const ROUTE_CONFUSION_PAYLOADS = [
  "/wp2shell-lab/v1/reports/", // one trailing slash
  "/wp2shell-lab/v1/reports//", // two -- catches a naive single-pattern patch
];
const SQLI_PAYLOAD = "x' UNION SELECT id, audit_token, note FROM vault -- ";

async function checkChainDiscovery(submission) {
  return submission.trim() === FLAG_CHAIN;
}

async function checkCompromiseProof(submission) {
  return submission.trim() === FLAG_VAULT;
}

async function checkFixRoute() {
  for (const path of ROUTE_CONFUSION_PAYLOADS) {
    const { json } = await httpProbe("/wp-json/batch/v1", {
      method: "POST",
      body: { requests: [{ method: "GET", path, body: { category: "internal-audit" } }] },
    });
    const sub = json?.responses?.[0];
    if (!sub || sub.status !== 401) return false; // still bypassable via at least one variant
  }
  return true;
}

async function checkFixQuery() {
  const { status, json } = await httpProbe(
    `/wp-json/wp2shell-lab/v1/reports?category=${encodeURIComponent(SQLI_PAYLOAD)}`,
    { headers: { authorization: `Bearer ${currentToken}` } },
  );
  if (status === 400) return true; // rejected by the allow-list
  if (status === 200 && Array.isArray(json?.reports) && json.reports.length === 0) return true;
  return false;
}

function checkCleanupPersistence() {
  return !state.rogueAdminPresent && !state.persistenceMarkerPresent;
}

function checkRotateSecrets() {
  return state.saltVersion >= 1;
}

async function checkReplayBlocked() {
  for (const path of ROUTE_CONFUSION_PAYLOADS) {
    const { json } = await httpProbe("/wp-json/batch/v1", {
      method: "POST",
      body: { requests: [{ method: "GET", path, body: { category: SQLI_PAYLOAD } }] },
    });
    const sub = json?.responses?.[0];
    if (!sub) return false;
    if (sub.status === 200 && Array.isArray(sub.body?.reports)) {
      const leaked = sub.body.reports.some(
        (r) => typeof r.title === "string" && r.title.startsWith("TC{"),
      );
      if (leaked) return false; // the exploit still works
    }
    // any 401/400, or a 200 with no leaked row, counts as "blocked" for this payload
  }
  return true;
}

async function checkSiteHealthy() {
  const index = await httpProbe("/wp-json/");
  const posts = await httpProbe("/wp-json/wp/v2/posts");
  const legit = await httpProbe("/wp-json/wp2shell-lab/v1/reports?category=general", {
    headers: { authorization: `Bearer ${currentToken}` },
  });
  return (
    index.status === 200 &&
    posts.status === 200 &&
    Array.isArray(posts.json?.posts) &&
    legit.status === 200 &&
    Array.isArray(legit.json?.reports)
  );
}

const CHECKS = {
  "chain-discovery": (submission) => checkChainDiscovery(submission),
  "compromise-proof": (submission) => checkCompromiseProof(submission),
  "fix-route": () => checkFixRoute(),
  "fix-query": () => checkFixQuery(),
  "cleanup-persistence": () => checkCleanupPersistence(),
  "rotate-secrets": () => checkRotateSecrets(),
  "replay-blocked": () => checkReplayBlocked(),
  "site-healthy": () => checkSiteHealthy(),
};

const verify = createServer(async (request, response) => {
  if (request.method === "GET" && (request.url ?? "/") === "/healthz") {
    return send(response, 200, { status: "ok" });
  }
  if (request.method !== "POST" || (request.url ?? "/") !== "/verify") {
    return send(response, 404, { error: "not_found" });
  }
  const body = await readJson(request);
  const checkpointId = typeof body.checkpointId === "string" ? body.checkpointId : "";
  const submission = typeof body.submission === "string" ? body.submission : "";
  const handler = CHECKS[checkpointId];
  if (!handler) {
    return send(response, 400, { checkpointId, error: "unknown_checkpoint" });
  }
  let correct = false;
  try {
    correct = await handler(submission);
  } catch {
    correct = false;
  }
  send(response, 200, {
    checkpointId,
    correct,
    message: correct ? "Confirmed." : "Not yet -- keep at it, or open a hint.",
  });
});

challenge.listen(CHALLENGE_PORT, "0.0.0.0", () => {
  console.log(`wp2shell-local-lab challenge surface on :${CHALLENGE_PORT}`);
  console.log(`[sre-console] admin token (v${state.saltVersion}): ${currentToken}`);
});
verify.listen(VERIFY_PORT, "0.0.0.0", () => console.log(`verify on :${VERIFY_PORT}`));
