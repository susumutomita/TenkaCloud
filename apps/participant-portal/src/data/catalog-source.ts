/**
 * [#2925 / #2926] どちらのカタログ供給源を使うかの決定と、その適用。
 *
 * `main.tsx` が render 前に 1 度だけ呼ぶ。ここで同期化しておくことで、カタログを読む画面
 * (ProblemDetail / CourseTracks / Home / Quests / plugin loader) は非同期を意識しなくてよい。
 */

import { getProblemCatalog } from "../api/portal-client";
import type { AppConfig } from "../config";
import { hydrateProblemCatalog } from "./problems";

/**
 * local mode のとき、control plane から実行時カタログを取り込む。
 *
 * AWS mode (`real` / `mock`) では何もしない。あちらは submodule を checkout した状態で
 * build するので build-time glob が正本であり、実行時に取りに行く理由がない。
 *
 * **失敗を握りつぶさない**: local mode でこれが失敗した portal は、問題の説明も手順も講座
 * トラックも plugin も出ないまま「一応動いて見える」画面になる。それは #2925 / #2926 で
 * 報告されたバグそのものを、今度は無言で再現することになる。よって例外はそのまま投げ、
 * `main.tsx` の既存 `renderBootError` に届かせる (= 何が起きたか読める形で止まる)。
 */
export async function applyRuntimeProblemCatalog(config: AppConfig): Promise<void> {
  if (config.cloudMode !== "local") return;
  if (!config.localTeamLoginKey) {
    throw new Error(
      "local mode runtime-config.json has no localTeamLoginKey — the problem catalog cannot be loaded",
    );
  }
  hydrateProblemCatalog(await getProblemCatalog(config.apiBaseUrl, config.localTeamLoginKey));
}
