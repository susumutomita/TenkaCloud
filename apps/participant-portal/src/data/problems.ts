/**
 * 競技者向け問題カタログ (#550)。カタログには 2 つの供給源がある。
 *
 * 1. **build-time** — `problems/<category>/<id>/metadata.json` を Vite の `import.meta.glob`
 *    で取り込む。AWS mode (`cloudMode: "real" | "mock"`) の正本。
 * 2. **runtime** — control plane の `/portal/problem-catalog` から受け取って
 *    {@link hydrateProblemCatalog} で差し込む。Docker local mode の正本 (#2925 / #2926)。
 *
 * 2 が要る理由: `problems/` は `.dockerignore` で意図的に除外されている (参加者自身の clone を
 * 実行時に bind-mount して配るため、イメージに焼くと参加者が足した問題が反映されない)。
 * build context に `problems/` が無いイメージでは 1 の glob が空になり、カタログ由来の表示
 * — 説明・手順・学習目標・endpoint 上書き欄・図・講座トラック・plugin slot — が丸ごと消える。
 *
 * 投影そのもの (`metadataToEntry` の fairness contract) は `@tenkacloud/portal-contracts` が
 * 所有する。control plane と同じ関数を通すため、片側だけ `description` を落とし忘れる形の
 * ドリフトが起きない。ここが持つのは「どの供給源を今使うか」だけ。
 */

import { metadataToEntry, type ProblemMetadata } from "@tenkacloud/portal-contracts";

// 既存 import 元を変えずに済むよう、 画面側が実際に使う型だけ re-export する
// (それ以外は `@tenkacloud/portal-contracts` から直接 import する)。
export type {
  ProblemCatalogEntry,
  ProblemDashboardSlots,
  ProblemTrackPosition,
} from "@tenkacloud/portal-contracts";

import type { ProblemCatalogEntry } from "@tenkacloud/portal-contracts";

const metadataModules = import.meta.glob<{ default: ProblemMetadata }>(
  "../../../../problems/*/*/metadata.json",
  { eager: true },
);

// Phase 1c (#1929): per-problem architecture diagram. `problems/<category>/<id>/diagram.svg`
// is bundled by Vite as a URL asset; the portal renders it on the problem page as the
// architecture image (alongside `instructions`). Optional — absent for problems without one.
const diagramModules = import.meta.glob<string>("../../../../problems/*/*/diagram.svg", {
  eager: true,
  query: "?url",
  import: "default",
});

const BUILD_TIME_CATALOG: readonly ProblemCatalogEntry[] = Object.values(metadataModules)
  .map((mod) => metadataToEntry(mod.default))
  .sort((a, b) => a.id.localeCompare(b.id));

/**
 * 現在有効なカタログと、その O(1) lookup map (= per-render hot path で findProblemMetadata を
 * 複数回呼ぶ場合の linear scan 抑止)。 既定は build-time 供給源で、 local mode の boot が
 * {@link hydrateProblemCatalog} で置き換える。
 */
let activeCatalog: readonly ProblemCatalogEntry[] = BUILD_TIME_CATALOG;
let activeCatalogById: ReadonlyMap<string, ProblemCatalogEntry> = new Map(
  BUILD_TIME_CATALOG.map((p) => [p.id, p]),
);

/**
 * #2925 / #2926: 実行時に受け取ったカタログを有効化する。 render 前に 1 度だけ呼ぶ
 * (`main.tsx` の `loadConfig()` 解決後) ので、 画面側は従来どおり同期 API のままでよい。
 *
 * 受け取る entry は control plane 側で `metadataToEntry` を通済み — つまり投影後の shape。
 * ここで再投影しないのは、 生 metadata が wire に載らないことが fairness contract だから。
 */
export function hydrateProblemCatalog(entries: readonly ProblemCatalogEntry[]): void {
  activeCatalog = [...entries].sort((a, b) => a.id.localeCompare(b.id));
  activeCatalogById = new Map(activeCatalog.map((p) => [p.id, p]));
}

/**
 * Issue #2786: catalog 全件。 course track view は「deploy された問題」ではなく
 * 「curriculum に載っている問題」を並べるので、 team view ではなく catalog を起点にする。
 */
export function listProblemCatalog(): readonly ProblemCatalogEntry[] {
  return activeCatalog;
}

/** `problemId` (= metadata.json の `id` field) で問題を引く。無ければ undefined。 */
export function findProblemMetadata(problemId: string): ProblemCatalogEntry | undefined {
  return activeCatalogById.get(problemId);
}

// problemId (= dir name; validator が id === dirName を保証) → bundled diagram.svg URL。
// Exported for unit testing: the real glob is empty until a problem ships a diagram.svg,
// so the per-entry path→id mapping can only be exercised with a synthetic input.
export function buildDiagramMap(
  modules: Readonly<Record<string, string>>,
): ReadonlyMap<string, string> {
  return new Map(
    Object.entries(modules).map(([path, url]) => {
      // path: ../../../../problems/<category>/<id>/diagram.svg → key by <id>。
      const parts = path.split("/");
      return [parts[parts.length - 2] ?? "", url] as const;
    }),
  );
}
const DIAGRAM_URL_BY_ID = buildDiagramMap(diagramModules);

/**
 * `problemId` の architecture diagram (`diagram.svg`) URL。無ければ undefined。
 *
 * 注: diagram は Vite の asset pipeline が bundle する build-time 資産なので、 local mode の
 * runtime hydration では埋まらない (図の無い問題と同じ扱いになる)。 画面は元から optional 前提。
 */
export function findProblemDiagramUrl(problemId: string): string | undefined {
  return DIAGRAM_URL_BY_ID.get(problemId);
}

/**
 * Issue #583 Phase 5 / #1108: locale を適用した narrative view を返す。 fallback chain:
 *   1. 指定 locale (= en) の override
 *   2. top-level (= ja の正本)
 *
 * locale="ja" / metadata.i18n 不在 / 該当 field 不在は静かに ja を返す。 caller (= ProblemDetail
 * の useI18n から locale を取って呼ぶ) は常に non-undefined string を受け取る。
 * 注: SUPPORTED_LOCALES は ja+en のみ (#1108 で es / zh は廃止)。
 */
export function resolveLocalizedNarrative(
  entry: ProblemCatalogEntry,
  locale: "ja" | "en",
): {
  readonly name: string;
  readonly shortDescription: string;
  readonly instructions?: string;
  readonly learningGoals: readonly string[];
} {
  if (locale === "ja" || !entry.i18n) {
    return {
      name: entry.name,
      shortDescription: entry.shortDescription,
      instructions: entry.instructions,
      learningGoals: entry.learningGoals,
    };
  }
  const override = entry.i18n[locale];
  if (!override) {
    return {
      name: entry.name,
      shortDescription: entry.shortDescription,
      instructions: entry.instructions,
      learningGoals: entry.learningGoals,
    };
  }
  return {
    name: override.name ?? entry.name,
    shortDescription: override.shortDescription ?? entry.shortDescription,
    instructions: override.instructions ?? entry.instructions,
    learningGoals: override.learningGoals ?? entry.learningGoals,
  };
}
