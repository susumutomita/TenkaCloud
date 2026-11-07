import { createHash } from "node:crypto";
import type { StackEvent } from "@aws-sdk/client-cloudformation";
import type { DeploymentLogEntry, DeploymentLogView } from "@tenkacloud/portal-contracts";

function lifecycleLevel(status: string): DeploymentLogEntry["level"] {
  if (status.endsWith("FAILED")) return "error";
  return status.endsWith("COMPLETE") ? "success" : "info";
}

/** Only public resource identity and lifecycle status; never properties, reasons or physical IDs. */
export function deploymentLogView(events: readonly StackEvent[]): DeploymentLogView {
  const entries: DeploymentLogEntry[] = [];
  for (const event of events) {
    const logical = event.LogicalResourceId ?? "";
    const type = event.ResourceType ?? "";
    const status = event.ResourceStatus ?? "";
    if (
      !/^[A-Za-z0-9_-]{1,128}$/u.test(logical) ||
      !/^[A-Za-z0-9]+::[A-Za-z0-9]+::[A-Za-z0-9]+$/u.test(type) ||
      !/^(CREATE|UPDATE|DELETE|ROLLBACK|IMPORT|IMPORT_ROLLBACK|UPDATE_ROLLBACK)_(IN_PROGRESS|COMPLETE|FAILED|SKIPPED|COMPLETE_CLEANUP_IN_PROGRESS)$/u.test(
        status,
      )
    )
      continue;
    if (!(event.Timestamp instanceof Date) || !Number.isFinite(event.Timestamp.getTime())) continue;
    const timestamp = event.Timestamp.toISOString();
    const message = `${logical} (${type}): ${status}`;
    const id = createHash("sha256")
      .update(JSON.stringify([event.EventId, timestamp, message]))
      .digest("hex");
    entries.push({
      id,
      timestamp,
      source: "deployment",
      level: lifecycleLevel(status),
      message,
    });
  }
  // CloudFormation returns newest first. Reverse before the stable time sort so
  // equal timestamps retain provider chronology rather than arbitrary ID order.
  entries.reverse();
  entries.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  return {
    cursor: entries.length
      ? createHash("sha256").update(JSON.stringify(entries)).digest("hex")
      : "",
    entries,
  };
}

export interface DeploymentLogPageOptions {
  readonly nextToken?: string;
  readonly limit?: number;
}
export interface DeploymentLogPage extends DeploymentLogView {
  readonly nextToken?: string;
}
export function deploymentLogCursor(
  jobId: string,
  token?: string,
): { pageToken?: string; offset: number } {
  if (token === undefined) return { offset: 0 };
  try {
    if (!token || token.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(token)) throw new Error();
    const value = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (
      value.jobId !== jobId ||
      !Number.isSafeInteger(value.offset) ||
      value.offset < 0 ||
      (value.pageToken !== undefined && (typeof value.pageToken !== "string" || !value.pageToken))
    )
      throw new Error();
    return { offset: value.offset, pageToken: value.pageToken };
  } catch {
    throw new Error("Invalid deployment log cursor.");
  }
}
export function deploymentLogPage(
  jobId: string,
  view: DeploymentLogView,
  offset: number,
  limit: number,
  pageToken?: string,
  followingPage?: string,
): DeploymentLogPage {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Invalid deployment log limit.");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > view.entries.length)
    throw new Error("Invalid deployment log cursor.");
  const entries = view.entries.slice(offset, offset + limit);
  let next: { jobId: string; offset: number; pageToken?: string } | undefined;
  if (offset + limit < view.entries.length) next = { jobId, offset: offset + limit, pageToken };
  else if (followingPage) next = { jobId, offset: 0, pageToken: followingPage };
  return {
    ...view,
    entries,
    ...(next ? { nextToken: Buffer.from(JSON.stringify(next)).toString("base64url") } : {}),
  };
}
