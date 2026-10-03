import type { WorkbenchFiles } from "../api/portal-client";

const PREFIX = "tenkacloud.workbench-draft.v1:";
const MAX_DRAFT_BYTES = 1_048_576;

export type WorkbenchDraftIssue = "unscoped" | "restore_failed" | "save_failed";

/** A job is server-scoped to one team/event. Never derive this key from a login key. */
export function workbenchDraftKey(
  apiBaseUrl: string,
  jobId: string | undefined,
  problemId: string,
): string | undefined {
  if (!jobId?.trim() || !problemId.trim()) return undefined;
  try {
    const api = new URL(apiBaseUrl, window.location.href);
    if (
      !["http:", "https:"].includes(api.protocol) ||
      api.username ||
      api.password ||
      api.search ||
      api.hash
    ) {
      return undefined;
    }
    const environment = api.href.endsWith("/") ? api.href.slice(0, -1) : api.href;
    return PREFIX + JSON.stringify([environment, jobId, problemId]);
  } catch {
    return undefined;
  }
}

interface DraftRead {
  readonly files: WorkbenchFiles;
  readonly issue?: WorkbenchDraftIssue;
}

function withinLimit(value: string): boolean {
  return (
    value.length <= MAX_DRAFT_BYTES && new TextEncoder().encode(value).length <= MAX_DRAFT_BYTES
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatedFiles(raw: string, starter: WorkbenchFiles): WorkbenchFiles | undefined {
  if (!withinLimit(raw)) return undefined;
  const saved: unknown = JSON.parse(raw);
  if (!isRecord(saved) || saved.version !== 1 || !isRecord(saved.files)) return undefined;
  const files = saved.files;
  const expected = Object.keys(starter);
  if (
    Object.keys(files).length !== expected.length ||
    !expected.every((name) => Object.hasOwn(files, name) && typeof files[name] === "string")
  ) {
    return undefined;
  }
  return Object.fromEntries(expected.map((name) => [name, files[name] as string]));
}

/** Reading never removes or rewrites a draft, even if its format no longer matches. */
export function readWorkbenchDraft(key: string | undefined, starter: WorkbenchFiles): DraftRead {
  if (!key) return { files: starter, issue: "unscoped" };
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return { files: starter };
    const files = validatedFiles(raw, starter);
    if (files) return { files };
  } catch {
    // Storage may be blocked, corrupt, or from an incompatible editor contract.
  }
  return { files: starter, issue: "restore_failed" };
}

/** Synchronous saves include the last keystroke before a stop/unmount/navigation. */
export function saveWorkbenchDraft(
  key: string | undefined,
  files: WorkbenchFiles,
): WorkbenchDraftIssue | undefined {
  if (!key) return "unscoped";
  try {
    const raw = JSON.stringify({ version: 1, files });
    if (!withinLimit(raw)) return "save_failed";
    window.localStorage.setItem(key, raw);
    return undefined;
  } catch {
    return "save_failed";
  }
}
