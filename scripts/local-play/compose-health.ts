import { z } from "zod";

export interface ComposeService {
  readonly name: string;
  readonly service: string;
  readonly state: string;
  readonly health: string;
  readonly exitCode: number;
}

const ComposePsRowsSchema = z.array(
  z
    .object({
      Name: z.string().optional(),
      Service: z.string().optional(),
      State: z.string().optional(),
      Health: z.string().optional(),
      ExitCode: z.number().optional(),
    })
    .transform(
      (row): ComposeService => ({
        name: row.Name ?? "",
        service: row.Service ?? "",
        state: row.State ?? "",
        health: row.Health ?? "",
        exitCode: row.ExitCode ?? 0,
      }),
    ),
);

/** Parse `docker compose ps --format json` (newline-delimited objects, or a JSON array). */
export function parseComposePs(stdout: string): ComposeService[] {
  const text = stdout.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = text.startsWith("[")
      ? JSON.parse(text)
      : text
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
  const result = ComposePsRowsSchema.safeParse(parsed);
  return result.success ? result.data : [];
}

export type ServiceVerdict = "ok" | "completed" | "failing" | "pending";

/** `docker inspect` format marking a service meant to stay up (declares a healthcheck or ports). */
export const LONG_RUNNING_INSPECT_FORMAT =
  "{{if .Config.Healthcheck}}H{{end}}{{if .HostConfig.PortBindings}}P{{end}}";

export function parseLongRunning(inspectStdout: string): boolean {
  return /[HP]/.test(inspectStdout);
}

export function classifyService(service: ComposeService, longRunning: boolean): ServiceVerdict {
  if (service.state === "dead") return "failing";
  if (service.state === "exited") {
    if (longRunning) return "failing";
    return service.exitCode === 0 ? "completed" : "failing";
  }
  if (service.health === "unhealthy") return "failing";
  if (service.state === "running") {
    return service.health === "" || service.health === "healthy" ? "ok" : "pending";
  }
  return "pending";
}

export interface HealthReport {
  readonly done: boolean;
  readonly ok: boolean;
  readonly failing: readonly ComposeService[];
  readonly pending: readonly ComposeService[];
  readonly running: readonly ComposeService[];
}

export function evaluateHealth(
  services: readonly ComposeService[],
  isLongRunning: (service: ComposeService) => boolean,
): HealthReport {
  const withVerdict = (verdict: ServiceVerdict): ComposeService[] =>
    services.filter((service) => classifyService(service, isLongRunning(service)) === verdict);
  const failing = withVerdict("failing");
  const pending = withVerdict("pending");
  const running = withVerdict("ok");
  return {
    done: failing.length > 0 || pending.length === 0,
    ok: failing.length === 0 && pending.length === 0 && running.length > 0,
    failing,
    pending,
    running,
  };
}

export function looksDiskFull(logs: string): boolean {
  return /No space left on device|Errcode:\s*28/i.test(logs);
}

export function describeFailure(service: ComposeService): string {
  const parts = [service.state];
  if (service.exitCode !== 0) parts.push(`exit ${service.exitCode}`);
  if (service.health) parts.push(service.health);
  return `${service.service}(${parts.join(" ")})`;
}
