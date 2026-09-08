import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const virtualId = "virtual:portal-plugin-versions";
const resolvedId = `\0${virtualId}`;
const marker = "__TENKACLOUD_PLUGIN_VERSIONS__";

/** Fingerprint each problem's module graph, independently of unrelated entry chunks. */
export function pluginVersionsPlugin(): Plugin {
  let root = "";
  let building = false;
  let versions: Record<string, string> | undefined;
  const sources = new Map<string, string>();
  return {
    name: "tenkacloud-plugin-versions",
    enforce: "post",
    configResolved(config) {
      root = config.root;
      building = config.command === "build";
    },
    buildStart() {
      sources.clear();
      versions = undefined;
    },
    resolveId(id) {
      if (id === virtualId) return resolvedId;
      return null;
    },
    load(id) {
      if (id === resolvedId)
        return building ? `export default JSON.parse('${marker}')` : "export default {}";
      return null;
    },
    transform(code, id) {
      // Retain CSS and assets too: their final module code may only contain a placeholder.
      sources.set(id, code);
    },
    renderChunk(code) {
      if (!versions) {
        const groups = new Map<string, string[]>();
        for (const id of this.getModuleIds()) {
          const match = id
            .replaceAll("\\", "/")
            .match(/\/problems\/[^/]+\/([^/]+)\/portal\/[^/]+\.tsx$/);
          if (match) groups.set(match[1], [...(groups.get(match[1]) ?? []), id]);
        }
        versions = {};
        for (const [problem, entries] of groups) {
          const seen = new Set<string>();
          const pending = [...entries];
          while (pending.length) {
            const id = pending.pop()!;
            if (seen.has(id) || id === resolvedId) continue;
            seen.add(id);
            const info = this.getModuleInfo(id);
            if (info) pending.push(...info.importedIds, ...info.dynamicallyImportedIds);
          }
          const modules = [...seen]
            .map((id) => {
              const normalize = (text: string) =>
                text.replaceAll(root, "<root>").replaceAll(resolve(root, "../.."), "<repo>");
              return [
                normalize(id),
                normalize(sources.get(id) ?? this.getModuleInfo(id)?.code ?? ""),
              ];
            })
            .sort(([a], [b]) => a.localeCompare(b));
          versions[problem] = createHash("sha256").update(JSON.stringify(modules)).digest("hex");
        }
      }
      // Replacement happens before output hashes are finalized, including the embedded baseline.
      if (code.includes(marker))
        return code.replace(
          new RegExp(`['"]${marker}['"]`, "g"),
          JSON.stringify(JSON.stringify(versions)),
        );
      return null;
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "plugin-versions.json",
        source: JSON.stringify(versions ?? {}),
      });
    },
  };
}
