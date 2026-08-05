import { portalFetch } from "./fetch";

export interface WorkbenchCheckpoint {
  readonly id: string;
  readonly label: string;
  readonly kind: "code" | "answer";
}

export interface WorkbenchConfig {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly submittedFiles: readonly string[];
  readonly checkpoints: readonly WorkbenchCheckpoint[];
}

export type WorkbenchFiles = Readonly<Record<string, string>>;

export interface WorkbenchInspectResult {
  readonly output: string;
}

export interface WorkbenchTestResult {
  readonly passed: boolean;
  readonly output: string;
}

export type WorkbenchPrepareResult =
  | { readonly ok: true; readonly submissions: Readonly<Record<string, string>> }
  | {
      readonly ok: false;
      readonly output: string;
      readonly missingManual?: readonly string[];
    };

function workbenchPath(problemId: string, action: string): string {
  return `portal/me/problems/${encodeURIComponent(problemId)}/workbench/${action}`;
}

/** A 404 means this running container has no generic editor capability. */
export async function getWorkbenchConfig(
  apiBaseUrl: string,
  teamLoginKey: string,
  problemId: string,
  signal?: AbortSignal,
): Promise<WorkbenchConfig | undefined> {
  return portalFetch<WorkbenchConfig>(
    apiBaseUrl,
    workbenchPath(problemId, "config"),
    teamLoginKey,
    { signal, returnUndefinedOn404: true },
  );
}

export async function getWorkbenchStarter(
  apiBaseUrl: string,
  teamLoginKey: string,
  problemId: string,
  signal?: AbortSignal,
): Promise<WorkbenchFiles> {
  return (await portalFetch<WorkbenchFiles>(
    apiBaseUrl,
    workbenchPath(problemId, "starter"),
    teamLoginKey,
    { signal },
  )) as WorkbenchFiles;
}

export async function inspectWorkbench(
  apiBaseUrl: string,
  teamLoginKey: string,
  problemId: string,
): Promise<WorkbenchInspectResult> {
  return (await portalFetch<WorkbenchInspectResult>(
    apiBaseUrl,
    workbenchPath(problemId, "inspect"),
    teamLoginKey,
  )) as WorkbenchInspectResult;
}

export async function testWorkbench(
  apiBaseUrl: string,
  teamLoginKey: string,
  problemId: string,
  files: WorkbenchFiles,
): Promise<WorkbenchTestResult> {
  return (await portalFetch<WorkbenchTestResult>(
    apiBaseUrl,
    workbenchPath(problemId, "test"),
    teamLoginKey,
    { method: "POST", body: { files } },
  )) as WorkbenchTestResult;
}

export async function prepareWorkbench(
  apiBaseUrl: string,
  teamLoginKey: string,
  problemId: string,
  files: WorkbenchFiles,
  manual: Readonly<Record<string, string>>,
): Promise<WorkbenchPrepareResult> {
  return (await portalFetch<WorkbenchPrepareResult>(
    apiBaseUrl,
    workbenchPath(problemId, "prepare"),
    teamLoginKey,
    { method: "POST", body: { files, manual } },
  )) as WorkbenchPrepareResult;
}
