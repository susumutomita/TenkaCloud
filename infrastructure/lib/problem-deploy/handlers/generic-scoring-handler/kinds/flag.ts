import type { KindHandlerInput, KindResult } from "../../../../../../scripts/lib/scoring-common";
import { noopKindResult } from "../../../../../../scripts/lib/scoring-common";

export function runFlagKind(_input: KindHandlerInput): KindResult {
  // flag 採点は submit-flag (= POST trigger) 経路に任せる。polling 経路では何もしない。
  return noopKindResult();
}
