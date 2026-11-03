import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { participantMcpHandler } from "../../lib/problem-deploy/handlers/participant-handler/mcp";

async function withClient(
  invoke: () => Promise<Response>,
  action: (client: Client) => Promise<void>,
) {
  const handler = participantMcpHandler("synthetic-token", invoke);
  const client = new Client({ name: "adapter-error-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("https://participant.example.test/mcp"), {
        fetch: (url, init) => handler.fetch(new Request(String(url), init)),
      }),
    );
    await action(client);
  } finally {
    await client.close();
  }
}
function payload(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as { type: string; text?: string }[];
  const text = content.find((entry) => entry.type === "text")?.text;
  if (!text) throw new Error("Missing MCP text result");
  return JSON.parse(text);
}

describe("cloud MCP response failure boundaries", () => {
  it.each(["null", "malformed", "oversized", "transport"] as const)(
    "reports %s without retrying or returning an untrusted response body",
    async (failure) => {
      let requests = 0;
      await withClient(
        async () => {
          requests++;
          if (failure === "transport") throw new Error("synthetic-token must not be exposed");
          if (failure === "null") return Response.json(null);
          if (failure === "oversized")
            return new Response(JSON.stringify({ body: "x".repeat(2 * 1024 * 1024) }));
          return new Response("synthetic-token malformed JSON");
        },
        async (client) => {
          const result = await client.callTool({
            name: "get_problem",
            arguments: { problem_id: "p-1" },
          });
          expect(result.isError).toBe(true);
          expect(JSON.stringify(result)).not.toContain("synthetic-token");
          expect(payload(result).error).toContain("No automatic retry");
          expect(requests).toBe(1);
        },
      );
    },
  );
  it.each([{}, { problems: "invalid" }, { problems: [null, {}, { problemId: "other" }] }])(
    "returns unavailable for a problem absent from the authorized response %j",
    async (response) =>
      withClient(
        async () => Response.json(response),
        async (client) => {
          const result = await client.callTool({
            name: "get_problem",
            arguments: { problem_id: "p-1" },
          });
          expect(result.isError).toBe(true);
          expect(payload(result).status).toBe(404);
        },
      ),
  );
  it("reads a legacy authorized view without a problem catalog", async () => {
    await withClient(
      async () => Response.json({ problems: [{ problemId: "p-1" }] }),
      async (client) => {
        const result = await client.callTool({
          name: "get_problem",
          arguments: { problem_id: "p-1" },
        });
        expect(payload(result).data).toEqual({ problems: [{ problemId: "p-1" }] });
      },
    );
  });
  it("filters malformed catalog entries and returns only the requested problem", async () => {
    await withClient(
      async () =>
        Response.json({
          problems: [null, {}, { problemId: "p-1" }, { problemId: "p-2" }],
          problemCatalog: [null, {}, { id: "p-1" }, { id: "p-2" }],
        }),
      async (client) => {
        const result = await client.callTool({
          name: "get_problem",
          arguments: { problem_id: "p-1" },
        });
        expect(payload(result).data).toEqual({
          problems: [{ problemId: "p-1" }],
          problemCatalog: [{ id: "p-1" }],
        });
      },
    );
  });
});
