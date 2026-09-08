import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
      // Run after CSS preprocessing and before extraction in Vite's normal phase.
      // Preserve source bytes as well as compiled CSS, including @import dependencies.
      const file = id.split("?")[0];
      const css =
        /\.(css|scss|sass|less|styl|stylus)$/.test(file) && existsSync(file)
          ? readFileSync(file, "utf8")
          : "";
      sources.set(id, code + css);
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
          const metadataPath = join(dirname(dirname(entries[0])), "metadata.json");
          const metadata = existsSync(metadataPath)
            ? JSON.parse(readFileSync(metadataPath, "utf8"))
            : {};
          const slots = metadata.dashboard?.slots ?? {};
          versions[problem] = createHash("sha256")
            .update(JSON.stringify({ modules, slots }))
            .digest("hex");
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
        source: JSON.stringify({ schemaVersion: 1, problems: versions ?? {} }),
      });
    },
  };
}
