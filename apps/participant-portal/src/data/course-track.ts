/**
 * Issue #2786: curriculum track の participant view を組み立てる純粋ロジック。
 *
 * 入力は 2 つあり、出所が違う:
 *   - **catalog** (`ProblemCatalogEntry`) — build 時に `metadata.json` から投影した静的情報。
 *     track 位置、講座対応、participant-safe な graph。
 *   - **progress** — 実行時に Participant API から来る team ごとの解答状況。
 *
 * この join を client 側で行うので、track UI のために backend の契約を増やしていない。
 * 完了状態の正本は既存の `flagSubmitted` / multi-verify の `flags[].solved` のままである。
 *
 * ここに UI も fetch も置かない。純関数だけなので、cycle・欠損 node・track 未設定といった
 * 壊れた入力に対する挙動をテストで固定できる。
 */

import type { ProblemCatalogEntry, ProblemTrackPosition } from "./problems";

/** `ProblemCatalogEntry["track"]` の non-optional 版。 track 有無の分岐を 1 か所に閉じる。 */
type ProblemTrack = ProblemTrackPosition;

/** 1 問題ぶんの解答状況。呼び出し側が `ParticipantProblemView` から詰める。 */
export interface ProblemProgress {
  readonly problemId: string;
  /** multi-verify なら「全 checkpoint 達成」、flag なら提出済み。 */
  readonly solved: boolean;
  /** multi-verify の達成 checkpoint 数。flag / 未取得では 0。 */
  readonly solvedCheckpoints: number;
  /** multi-verify の総 checkpoint 数。flag / 未取得では 0。 */
  readonly totalCheckpoints: number;
}

export type PrerequisiteState =
  /** 前提すべて達成、または前提なし。 */
  | "met"
  /** 未達成の前提がある。推奨順から外れるが、**lock はしない**。 */
  | "unmet"
  /** 前提が catalog に無い / cycle を含む。判定を諦めた状態。 */
  | "unknown";

export interface CourseProblemView {
  readonly problemId: string;
  readonly name: string;
  readonly chapter: string;
  readonly order: number;
  readonly week?: number;
  readonly role?: string;
  readonly difficulty: number;
  readonly estimatedDuration: string;
  readonly learningGoals: readonly string[];
  readonly progress: ProblemProgress;
  readonly prerequisiteState: PrerequisiteState;
  /** 未達成の前提問題 id。`prerequisiteState === "unmet"` のときだけ非空。 */
  readonly unmetPrerequisites: readonly string[];
  readonly sources: readonly {
    readonly repository: string;
    readonly ref: string;
    readonly path: string;
  }[];
}

export interface CourseChapterView {
  readonly chapter: string;
  readonly problems: readonly CourseProblemView[];
}

/**
 * Issue #2965: 「次にやること」がどのトラックから出るかを **明示的に**決める。
 *
 * これを入れる前は `assembleCourseTracks` が track id を `localeCompare` で並べ、Home が
 * その先頭を取っていた。つまり「どのトラックを勧めるか」が id の文字列順で決まっていて、
 * `advanced-cryptography-2026` が `automotive-security` にも `ipa-web-security` にも辞書順で
 * 勝つ。結果、1 問解いた直後の初学者に大学院レベルの法演算の問題が出ていた。学習設計上の
 * 意図ではなく、ソート順の副作用だった。
 *
 * ここに書かれていないトラックは、この配列の後ろに従来どおりの順で続く。
 *
 * **`_start` のように辞書順で勝つ id を付けて解決してはならない。** それはこのバグの再発経路
 * そのもので、次に別のトラックが増えたときに同じ壊れ方をする。
 */
export const DEFAULT_RECOMMENDATION_TRACK_PRIORITY: readonly string[] = [
  "ipa-web-security",
  "automotive-security",
];

/**
 * 既定の推薦対象から外すトラック。
 *
 * **到達不能にはしない。** 「講座トラック」画面からは通常どおり見えて始められる。独立した講座を
 * 既定の導線から外すだけで、消す話ではない。
 */
export const TRACKS_EXCLUDED_FROM_DEFAULT_RECOMMENDATION: ReadonlySet<string> = new Set([
  // 大学院レベルの暗号講座。単体の講座として成立しており、入門者の既定導線ではない。
  "advanced-cryptography-2026",
]);

/** 既定の推薦対象か。除外されていても track 画面からは到達できる。 */
export function isRecommendableTrack(trackId: string): boolean {
  return !TRACKS_EXCLUDED_FROM_DEFAULT_RECOMMENDATION.has(trackId);
}

/**
 * 既定推薦の探索順。優先リストに載っているものが先で、その中の順序はリスト順。載っていない
 * ものは後ろに回り、互いの順序は呼び出し側が渡した並びを保つ (= 安定ソート)。
 */
export function compareByRecommendationPriority(leftTrackId: string, rightTrackId: string): number {
  const rank = (trackId: string): number => {
    const index = DEFAULT_RECOMMENDATION_TRACK_PRIORITY.indexOf(trackId);
    return index === -1 ? DEFAULT_RECOMMENDATION_TRACK_PRIORITY.length : index;
  };
  return rank(leftTrackId) - rank(rightTrackId);
}

/**
 * 「次にやること」に出す 1 問を選ぶ。Home と Quests の両方がこれを使うことで、
 * 片方だけ別の基準で選ぶ状態を作らない。
 */
export function recommendedNextAcrossTracks(
  tracks: readonly CourseTrackView[],
): CourseProblemView | undefined {
  return [...tracks]
    .filter((track) => isRecommendableTrack(track.trackId))
    .sort((a, b) => compareByRecommendationPriority(a.trackId, b.trackId))
    .find((track) => track.recommendedNext)?.recommendedNext;
}

export interface CourseTrackView {
  readonly trackId: string;
  readonly edition?: string;
  readonly chapters: readonly CourseChapterView[];
  readonly totalProblems: number;
  readonly solvedProblems: number;
  readonly totalCheckpoints: number;
  readonly solvedCheckpoints: number;
  /** 推奨する次の 1 問。全問完了、または候補なしのとき undefined。 */
  readonly recommendedNext?: CourseProblemView;
}

/**
 * Participant API の view から進捗を取り出す。完了判定の正本は既存の field のままで、
 * ここでは track UI が読める形に写しているだけ (= 新しい真実を作らない)。
 *
 * multi-verify (`flags[]`) は「全 checkpoint 達成」で完了。1 つでも未達なら部分進捗として
 * 数える。`flags` を持たない flag 問題は `flagSubmitted` が完了の正本で、checkpoint は
 * 概念として存在しないので 0/0 になる — UI 側は 0/0 を「進捗バーなし」として扱う。
 */
export function toProblemProgress(
  views: readonly {
    readonly problemId: string;
    readonly scoring?: {
      readonly flagSubmitted?: boolean;
      readonly flags?: readonly { readonly solved: boolean }[];
    };
  }[],
): readonly ProblemProgress[] {
  return views.map((view) => {
    const flags = view.scoring?.flags;
    if (flags && flags.length > 0) {
      const solvedCheckpoints = flags.filter((f) => f.solved).length;
      return {
        problemId: view.problemId,
        solved: solvedCheckpoints === flags.length,
        solvedCheckpoints,
        totalCheckpoints: flags.length,
      };
    }
    return {
      problemId: view.problemId,
      solved: view.scoring?.flagSubmitted === true,
      solvedCheckpoints: 0,
      totalCheckpoints: 0,
    };
  });
}

const NO_PROGRESS: ProblemProgress = {
  problemId: "",
  solved: false,
  solvedCheckpoints: 0,
  totalCheckpoints: 0,
};

/**
 * `requires` edge から「この問題が前提とする問題 id」を取り出す。
 *
 * `requires` の target は problem / learning objective / concept のいずれでもよい。
 * problem を直接指す edge はそのまま前提問題になり、concept を指す edge は
 * 「その concept を `teaches` / `covers` する別の問題」を経由して前提問題に解決する。
 * どちらでも解決できない target は無視する — 前提が判定できないことを `unknown` として
 * 扱うのは呼び出し側の仕事で、ここでは「解決できた前提」だけを返す。
 */
/** concept / learning objective id → それを `teaches` / `covers` している問題 id。 */
function buildProviderIndex(
  catalog: readonly ProblemCatalogEntry[],
): ReadonlyMap<string, readonly string[]> {
  const providers = new Map<string, string[]>();
  for (const candidate of catalog) {
    for (const relation of candidate.graphRelations) {
      if (relation.type !== "teaches" && relation.type !== "covers") continue;
      providers.set(relation.target, [...(providers.get(relation.target) ?? []), candidate.id]);
    }
  }
  return providers;
}

export function resolvePrerequisiteProblemIds(
  entry: ProblemCatalogEntry,
  catalog: readonly ProblemCatalogEntry[],
): { readonly resolved: readonly string[]; readonly unresolvedTargets: readonly string[] } {
  const providers = buildProviderIndex(catalog);
  const resolved = new Set<string>();
  const unresolvedTargets: string[] = [];
  for (const relation of entry.graphRelations) {
    if (relation.type !== "requires") continue;
    if (relation.target.startsWith("problem.")) {
      resolved.add(relation.target.slice("problem.".length));
      continue;
    }
    const owners = (providers.get(relation.target) ?? []).filter((id) => id !== entry.id);
    if (owners.length === 0) {
      unresolvedTargets.push(relation.target);
      continue;
    }
    for (const owner of owners) resolved.add(owner);
  }
  resolved.delete(entry.id); // 自分自身への requires は前提にならない。
  return { resolved: [...resolved].sort(), unresolvedTargets };
}

/**
 * 前提の充足状態を判定する。
 *
 * **cycle は fail-soft** で `unknown` を返す。A が B を、B が A を前提にする catalog は
 * 著者側のバグだが、それで participant の画面が落ちてはいけない。lock もしない —
 * この track の設計方針は「推奨順と hard prerequisite を区別し、未達成でも理由なく
 * 塞がない」なので、判定できないことは表示の弱まりであって通行止めではない。
 */
export function evaluatePrerequisites(
  entry: ProblemCatalogEntry,
  catalog: readonly ProblemCatalogEntry[],
  progressById: ReadonlyMap<string, ProblemProgress>,
): { readonly state: PrerequisiteState; readonly unmet: readonly string[] } {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const { resolved, unresolvedTargets } = resolvePrerequisiteProblemIds(entry, catalog);

  if (hasRequiresCycle(entry.id, resolved, catalog)) return { state: "unknown", unmet: [] };

  const missingFromCatalog = resolved.filter((id) => !byId.has(id));
  if (missingFromCatalog.length > 0 || unresolvedTargets.length > 0) {
    return { state: "unknown", unmet: [] };
  }

  const unmet = resolved.filter((id) => !(progressById.get(id)?.solved ?? false));
  return { state: unmet.length === 0 ? "met" : "unmet", unmet };
}

/**
 * `requires` を problem 単位に潰した有向グラフで、`startId` から自分へ戻れるか。
 *
 * 出発点の前提は呼び出し側が既に解決しているので受け取る (= 二重計算を避けるついでに、
 * 「自分が catalog に無かったら」という起こらない分岐を型の上から消す)。
 */
function hasRequiresCycle(
  startId: string,
  startPrerequisites: readonly string[],
  catalog: readonly ProblemCatalogEntry[],
): boolean {
  const edges = new Map<string, readonly string[]>();
  for (const entry of catalog) {
    edges.set(entry.id, resolvePrerequisiteProblemIds(entry, catalog).resolved);
  }
  const seen = new Set<string>();
  let frontier: readonly string[] = startPrerequisites;
  while (frontier.length > 0) {
    if (frontier.includes(startId)) return true;
    // 訪問済みを落とすので、 diamond 形 (= 2 経路が同じ前提へ合流) でも 1 度しか展開しない。
    const next = frontier.filter((id) => !seen.has(id));
    for (const id of next) seen.add(id);
    frontier = next.flatMap((id) => edges.get(id) ?? []);
  }
  return false;
}

/**
 * 推奨する次の 1 問を選ぶ。deterministic な規則だけで、LLM は使わない (#2786)。
 *
 * `track.order` 昇順に未完了問題を見て、最初に条件を満たしたものを返す:
 *   1. `diagnostic` が未完了なら最優先 (= 前提確認を飛ばさない)
 *   2. hard prerequisite が充足済み (`met` / `unknown`) のもの
 *   3. `synthesis` は他がすべて完了するまで推奨しない (= 複数週の統合は最後)
 *
 * 候補が無ければ undefined。「全部終わった」と「前提が塞がっている」を UI 側で
 * 取り違えないよう、ここでは代替候補を返さない。
 */
export function recommendNext(
  problems: readonly CourseProblemView[],
): CourseProblemView | undefined {
  const unsolved = [...problems]
    .filter((p) => !p.progress.solved)
    .sort((a, b) => a.order - b.order);
  if (unsolved.length === 0) return undefined;

  const startable = unsolved.filter((p) => p.prerequisiteState !== "unmet");

  const diagnostic = startable.find((p) => p.role === "diagnostic");
  if (diagnostic) return diagnostic;

  const nonSynthesis = startable.filter((p) => p.role !== "synthesis");
  if (nonSynthesis.length > 0) return nonSynthesis[0];

  // 残りが synthesis だけ = 他は全部終わっているので、ここで初めて推奨する。
  return startable[0];
}

/**
 * 講座シラバス向けの「次の 1 問」。`courseAlignment.week` と `track.order` が講義順の
 * 正本なので、role を横断して並べ替えず、開始可能な未完了問題を先頭から 1 件だけ返す。
 *
 * 汎用 track の `recommendNext` は synthesis を最後まで温存する。一方 AC26 のような
 * 週次講座で同じ規則を使うと、Week 2 の synthesis を飛ばして Week 3 へ進んでしまうため、
 * course-aligned view では厳密なシラバス順を使い分ける。
 */
export function recommendNextInCourseOrder(
  problems: readonly CourseProblemView[],
): CourseProblemView | undefined {
  return [...problems]
    .filter((problem) => !problem.progress.solved && problem.prerequisiteState !== "unmet")
    .sort((a, b) => a.order - b.order || a.problemId.localeCompare(b.problemId))[0];
}

interface CourseTrackMember {
  readonly entry: ProblemCatalogEntry;
  readonly track: ProblemTrack;
}

function assembleCourseTracks(
  catalog: readonly ProblemCatalogEntry[],
  progress: readonly ProblemProgress[],
  byTrackId: ReadonlyMap<string, readonly CourseTrackMember[]>,
  recommender: (problems: readonly CourseProblemView[]) => CourseProblemView | undefined,
): readonly CourseTrackView[] {
  const progressById = new Map(progress.map((p) => [p.problemId, p]));

  return [...byTrackId.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([trackId, members]) => {
      const entries = members.map((m) => m.entry);
      const views = members
        .map(({ entry, track }) => toProblemView(entry, track, catalog, progressById))
        .sort((a, b) => a.order - b.order || a.problemId.localeCompare(b.problemId));

      // chapter の並びは、 その chapter に属する問題の最小 order で決める。 views は既に
      // order 昇順なので、初出の順がそのまま chapter の順になる。
      const chapterNames: string[] = [];
      for (const view of views) {
        if (!chapterNames.includes(view.chapter)) chapterNames.push(view.chapter);
      }
      const chapters = chapterNames.map((chapter) => ({
        chapter,
        problems: views.filter((v) => v.chapter === chapter),
      }));

      const recommended = recommender(views);
      return {
        trackId,
        ...(entries.find((e) => e.courseAlignment)?.courseAlignment?.edition !== undefined
          ? { edition: entries.find((e) => e.courseAlignment)?.courseAlignment?.edition }
          : {}),
        chapters,
        totalProblems: views.length,
        solvedProblems: views.filter((v) => v.progress.solved).length,
        totalCheckpoints: views.reduce((sum, v) => sum + v.progress.totalCheckpoints, 0),
        solvedCheckpoints: views.reduce((sum, v) => sum + v.progress.solvedCheckpoints, 0),
        ...(recommended ? { recommendedNext: recommended } : {}),
      } as CourseTrackView;
    });
}

/**
 * catalog と progress から track view を組み立てる。
 *
 * `track` を宣言しない問題は 1 件も現れない (= 既存の flat な一覧の対象であり続ける)。
 * chapter の並びは、その chapter に属する問題の最小 `order` で決める — chapter 名の
 * 文字列順に頼ると「Week 10」が「Week 2」より前に来る。
 */
export function buildCourseTracks(
  catalog: readonly ProblemCatalogEntry[],
  progress: readonly ProblemProgress[],
): readonly CourseTrackView[] {
  // `track` を持つ問題だけを、その track と一緒に取り出す。 track の有無で分岐する箇所を
  // ここ 1 か所に閉じることで、 以降は track が必ず存在する前提で書ける。
  const byTrackId = new Map<string, CourseTrackMember[]>();
  for (const entry of catalog) {
    const track = entry.track;
    if (track === undefined) continue;
    byTrackId.set(track.id, [
      ...(byTrackId.get(track.id) ?? []),
      { entry, track: chapterOf(entry, track) },
    ]);
  }

  return assembleCourseTracks(catalog, progress, byTrackId, recommendNext);
}

/**
 * 章の見出しを決める。
 *
 * `track.chapter` は 1 問ごとの小節まで細かく、AC26 では 31 問が 26 章に散る。折りたたみが
 * 1 問ずつ並ぶだけで一覧の体をなさず、受講者は「いま何週目か」を掴めない。`courseAlignment`
 * を持つ問題は週で束ね、7 章にする (= 講座が進む単位と同じ)。
 *
 * alignment を持たない track (`ipa-web-security` / `automotive-security` 等) は数問しかなく、
 * `IPA §1.5 XSS` のような小節見出しがそのまま索引として働くので、従来どおり `track.chapter`
 * を使う。
 */
function chapterOf(entry: ProblemCatalogEntry, track: ProblemTrack): ProblemTrack {
  const week = entry.courseAlignment?.week;
  if (week === undefined) return track;
  return { ...track, chapter: `Week ${week}` };
}

/**
 * Issue #2882: 外部講座に対応づけられた問題を course / week で束ねる。
 *
 * `track.chapter` は 1 問ごとの小節まで細かく、AC26 では 31 問がほぼ 31 section に分かれる。
 * 問題一覧の入口では `courseAlignment.courseId` を course、`week` を 7 つの章として使う。
 * alignment が無い問題はここへ混ぜず、従来の flat catalog に残せるようにする。
 *
 * alignment だけを宣言した将来の問題も落とさない。track.order が無ければ week を第一 key、
 * problem id を tie-breaker にして deterministic に並べる。
 */
export function buildCourseAlignmentTracks(
  catalog: readonly ProblemCatalogEntry[],
  progress: readonly ProblemProgress[],
): readonly CourseTrackView[] {
  const byCourseId = new Map<string, CourseTrackMember[]>();
  for (const entry of catalog) {
    const alignment = entry.courseAlignment;
    if (alignment === undefined) continue;
    const track: ProblemTrack = {
      id: alignment.courseId,
      order: entry.track?.order ?? alignment.week * 10_000,
      chapter: `Week ${alignment.week}`,
    };
    byCourseId.set(alignment.courseId, [
      ...(byCourseId.get(alignment.courseId) ?? []),
      { entry, track },
    ]);
  }

  return assembleCourseTracks(catalog, progress, byCourseId, recommendNextInCourseOrder);
}

function toProblemView(
  entry: ProblemCatalogEntry,
  track: ProblemTrack,
  catalog: readonly ProblemCatalogEntry[],
  progressById: ReadonlyMap<string, ProblemProgress>,
): CourseProblemView {
  const { state, unmet } = evaluatePrerequisites(entry, catalog, progressById);
  const progress = progressById.get(entry.id) ?? { ...NO_PROGRESS, problemId: entry.id };
  return {
    problemId: entry.id,
    name: entry.name,
    chapter: track.chapter,
    order: track.order,
    ...(entry.courseAlignment ? { week: entry.courseAlignment.week } : {}),
    ...(entry.courseAlignment ? { role: entry.courseAlignment.role } : {}),
    difficulty: entry.difficulty,
    estimatedDuration: entry.estimatedDuration,
    learningGoals: entry.learningGoals,
    progress,
    prerequisiteState: state,
    unmetPrerequisites: unmet,
    sources: (entry.courseAlignment?.sources ?? []).map(
      (s: { repository: string; ref: string; path: string }) => ({
        repository: s.repository,
        ref: s.ref,
        path: s.path,
      }),
    ),
  } as CourseProblemView;
}
