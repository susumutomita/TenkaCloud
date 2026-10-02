import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Plugin } from "vite";
import {
  isExecutableProblemRuntime,
  metadataRuntimeToSummary,
  metadataToDetail,
} from "./src/data/problem-mapping";
import type { ProblemMetadata } from "./src/data/problem-types";

/** Only the same YAML files previously discoverable by the core/pack globs qualify. */
export function catalogTemplatePath(
  metadata: ProblemMetadata,
  metadataPath: string,
): string | undefined {
  if (!isExecutableProblemRuntime(metadataRuntimeToSummary(metadata))) return undefined;
  const runtime = metadata.runtime;
  const entry =
    runtime && !("kind" in runtime)
      ? (runtime.entry ?? metadata.cfnTemplate)
      : metadata.cfnTemplate;
  if (!entry?.endsWith(".yaml") || entry.includes("\\")) return undefined;
  const parts = entry.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return undefined;
  if (
    !metadataPath.replaceAll("\\", "/").includes("/.tenkacloud/pack-store/snapshots/") &&
    parts.length !== 1
  )
    return undefined;
  return resolve(dirname(metadataPath), entry);
}

/** Project before Vite's JSON transform, after the host's public-metadata boundary. */
export function catalogProjection(): Plugin {
  const templateImporters = new Map<string, Set<string>>();
  return {
    name: "problem-catalog-projection",
    enforce: "pre",
    transform(code, id) {
      const [metadataPath, query] = id.split("?", 2);
      if (
        !metadataPath.endsWith("/metadata.json") ||
        !new URLSearchParams(query).has("catalog-detail")
      )
        return null;
      const metadata = JSON.parse(code) as ProblemMetadata;
      const templatePath = catalogTemplatePath(metadata, metadataPath);
      let templateYaml: string | undefined;
      if (templatePath) {
        this.addWatchFile(templatePath);
        const importers = templateImporters.get(templatePath) ?? new Set<string>();
        importers.add(id);
        templateImporters.set(templatePath, importers);
        if (existsSync(templatePath)) templateYaml = readFileSync(templatePath, "utf8");
      }
      return { code: JSON.stringify(metadataToDetail(metadata, templateYaml)), map: null };
    },
    handleHotUpdate({ file, server, modules }) {
      const importers = templateImporters.get(file);
      if (!importers) return;
      return [
        ...modules,
        ...[...importers].flatMap((id) => {
          const mod = server.moduleGraph.getModuleById(id);
          return mod ? [mod] : [];
        }),
      ];
    },
  };
}
