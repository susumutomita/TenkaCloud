/**
 * 問題の `metadata.json:endpoints[]` section の type-safe な parser (ADR-012 Phase 3.A)。
 *
 * `endpoints[]` は thick metadata DSL (Phase 2 で導入) の構成要素で、各 slot の
 * default URL (= deploy 後の CFn output から自動算出) と override 可否を宣言する。
 * Phase 3.A の Endpoint registry が「default の値を read-through で組み立てる」ために
 * 同じ parse 結果を CDK synth 時と Lambda runtime で共有する。
 */

export interface ProblemEndpointSlotDefault {
  /** default URL の供給源。現状は `cfn-output` のみ。 */
  readonly from: "cfn-output";
  /** CFn template Outputs の OutputKey (例: "FrontendUrl")。 */
  readonly key: string;
  /** OutputKey 値の末尾に追加する path (例: "/users")。複数 slot で同 base を使い回す用途。 */
  readonly appendPath?: string;
}

export interface ProblemEndpointSlot {
  readonly slot: string;
  readonly default: ProblemEndpointSlotDefault;
  /** 競技者 portal で別 URL に上書きできるか。省略時 false。 */
  readonly overridable: boolean;
  readonly label?: string;
  readonly description?: string;
}

/**
 * 1 件の `endpoints[]` entry を ProblemEndpointSlot に narrow する。不正なら undefined。
 *
 * - `slot` / `default.from === "cfn-output"` / `default.key` は必須
 * - `overridable` 省略時は false
 * - 不明な field は単に無視 (= forward-compat)
 */
export function parseEndpointSlot(value: unknown): ProblemEndpointSlot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as {
    slot?: unknown;
    default?: unknown;
    overridable?: unknown;
    label?: unknown;
    description?: unknown;
  };
  if (typeof v.slot !== "string" || v.slot.length === 0) return undefined;
  if (!v.default || typeof v.default !== "object") return undefined;
  const d = v.default as { from?: unknown; key?: unknown; appendPath?: unknown };
  if (d.from !== "cfn-output") return undefined;
  if (typeof d.key !== "string" || d.key.length === 0) return undefined;
  return {
    slot: v.slot,
    default: {
      from: "cfn-output",
      key: d.key,
      ...(typeof d.appendPath === "string" ? { appendPath: d.appendPath } : {}),
    },
    overridable: v.overridable === true,
    ...(typeof v.label === "string" ? { label: v.label } : {}),
    ...(typeof v.description === "string" ? { description: v.description } : {}),
  };
}

/**
 * Lambda env (`PROBLEM_ENDPOINTS`) を decode し、`{ [problemId]: ProblemEndpointSlot[] }`
 * に narrow する。不正な entry (parse 失敗 / non-object / 空配列) は drop。
 *
 * env から渡す理由: CDK synth 時に `discoverProblemsEndpoints` で metadata.json を
 * 走査し、Lambda 起動時に再度 file IO せず単一 JSON 文字列で受け取る (= cold start
 * 削減 + Lambda 内に problems/ ディレクトリを bundling しない)。
 */
export function parseEndpointsEnv(
  raw: string | undefined,
): Record<string, readonly ProblemEndpointSlot[]> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, readonly ProblemEndpointSlot[]> = {};
  for (const [problemId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const slots: ProblemEndpointSlot[] = [];
    for (const entry of value) {
      const slot = parseEndpointSlot(entry);
      if (slot) slots.push(slot);
    }
    if (slots.length > 0) out[problemId] = slots;
  }
  return out;
}

/**
 * `default.key` + `default.appendPath` から effective default URL を算出する。
 *
 * `base` = CFn output value (= 既に絶対 URL)。
 * `appendPath` が無いなら base をそのまま返す。あれば `new URL(appendPath, base)` で
 * 合成 (= base が "https://x/" なら "/a" / "a" 両方とも "https://x/a" になる、URL
 * spec の resolution)。base 自体に末尾 "/" が無い場合に備えて補う。
 */
export function resolveDefaultUrl(base: string, appendPath?: string): string | undefined {
  if (!appendPath) return base;
  try {
    return new URL(appendPath).toString();
  } catch {
    // appendPath が absolute URL でない場合は base に対する relative resolve を試みる。
    // base 自体が malformed (= 非 URL 文字列) なら resolve も crash するので caller に
    // undefined を返して degrade させる (= 「default URL 未確定」 として UI 側で扱う)。
    try {
      return new URL(appendPath, base.endsWith("/") ? base : `${base}/`).toString();
    } catch {
      return undefined;
    }
  }
}
