import { ParameterNotFound } from "@aws-sdk/client-ssm";

/**
 * SSM の `ParameterNotFound` 判定 helper (SecureString store 共通)。
 *
 * SSM SDK は `ParameterNotFound` を class instance でも `err.name` 文字列でも投げる
 * (= 環境 / SDK version 依存の挙動を吸収する)。 ExternalId store / Sakura credential store など
 * 「未登録なら undefined」を返す全 store がこの判定を共有する (= DRY、 SRP)。
 */
export function isParameterNotFound(err: unknown): boolean {
  if (err instanceof ParameterNotFound) return true;
  return err instanceof Error && err.name === "ParameterNotFound";
}

/**
 * SSM の `ParameterVersionNotFound` 判定 helper。
 *
 * `GetParameter` に `:<version>` を付けた pinned-version 取得で、 SSM が 100-version cap で
 * 旧 version を auto-drop 済のときに投げる。 grace fallback (= 旧値再取得) を諦めて undefined に
 * するために使う。 class export は無いので `err.name` のみで判定する。
 */
export function isParameterVersionNotFound(err: unknown): boolean {
  return err instanceof Error && err.name === "ParameterVersionNotFound";
}
