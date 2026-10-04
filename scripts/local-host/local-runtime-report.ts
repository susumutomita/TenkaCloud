import type { Job } from "./model";

export function localJobDescription(job: Job): string {
  const project = `tch-${job.jobId.toLowerCase()}`;
  return `event=${JSON.stringify(job.eventId)} team=${JSON.stringify(job.teamId)} problem=${JSON.stringify(job.problemId)} job=${JSON.stringify(job.jobId)} project=${JSON.stringify(project)}`;
}

/** Never print raw runtime errors, definitions, keys or Compose output in a cleanup report. */
export function localRuntimeFailure(error: unknown): string {
  const value = error instanceof Error ? error.message : error;
  const message = typeof value === "string" ? value : "";
  if (/Docker daemon is unavailable/u.test(message))
    return "Docker daemon is unavailable. Start Docker Desktop or Docker Engine, then retry.";
  const compose = /Docker Compose (up|down|stop|restart) failed \(exit (null|-?\d+)\)/u.exec(
    message,
  );
  if (compose) return compose[0];
  if (/compose|composition|ownership|Runtime|runtime|secret declaration/iu.test(message))
    return "The retained runtime plan or file ownership could not be verified; inspect the owned job in the host console.";
  if (/ENOENT|EACCES|EPERM/u.test(message))
    return "A required local file or Docker executable is missing or inaccessible.";
  return "The environment remains unconfirmed; inspect its deployment error in the host console and retry.";
}
