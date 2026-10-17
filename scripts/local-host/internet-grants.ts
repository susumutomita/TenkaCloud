import { z } from "zod";
import type { DockerDefinition } from "./docker-catalog";
import { normalizeInternetAccess } from "./internet-access";
import { InternetGrantStore } from "./internet-grant-store";
import { definitionKind, HostError, type HostedEvent } from "./model";
import type { ApiRequest, ApiResponse, HostingService } from "./service";

const approvalSchema = z
  .object({
    requestIds: z
      .array(z.string().min(1))
      .min(1)
      .max(8)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();

export class LocalInternetAccess {
  readonly store: InternetGrantStore;
  constructor(private readonly host: HostingService) {
    this.store = new InternetGrantStore(host.store);
  }
  async route(event: HostedEvent, parts: string[], request: ApiRequest): Promise<ApiResponse> {
    const problems = declaredProblems(event);
    if (parts.length === 1 && request.method === "GET") {
      return {
        status: 200,
        body: {
          ...(this.host.engine.internetAccessAvailability?.() ?? {
            available: false,
            reason: "Internet exceptions need the isolated native network adapter.",
          }),
          problems: problems.map(({ definition, requests, ...problem }) => {
            const grant = this.store.get(event.eventId, problem.problemId);
            return {
              ...problem,
              requests: requests.map(({ destination, ...entry }) => ({
                ...entry,
                address: destination,
              })),
              grant:
                grant && grant.definitionDigest === definition.catalogSnapshot?.digest
                  ? { requestIds: grant.requestIds, grantedAt: grant.grantedAt }
                  : null,
            };
          }),
        },
      };
    }
    const problem = problems.find((entry) => entry.problemId === parts[1]);
    if (parts.length !== 2 || !problem) throw new HostError(404, "Unknown event Internet request.");
    if (request.method === "PUT") return this.approve(event.eventId, problem, request.body);
    if (request.method === "DELETE") {
      const revoke = () => this.store.delete(event.eventId, problem.problemId);
      if (this.host.engine.updateInternetAccess)
        await this.host.engine.updateInternetAccess(
          event.eventId,
          problem.problemId,
          revoke,
          "revoke",
        );
      else revoke();
      return { status: 200, body: { ok: true } };
    }
    throw new HostError(404, "Unknown Internet access operation.");
  }
  private async approve(
    eventId: string,
    problem: ReturnType<typeof declaredProblems>[number],
    body: unknown,
  ): Promise<ApiResponse> {
    const parsed = approvalSchema.safeParse(body);
    if (
      !parsed.success ||
      parsed.data.requestIds.some((id) => !problem.requests.some((entry) => entry.id === id))
    )
      throw new HostError(400, "Select unique declared Internet requests.");
    const digest = problem.definition.catalogSnapshot?.digest;
    if (!digest) throw new HostError(409, "Internet approval requires a pinned catalog snapshot.");
    const requestIds = [...parsed.data.requestIds].sort((a, b) => (a < b ? -1 : Number(a > b)));
    try {
      if (!this.host.engine.checkInternetAccess)
        throw new Error("Internet exceptions need the isolated native network adapter.");
      this.host.engine.checkInternetAccess(
        problem.requests
          .filter((entry) => requestIds.includes(entry.id))
          .map((entry) => entry.destination),
      );
    } catch (error) {
      throw new HostError(409, error instanceof Error ? error.message : String(error));
    }
    const grant = {
      eventId: eventId,
      problemId: problem.problemId,
      definitionDigest: digest,
      requestIds,
      grantedAt: new Date(this.host.now()).toISOString(),
    };
    if (!this.host.engine.updateInternetAccess)
      throw new HostError(409, "Internet exceptions need the isolated native network adapter.");
    await this.host.engine.updateInternetAccess(eventId, problem.problemId, () =>
      this.store.put(grant),
    );
    return { status: 200, body: { requestIds, grantedAt: grant.grantedAt } };
  }
}

function declaredProblems(event: HostedEvent) {
  return event.problems.flatMap((problem) => {
    if (definitionKind(problem.definition) !== "compose") return [];
    const definition: DockerDefinition = JSON.parse(problem.definition);
    const requests = normalizeInternetAccess(definition.problem.internetAccess);
    return requests
      ? [{ problemId: problem.problemId, name: problem.name, definition, requests }]
      : [];
  });
}
