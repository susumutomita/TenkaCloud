/**
 * 問題の `metadata.json:endpoints` (Issue #2106)。
 *
 * 純 parser (`parseEndpointSlot` / `resolveDefaultUrl`) と型は公開 SDK
 * `@tenkacloud/problem-sdk` に単一 source of truth として集約済みで、 同名・同 signature
 * で re-export する。 env decode を伴う `parseEndpointsEnv` のみ `node:zlib` 依存のため
 * 本 module に残す (= SDK は deterministic / no-zlib を保つ)。
 */

import { type ProblemEndpointSlot, parseEndpointSlot } from "@tenkacloud/problem-sdk/internal";
import { decodeLargeEnvValue } from "./env-encoding.js";

export {
  type ProblemEndpointSlot,
  parseEndpointSlot,
  resolveDefaultUrl,
} from "@tenkacloud/problem-sdk/internal";

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
  const decoded = decodeLargeEnvValue(raw);
  if (!decoded) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
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
