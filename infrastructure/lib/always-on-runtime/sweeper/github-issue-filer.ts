import type { CleanupFailure, IssueFiler } from "./sweep.js";

/**
 * Issue #2293 — the loud-failure edge for the cleanup sweeper.
 *
 * When an expired always-on runtime stack refuses to delete after every retry, the sweeper OPENS A
 * GITHUB ISSUE naming the stuck stack (repo policy: no silent fallback — a leaked runtime must be
 * visible). This is a thin `fetch` wrapper around the GitHub REST "create an issue" endpoint.
 *
 * It lives here (not under `lib/handlers/`) precisely because the harness `handler-must-not-call-
 * fetch` rule scopes raw `fetch` out of handlers; the sweeper edge is an injectable client module,
 * which is exactly where an HTTP call is allowed to live. The `fetch` implementation is injectable
 * so the adapter stays offline-testable.
 */

const DEFAULT_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

export interface GitHubIssueFilerConfig {
  /** Target repository in `owner/name` form (e.g. `github.repository`). */
  readonly repo: string;
  /** Token with `issues:write` (the workflow's `GITHUB_TOKEN`). */
  readonly token: string;
  /** REST API base. Defaults to the public GitHub API. */
  readonly apiBaseUrl?: string;
  /** Optional labels to attach to the filed issue. */
  readonly labels?: readonly string[];
  /** Injectable `fetch` (defaults to the global) — the test seam. */
  readonly fetchImpl?: typeof fetch;
}

/** Collapse to printable ASCII so the issue title is safe regardless of the stack name's origin. */
function toAscii(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, "?");
}

/** Build the Markdown issue body naming the stuck stack, its retry count, and the last error. */
function buildIssueBody(failure: CleanupFailure): string {
  return [
    "The Always-On runtime cleanup sweeper could not delete an expired stack.",
    "",
    `- **Stack:** \`${failure.stackName}\``,
    `- **Delete attempts:** ${failure.attempts}`,
    `- **Last error:** ${failure.lastError}`,
    "",
    "This stack is tagged `TenkaCloud:ManagedBy=always-on-runtime` and its `TenkaCloud:ExpiresAt`",
    "is in the past, so it is leaking cost. Investigate the delete failure and tear it down manually.",
  ].join("\n");
}

/** Build a {@link IssueFiler} backed by the GitHub REST API. */
export function createGitHubIssueFiler(config: GitHubIssueFilerConfig): IssueFiler {
  const fetchImpl = config.fetchImpl ?? fetch;
  const apiBaseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;

  return {
    async openCleanupFailureIssue(failure: CleanupFailure): Promise<void> {
      const title = toAscii(`[always-on-runtime] cleanup failed for stack ${failure.stackName}`);
      const payload = {
        title,
        body: buildIssueBody(failure),
        ...(config.labels ? { labels: config.labels } : {}),
      };
      const res = await fetchImpl(`${apiBaseUrl}/repos/${config.repo}/issues`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(
          `failed to open cleanup-failure issue for stack ${failure.stackName}: ` +
            `${res.status} ${res.statusText}`,
        );
      }
    },
  };
}
