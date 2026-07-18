import type { AppConfig } from "../config";

/**
 * #2707 P0-5: LP hero の「始める」は `/portal-demo/start?demo=1` のような deep link で
 * client route に直接着地する。 AuthProvider の demo auto-login (#2696) は非同期に完了する
 * ため、 完了前に RequireAuth が `/login` へ redirect すると deep link の行き先が失われる。
 * この predicate が true の間、 RequireAuth は redirect せず auto-login の完了を待つ。
 * backend mode では常に false (= teamLoginKey 入力を強制する既存挙動のまま)。
 */
export function isDemoAutoLoginRequested(mode: AppConfig["mode"], search: string): boolean {
  return mode === "dev-mock" && new URLSearchParams(search).get("demo") === "1";
}
