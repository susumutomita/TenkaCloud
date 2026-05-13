import { type ProblemEndpointSlot, resolveDefaultUrl } from "../../../utils/endpoints-metadata.js";
import { parseStackOutputs } from "../shared/cfn-status.js";
import type { EndpointOverrideItem } from "./store.js";

/**
 * 1 slot 分の「effective endpoint」を participant 向けに返す view。
 *
 * - `defaultUrl`: deployment の CFn output から read-through 算出した URL (= 未 deploy /
 *   output 欠損なら undefined)
 * - `overrideUrl`: 競技者が POST /endpoints で登録した URL (= 未登録なら undefined)
 * - `effectiveUrl`: scoring engine が probe する実 URL = `overrideUrl ?? defaultUrl`
 * - `overridable`: metadata 側の宣言 (= 競技者画面で edit UI を出すか)
 */
export interface ResolvedEndpoint {
  readonly slot: string;
  readonly label?: string;
  readonly description?: string;
  readonly overridable: boolean;
  /**
   * 競技者画面の診断用 (#703): 該当 slot の default URL が引かれる元 CFn Output key。
   * `defaultUrl` が未取得時に「(CFn Outputs.${defaultKey} 待ち)」 と表示するため UI に露出。
   * key 自体は metadata.json に既に公開済 (= 機密情報ではない)。
   */
  readonly defaultKey: string;
  readonly defaultUrl?: string;
  readonly overrideUrl?: string;
  readonly effectiveUrl?: string;
}

/**
 * problem の metadata.endpoints[] + 当該 deployment の stackOutputs + 既存 override 行を
 * 突き合わせて、participant に返す effective endpoint 一覧を組み立てる (Phase 3.A)。
 *
 * - metadata に endpoints[] 宣言が無い問題は空配列を返す
 * - deployment が無い / status が不適切な場合は caller でフィルタ済前提 (= 本関数は純関数)
 * - stackOutputs に該当 key が無い slot は `defaultUrl=undefined` だが、override があれば
 *   effectiveUrl は override で埋まる
 */
export function resolveEndpoints(args: {
  slots: readonly ProblemEndpointSlot[];
  stackOutputs: string | undefined;
  overrides: readonly EndpointOverrideItem[];
}): ResolvedEndpoint[] {
  const outputs = parseStackOutputs(args.stackOutputs);
  const overrideMap = new Map<string, EndpointOverrideItem>();
  for (const o of args.overrides) overrideMap.set(o.slot, o);

  return args.slots.map((slot) => {
    const baseOutput = outputs[slot.default.key];
    const defaultUrl =
      typeof baseOutput === "string" && baseOutput.length > 0
        ? resolveDefaultUrl(baseOutput, slot.default.appendPath)
        : undefined;
    const overrideUrl = overrideMap.get(slot.slot)?.overrideUrl;
    const effectiveUrl = overrideUrl ?? defaultUrl;
    return {
      slot: slot.slot,
      ...(slot.label !== undefined ? { label: slot.label } : {}),
      ...(slot.description !== undefined ? { description: slot.description } : {}),
      overridable: slot.overridable,
      defaultKey: slot.default.key,
      ...(defaultUrl !== undefined ? { defaultUrl } : {}),
      ...(overrideUrl !== undefined ? { overrideUrl } : {}),
      ...(effectiveUrl !== undefined ? { effectiveUrl } : {}),
    };
  });
}
