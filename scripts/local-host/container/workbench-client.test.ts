import { expect, test } from "bun:test";
import { requestWorkbench } from "./workbench-client";

const config = {
  id: "code-lab",
  name: "Code lab",
  description: "Edit the starter.",
  submittedFiles: ["solution.py"],
  checkpoints: [{ id: "implement", label: "Implement", kind: "code" }],
};

test("workbench derives fixed action paths and returns only validated config/test/prepare data", async () => {
  const requests: { method: string; path: string; body?: unknown }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push({
        method: request.method,
        path,
        ...(request.method === "POST" ? { body: await request.json() } : {}),
      });
      if (path === "/api/config")
        return Response.json({ ...config, privateAnswer: "must-be-dropped" });
      if (path === "/api/test")
        return Response.json({
          passed: true,
          output: "public test passed",
          hidden: "must-be-dropped",
        });
      if (path === "/api/prepare")
        return Response.json({ ok: true, submissions: { implement: "print(1)" } });
      if (path === "/api/starter") return Response.json({ "solution.py": "pass\n" });
      return Response.json({ visibleEvidence: [1, 2, 3] });
    },
  });
  const url = `http://127.0.0.1:${String(server.port)}/verify`;
  try {
    expect(await requestWorkbench(url, "config")).toEqual(config);
    expect(await requestWorkbench(url, "starter")).toEqual({ "solution.py": "pass\n" });
    expect(await requestWorkbench(url, "inspect")).toEqual({
      output: JSON.stringify({ visibleEvidence: [1, 2, 3] }, null, 2),
    });
    expect(await requestWorkbench(url, "test", { files: { "solution.py": "print(1)" } })).toEqual({
      passed: true,
      output: "public test passed",
    });
    expect(
      await requestWorkbench(url, "prepare", { files: { "solution.py": "print(1)" }, manual: {} }),
    ).toEqual({ ok: true, submissions: { implement: "print(1)" } });
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/config",
      "GET /api/starter",
      "GET /api/inspect",
      "POST /api/test",
      "POST /api/prepare",
    ]);
    expect(requests[3]?.body).toEqual({ files: { "solution.py": "print(1)" } });
  } finally {
    await server.stop(true);
  }
});

test("workbench refuses non-loopback targets, unsupported contracts, redirects and malformed payloads", async () => {
  await expect(requestWorkbench("https://example.invalid/verify", "config")).rejects.toThrow(
    "Refusing non-loopback",
  );
  let mode = "missing";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      if (mode === "missing") return new Response(null, { status: 404 });
      if (mode === "redirect")
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.invalid/" },
        });
      if (mode === "invalid") return Response.json({ id: "incomplete" });
      return new Response("not JSON");
    },
  });
  const url = `http://127.0.0.1:${String(server.port)}/verify`;
  try {
    await expect(requestWorkbench(url, "config")).rejects.toMatchObject({ code: "not_supported" });
    mode = "redirect";
    await expect(requestWorkbench(url, "config")).rejects.toMatchObject({ code: "unavailable" });
    mode = "invalid";
    await expect(requestWorkbench(url, "config")).rejects.toMatchObject({
      code: "invalid_response",
    });
    mode = "text";
    await expect(requestWorkbench(url, "config")).rejects.toMatchObject({
      code: "invalid_response",
    });
  } finally {
    await server.stop(true);
  }
});

test("workbench caps response bytes and times out slow bodies after response headers", async () => {
  let slow = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      if (!slow) return Response.json({ output: "x".repeat(1_000_001) });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"output":"'));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const url = `http://127.0.0.1:${String(server.port)}/verify`;
  try {
    await expect(requestWorkbench(url, "inspect")).rejects.toMatchObject({
      code: "invalid_response",
    });
    slow = true;
    await expect(
      requestWorkbench(url, "inspect", undefined, { timeoutMs: 30 }),
    ).rejects.toMatchObject({ code: "unavailable" });
  } finally {
    await server.stop(true);
  }
}, 2000);
