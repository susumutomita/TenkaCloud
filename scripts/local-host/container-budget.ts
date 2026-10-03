import { parse, stringify } from "yaml";

export interface ContainerLimits {
  readonly perTeam: number;
  readonly global: number;
  readonly memoryMiB: number;
}
export const DEFAULT_CONTAINER_LIMITS: ContainerLimits = {
  perTeam: 3,
  global: 12,
  memoryMiB: 4096,
};
export interface ContainerCost {
  readonly services: number;
  readonly memoryMiB: number;
}

function memoryBytes(raw: unknown): number {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) return raw;
  if (typeof raw !== "string") throw new Error("Invalid authored container memory limit.");
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/iu.exec(raw.trim());
  if (!match) throw new Error("Invalid authored container memory limit.");
  const unit = (match[2] ?? "").toLowerCase();
  const exponent = ["", "k", "m", "g", "t"].indexOf(unit);
  const bytes = Number(match[1]) * 1024 ** exponent;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("Invalid container memory size.");
  return bytes;
}

/** Only new explicit-map deployments use these deterministic limits; legacy plans remain untouched. */
export function boundedCompose(composeText: string): { text: string; cost: ContainerCost } {
  const document: unknown = parse(composeText, { merge: true });
  if (!document || typeof document !== "object" || !("services" in document))
    throw new Error("Compose services are required.");
  const services = document.services;
  if (!services || typeof services !== "object" || Array.isArray(services))
    throw new Error("Compose services must be a mapping.");
  let memory = 0;
  let count = 0;
  for (const value of Object.values(services)) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid Compose service.");
    const service = value as Record<string, unknown>;
    service.mem_limit ??= "512m";
    service.cpus ??= 1;
    service.pids_limit ??= 256;
    memory += memoryBytes(service.mem_limit);
    count++;
  }
  return {
    text: stringify(document),
    cost: { services: count, memoryMiB: Math.ceil(memory / 1024 ** 2) },
  };
}
