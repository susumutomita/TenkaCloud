import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { runInNewContext } from "node:vm";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("fingerprints each actual problem graph, including shared imports, and embeds the baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-versions-"));
  try {
    for (const name of ["a", "b"])
      await mkdir(join(root, `problems/battles/${name}/portal`), { recursive: true });
    await writeFile(join(root, "index.html"), '<script type="module" src="/main.js"></script>');
    await writeFile(
      join(root, "main.js"),
      `
      import versions from 'virtual:portal-plugin-versions';
      window.versions = versions;
      window.plugins = import.meta.glob('./problems/*/*/portal/*.tsx');
    `,
    );
    const shared = join(root, "shared.js");
    await writeFile(shared, "export default 1");
    for (const name of ["a", "b"])
      await writeFile(
        join(root, `problems/battles/${name}/portal/Main.tsx`),
        `import shared from '../../../../shared.js'; export default shared + '${name}';`,
      );
    async function compile() {
      const { stdout } = await promisify(execFile)("bun", [
        "run",
        "test/build/fixtures/plugin-version-build.ts",
        root,
      ]);
      const versions = JSON.parse(await readFile(join(root, "dist/plugin-versions.json"), "utf8"));
      const code: string = JSON.parse(stdout);
      expect(code).not.toContain("__TENKACLOUD_PLUGIN_VERSIONS__");
      // Evaluate the embedded JSON.parse literal, not the application's browser entry.
      const expression = code.match(/JSON\.parse\((?:"(?:\\.|[^"\\])*"|'[^']*')\)/)?.[0];
      expect(expression).toBeDefined();
      expect(runInNewContext(expression!)).toEqual(versions);
      return versions;
    }
    const first = await compile();
    await writeFile(
      join(root, "problems/battles/b/portal/Main.tsx"),
      "import shared from '../../../../shared.js'; export default shared + 'changed';",
    );
    const second = await compile();
    expect(second.a).toBe(first.a);
    expect(second.b).not.toBe(first.b);
    await writeFile(shared, "export default 2");
    const third = await compile();
    expect(third.a).not.toBe(second.a);
    expect(third.b).not.toBe(second.b);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
