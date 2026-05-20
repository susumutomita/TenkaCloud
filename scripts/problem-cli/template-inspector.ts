export interface TemplateSections {
  readonly parameterNames: readonly string[];
  readonly resourceNames: readonly string[];
  readonly outputNames: readonly string[];
}

/**
 * CFn YAML から Output `key:` 配下の `Value:` を抽出する素朴 parser。
 * `Value: "TC{...}"` / `Value: !GetAtt X.Value` の前者だけハンドルする。
 * 後者は実 deploy しないと値が解決しないため null を返す。
 */
export function extractFlagFromTemplate(yaml: string, key: string): string | null {
  const re = new RegExp(`${key}:[\\s\\S]*?Value:\\s*("[^"\\n]+"|'[^'\\n]+'|[^\\n!]+)\\n`, "m");
  const m = yaml.match(re);
  if (!m?.[1]) return null;
  const raw = m[1].trim();
  if (raw.startsWith("!")) return null;
  return raw.replace(/^["']|["']$/g, "");
}

export function inspectTemplateSections(yaml: string): TemplateSections {
  const yamlLines = yaml.split(/\r?\n/);
  const resourceNames: string[] = [];
  const outputNames: string[] = [];
  const parameterNames: string[] = [];
  let section: "resources" | "parameters" | "outputs" | null = null;
  for (const line of yamlLines) {
    const nextSection = resolveSection(line, section);
    if (nextSection !== section) {
      section = nextSection;
      continue;
    }
    if (!section) continue;
    const m = line.match(/^ {2}([A-Za-z][A-Za-z0-9]*):\s*$/);
    if (!m?.[1]) continue;
    appendSectionName(section, m[1], { parameterNames, resourceNames, outputNames });
  }
  return { parameterNames, resourceNames, outputNames };
}

function resolveSection(
  line: string,
  current: "resources" | "parameters" | "outputs" | null,
): "resources" | "parameters" | "outputs" | null {
  if (/^Resources:\s*$/.test(line)) return "resources";
  if (/^Parameters:\s*$/.test(line)) return "parameters";
  if (/^Outputs:\s*$/.test(line)) return "outputs";
  if (/^[A-Za-z]/.test(line) && line.endsWith(":")) return null;
  return current;
}

function appendSectionName(
  section: "resources" | "parameters" | "outputs",
  name: string,
  out: { parameterNames: string[]; resourceNames: string[]; outputNames: string[] },
): void {
  if (section === "resources") out.resourceNames.push(name);
  else if (section === "outputs") out.outputNames.push(name);
  else out.parameterNames.push(name);
}
