import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

/**
 * sqli-demo — a DELIBERATELY VULNERABLE training target for TenkaCloud local
 * play. It is SQL-injectable on purpose (IPA "安全なウェブサイトの作り方", §1.1
 * SQL injection). Never expose it off loopback; the compose file binds it to
 * 127.0.0.1 only.
 *
 * Two servers run in one process:
 *   :8080  the challenge surface the participant attacks (login form + flag)
 *   :8081  the loopback `/verify` endpoint the TenkaCloud scorer delegates to
 *
 * The flag and the admin password are derived from FLAG_SEED at runtime, so
 * nothing secret is committed and each deploy is unique.
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
const FLAG = `TC{sqli_${sha256(`flag:${FLAG_SEED}`).slice(0, 20)}}`;
// Derived from the seed → unknowable, so the only way in is the injection.
const ADMIN_PASSWORD = sha256(`pw:${FLAG_SEED}`);

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password TEXT, role TEXT)");
const seed = db.prepare("INSERT INTO users (username, password, role) VALUES (?, ?, ?)");
seed.run("admin", ADMIN_PASSWORD, "admin");
seed.run("guest", "guest", "user");

/**
 * The vulnerability: the SQL is built by string concatenation, so a crafted
 * username (e.g. `admin' --`) rewrites the WHERE clause and bypasses auth.
 */
function authenticate(username, password) {
  const sql =
    `SELECT username, role FROM users ` +
    `WHERE username = '${username}' AND password = '${password}'`;
  try {
    return db.prepare(sql).get();
  } catch {
    // A malformed injection throws a SQL syntax error → treated as no match.
    return undefined;
  }
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

function parseCredentials(contentType, raw) {
  if (contentType.includes("application/json")) {
    try {
      const body = JSON.parse(raw);
      return { username: String(body.username ?? ""), password: String(body.password ?? "") };
    } catch {
      return { username: "", password: "" };
    }
  }
  const params = new URLSearchParams(raw);
  return { username: params.get("username") ?? "", password: params.get("password") ?? "" };
}

const LOGIN_PAGE = `<!doctype html>
<html lang="en"><head><meta name="color-scheme" content="light dark"><meta charset="utf-8"><title>Staff Login</title></head>
<body style="font-family:system-ui;max-width:32rem;margin:3rem auto">
<h1>Acme Staff Login</h1>
<p>Sign in as <code>admin</code> to view the flag. (You do not know the admin password.)</p>
<form method="post" action="/login">
  <p><label>Username <input name="username"></label></p>
  <p><label>Password <input name="password" type="password"></label></p>
  <p><button type="submit">Sign in</button></p>
</form>
</body></html>`;

function send(response, status, contentType, body) {
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}

const challenge = createServer(async (request, response) => {
  const url = requestUrl(request.url, "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/healthz") {
    return send(response, 200, "application/json", JSON.stringify({ status: "ok" }));
  }
  if (request.method === "GET" && url.pathname === "/") {
    return send(response, 200, "text/html; charset=utf-8", LOGIN_PAGE);
  }
  if (request.method === "POST" && url.pathname === "/login") {
    const raw = await readBody(request);
    const { username, password } = parseCredentials(request.headers["content-type"] ?? "", raw);
    const row = authenticate(username, password);
    if (row && row.role === "admin") {
      return send(
        response,
        200,
        "application/json",
        JSON.stringify({ ok: true, message: `Welcome, ${row.username}.`, flag: FLAG }),
      );
    }
    return send(response, 401, "application/json", JSON.stringify({ ok: false }));
  }
  return send(response, 404, "application/json", JSON.stringify({ error: "not_found" }));
});

const verify = createServer(async (request, response) => {
  if (request.method !== "POST" || (request.url ?? "/") !== "/verify") {
    return send(response, 404, "application/json", JSON.stringify({ error: "not_found" }));
  }
  const raw = await readBody(request);
  let submission = "";
  try {
    submission = String(JSON.parse(raw).submission ?? "");
  } catch {
    submission = "";
  }
  const correct = submission.trim() === FLAG;
  // The failure message must not leak the expected flag or scoring internals.
  send(
    response,
    200,
    "application/json",
    JSON.stringify({
      correct,
      message: correct ? "Flag accepted." : "That is not the flag for this challenge.",
    }),
  );
});

challenge.listen(8080, "0.0.0.0", () => console.log("challenge on :8080"));
verify.listen(8081, "0.0.0.0", () => console.log("verify on :8081"));
