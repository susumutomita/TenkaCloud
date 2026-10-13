import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/serve-static";
import { expect, it } from "vitest";

// Dependency regression fixture, not a production route: current handlers do not
// use Hono serveStatic. Keep GHSA-5r4p-p66f-jhc7's routing/file boundary pinned.
it("keeps static prefix protection and normal file serving across malformed encoding", async () => {
  const root = await mkdtemp(join(tmpdir(), "tenkacloud-hono-static-"));
  try {
    await writeFile(join(root, "public.txt"), "public fixture");
    await writeFile(join(root, "hello world.txt"), "encoded public fixture");
    await writeFile(join(root, "secret.txt"), "protected fixture");
    const reads: string[] = [];
    const app = new Hono();
    app.use("/static/admin/*", (c) => c.text("Unauthorized", 401));
    app.use(
      "/static/*",
      serveStatic({
        getContent: async (path) => {
          reads.push(path);
          const files: Record<string, string> = {
            "static/public.txt": "public.txt",
            "static/hello world.txt": "hello world.txt",
            "static/admin/secret.txt": "secret.txt",
          };
          const file = files[path];
          return file ? readFile(join(root, file)) : null;
        },
      }),
    );
    const publicResponse = await app.request("/static/public.txt");
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.text()).toBe("public fixture");
    expect(await (await app.request("/static/hello%20world.txt")).text()).toBe(
      "encoded public fixture",
    );
    reads.length = 0;
    expect((await app.request("/static/admin/secret.txt")).status).toBe(401);
    expect((await app.request("/static/%%36%31dmin/secret.txt")).status).toBe(404);
    expect(reads).toEqual([]);
    expect((await app.request("/static/missing.txt")).status).toBe(404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
