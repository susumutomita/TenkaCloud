export const getEnv = (varName: string): string => {
  const val = process.env[varName];
  if (!val) {
    throw new Error(`${varName} is empty`);
  }
  return val;
};

/**
 * 任意 env を取り出す ( **未設定は throw しない** )。CDK 配線が遅れて入る予定の env で、
 * 「未設定 = この機能だけ disabled」として feature gate 的に使う handler 向け。
 *
 * `getEnv` を Lambda module scope で使うと、env が無い場合に **Lambda init 全体が
 * throw して全 route が 502** になるリスクがある (= PR-524 で portal が落ちた件)。
 * 配線完了が unblock-pr の条件になっている env は本 helper を使い、handler 内で
 * undefined を check して 500 / misconfigured outcome を返す。
 */
export const getOptionalEnv = (varName: string): string | undefined => {
  const val = process.env[varName];
  return val && val.length > 0 ? val : undefined;
};
