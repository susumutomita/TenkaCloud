import { gunzipSync, gzipSync } from "node:zlib";

/**
 * Issue #810: Lambda environment variables の合計サイズが AWS 上限 4 KB を超過した
 * (= BATTLE_PROBLEMS_SCORING / PROBLEM_ENDPOINTS / BATTLE_PROBLEMS_PHASES の JSON
 * 累積 + JA description の UTF-8 multibyte で 3-4 KB に到達)。
 *
 * 対処: 大きい JSON env value を gzip + base64 で圧縮して env に積む。 RFC 1952
 * gzip は magic byte `0x1f 0x8b` で始まる → base64 すると prefix が `H4s` 固定。
 * decode 側は prefix で判定し、 plain JSON (= 旧形式 / test fixture) も backward
 * compat で読める。
 *
 * 4 個の problem 集合で 3669 → 2541 bytes に縮む (= ~30% 削減)。 将来 problem が
 * 増えてもまた天井に届いたら、 SSM Parameter Store に逃すのが正攻法 (= Issue #810
 * 本文の Option A)。 本実装は最小差分の中間策。
 */

const GZIP_BASE64_MAGIC_PREFIX = "H4s"; // base64 of bytes 0x1f 0x8b 0x08 (gzip header)

/**
 * 大きい JSON を Lambda env に積めるよう gzip + base64 で圧縮する。 CDK 側で env
 * value 構築時に通す。
 */
export function encodeLargeEnvValue(json: string): string {
  return gzipSync(json).toString("base64");
}

/**
 * env value を decode する。 `H4s` 始まりなら gzip+base64、 そうでなければ plain
 * (= legacy / test 用) としてそのまま返す。
 *
 * undefined / 空文字は そのまま (= caller 側で fallback の責任を持つ、 既存
 * `parseScoringEnv` etc. の `raw === undefined` 分岐を維持する)。
 */
export function decodeLargeEnvValue(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return raw;
  if (!raw.startsWith(GZIP_BASE64_MAGIC_PREFIX)) {
    // plain JSON (= 旧形式)。 そのまま返す。
    return raw;
  }
  try {
    return gunzipSync(Buffer.from(raw, "base64")).toString("utf-8");
  } catch {
    // gzip header だが decode 失敗 (= 壊れた base64 / truncated) は raw のまま返し、
    // 上位 parser が JSON parse 失敗で fallback する経路に倒す。
    return raw;
  }
}
