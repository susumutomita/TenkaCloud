import { parse } from "yaml";
import type { CompetitionNetworkView } from "../../packages/portal-contracts/src";
import { resolveStaticDefaults } from "./container/compose-policy";
import type { ContainerProblem } from "./container/manifest";

/** A catalog capability, not a browser-selected address, port, shell or route. */
export interface NetworkPublicService {
  readonly id: string;
  readonly service: string;
  readonly port: number;
  readonly purpose: string;
}
export type NetworkPublicationView = CompetitionNetworkView;
export function normalizePublicServices(
  value: unknown,
): readonly NetworkPublicService[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.length > 8)
    throw new Error("runtime.publicServices must contain 1-8 declarations.");
  const ids = new Set<string>();
  const result = value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Invalid public service declaration.");
    const entry = raw as Record<string, unknown>;
    if (
      Object.keys(entry)
        .sort((a, b) => a.localeCompare(b))
        .join(",") !== "id,port,purpose,service" ||
      typeof entry.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(entry.id) ||
      ids.has(entry.id) ||
      typeof entry.service !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(entry.service) ||
      typeof entry.port !== "number" ||
      !Number.isInteger(entry.port) ||
      entry.port < 1 ||
      entry.port > 65535 ||
      typeof entry.purpose !== "string" ||
      entry.purpose.length > 512 ||
      Buffer.byteLength(entry.purpose) > 512 ||
      !entry.purpose.trim()
    )
      throw new Error(
        "Public services need unique declared IDs, exact TCP ports and a bounded purpose.",
      );
    ids.add(entry.id);
    return Object.freeze({
      id: entry.id,
      service: entry.service,
      port: entry.port,
      purpose: entry.purpose.trim(),
    });
  });
  return Object.freeze(result);
}
/** Never expose the participant terminal or the verifier's service as a DMZ service. */
export function assertPublicServiceSeparation(
  problem: ContainerProblem,
  composeText: string,
): void {
  if (!problem.publicServices?.length) return;
  const document = parse(composeText, { merge: true });
  const verifier = new URL(problem.verifyUrl);
  const verifierPort = Number(verifier.port || (verifier.protocol === "https:" ? 443 : 80));
  const verifierServices = new Set<string>();
  for (const [name, service] of Object.entries(document.services) as [
    string,
    { ports?: string[] },
  ][]) {
    for (const port of service.ports ?? []) {
      const binding = resolveStaticDefaults(port).value;
      if (Number(binding.split(":")[1]) === verifierPort) verifierServices.add(name);
    }
  }
  for (const publication of problem.publicServices) {
    assertSinglePublicationNetwork(document.services[publication.service]?.networks);
    if (
      !Object.hasOwn(document.services, publication.service) ||
      publication.service === problem.terminal?.service ||
      verifierServices.has(publication.service)
    )
      throw new Error(
        "DMZ publications must select a dedicated catalog service, separate from verifier and participant terminal services.",
      );
  }
}

function assertSinglePublicationNetwork(networks: unknown): void {
  if (networks === undefined) return;
  if (!networks || typeof networks !== "object")
    throw new Error("Invalid public service network declaration.");
  const count = Array.isArray(networks) ? networks.length : Object.keys(networks).length;
  if (count !== 1) throw new Error("A public service must attach to exactly one private network.");
}
