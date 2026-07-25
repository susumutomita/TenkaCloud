/**
 * Issue #2786: `metadata.json` の curriculum / 講座対応 / 教育グラフを、participant へ
 * 出してよい形へ narrow する層。
 *
 * `problems.ts` から分けているのは責務が違うから。あちらは「catalog をどう組み立て、どう
 * 引くか」で、こちらは「何を見せてよいか」という fairness contract である。後者は
 * 判断の理由をコメントで残す価値が高く、混ぜると読む理由の違う規則が 1 ファイルに溜まる。
 *
 * ここに UI も fetch も無い。純関数だけなので、投影の境界をテストで固定できる。
 */

/**
 * この module が読む `metadata.json` の部分だけを宣言する。 catalog 全体の入力型
 * (`problems.ts` の `ProblemMetadata`) を import すると循環参照になり、 そもそも
 * 投影が必要とする以上の field を知ってしまう。
 */
export interface ProblemCourseMetadataInput {
  readonly id: string;
  readonly name: string;
  readonly track?: { id?: string; order?: number; chapter?: string };
  readonly courseAlignment?: {
    courseId?: string;
    edition?: string;
    week?: number;
    role?: string;
    spoilerPolicy?: string;
    sources?: { repository?: string; ref?: string; path?: string; kind?: string }[];
  };
  readonly nodes?: {
    learning_objectives?: { id?: string; description?: string }[];
    concepts?: { id?: string; description?: string }[];
    assessment_criteria?: { id?: string; description?: string }[];
    misconceptions?: { id?: string; description?: string }[];
    audiences?: { id?: string; description?: string }[];
  };
  readonly relations?: { type?: string; source?: string; target?: string }[];
}

/**
 * Issue #2786: curriculum 内の位置。`track` を宣言しない問題は course track に属さない
 * (= 既存の flat な問題一覧の挙動は不変)。
 */
export interface ProblemTrackPosition {
  readonly id: string;
  /** track 内の表示順の正本。学習順序そのものは `relations.requires` が正本。 */
  readonly order: number;
  /** 「Week 3 / Elliptic Curves」のような週・章ラベル。grouping の key に使う。 */
  readonly chapter: string;
}

/**
 * Issue #2786 / TenkaCloudChallenge#211: `courseAlignment` の participant-safe な半分。
 *
 * `spoilerPolicy` は**出さない**。素材の出自は authoring 情報であり、参加者が読む理由がない。
 * `embargoed` の問題は field を付けて配るのではなく **projection ごと落とす** (= client が
 * flag を無視しても漏れない)。`sources` は残す — 受講者にとって「どの教材の隣か」は有用で、
 * pinned commit を指す link は答えではない。
 */
export interface ProblemCourseAlignment {
  readonly courseId: string;
  readonly edition: string;
  readonly week: number;
  /** diagnostic / mechanism / assignment-companion / transfer / synthesis。 */
  readonly role: string;
  readonly sources: readonly {
    readonly repository: string;
    readonly ref: string;
    readonly path: string;
    readonly kind: string;
  }[];
}

/**
 * Issue #2786: 教育ナレッジグラフのうち participant に見せてよい node 種別。
 *
 * `assessment_criterion` と `misconception` は**既定で出さない**。前者は「何が採点されるか」を
 * 問題を開く前に列挙してしまい、後者は「よくある誤り」の形で答えの方向を示す。どちらも
 * 開始前に読めるとネタバレになる。`audience` は学習者向けの情報ではないので同様に落とす。
 */
export type ParticipantGraphNodeType = "problem" | "learning_objective" | "concept";

export interface ParticipantGraphNode {
  readonly id: string;
  readonly type: ParticipantGraphNodeType;
  readonly label: string;
}

/**
 * Issue #2786: participant に見せてよい relation 種別。
 *
 * `assesses` は assessment_criterion を指すので落とす。`related_to` は misconception を
 * 指す用途が主で、残す価値に対して漏らす危険が大きいので落とす。残るのは「何を教えるか」
 * (`teaches` / `covers`) と「何が前提か」(`requires`) だけ。
 */
export type ParticipantRelationType = "teaches" | "covers" | "requires";

export interface ParticipantGraphRelation {
  readonly type: ParticipantRelationType;
  readonly source: string;
  readonly target: string;
}

/**
 * Issue #2786: `track` の投影。 3 field すべて揃っていなければ track 未設定として扱う。
 *
 * 部分的な track を通すと grouping key や順序が欠けた row が UI に並ぶ。 半端な位置に
 * 置くより、 track に属さない問題として既存の一覧に出すほうが正しい。
 */
export function toTrackPosition(
  raw: ProblemCourseMetadataInput["track"],
): ProblemTrackPosition | undefined {
  if (!raw || typeof raw.id !== "string" || typeof raw.chapter !== "string") return undefined;
  if (typeof raw.order !== "number" || !Number.isFinite(raw.order)) return undefined;
  return { id: raw.id, order: raw.order, chapter: raw.chapter };
}

/**
 * Issue #2786: `courseAlignment` の participant-safe 投影。
 *
 * `embargoed` は **undefined を返す** (= field を落とすのではなく alignment ごと出さない)。
 * `spoilerPolicy` 自体も投影しない: 素材の出自は authoring 情報で、参加者が読む理由がない。
 */
export function toCourseAlignment(
  raw: ProblemCourseMetadataInput["courseAlignment"],
): ProblemCourseAlignment | undefined {
  if (!raw || raw.spoilerPolicy === "embargoed") return undefined;
  const { courseId, edition, week, role } = raw;
  if (typeof courseId !== "string" || typeof edition !== "string" || typeof role !== "string") {
    return undefined;
  }
  if (typeof week !== "number" || !Number.isFinite(week)) return undefined;
  const sources = (raw.sources ?? []).flatMap((s) =>
    typeof s.repository === "string" &&
    typeof s.ref === "string" &&
    typeof s.path === "string" &&
    typeof s.kind === "string"
      ? [{ repository: s.repository, ref: s.ref, path: s.path, kind: s.kind }]
      : [],
  );
  return { courseId, edition, week, role, sources };
}

/**
 * Issue #2786: graph node の participant-safe 投影。
 *
 * 通すのは learning objective と concept だけ。 assessment criterion は「何が採点されるか」を
 * 開始前に列挙し、 misconception は「よくある誤り」の形で答えの方向を示すため落とす
 * (問題ごとの opt-in も設けない — 既定非表示という判断そのものが fairness contract)。
 * `problem.<id>` node は宣言されないので、 relation から参照できるよう自前で 1 つ足す。
 */
export function toParticipantGraphNodes(
  metadata: Pick<ProblemCourseMetadataInput, "id" | "name" | "nodes">,
): readonly ParticipantGraphNode[] {
  const labelled = (
    raw: { id?: string; description?: string }[] | undefined,
    type: ParticipantGraphNodeType,
  ): ParticipantGraphNode[] =>
    (raw ?? []).flatMap((n) =>
      typeof n.id === "string" && n.id.length > 0
        ? [{ id: n.id, type, label: n.description ?? n.id }]
        : [],
    );
  return [
    { id: `problem.${metadata.id}`, type: "problem", label: metadata.name },
    ...labelled(metadata.nodes?.learning_objectives, "learning_objective"),
    ...labelled(metadata.nodes?.concepts, "concept"),
  ];
}

const PARTICIPANT_RELATION_TYPES: readonly ParticipantRelationType[] = [
  "teaches",
  "covers",
  "requires",
];

/**
 * Issue #2786: relation の participant-safe 投影。
 *
 * `assesses` は assessment criterion を指すので落ちる。 `related_to` は misconception を指す
 * 用途が主なので落ちる。 残る 3 種のうち、 落とした node 種別を指す edge (= 例えば
 * `requires` が audience を指す) は **dangling になるので併せて落とす**。 参照先が無い edge を
 * 残すと、 UI 側が「未解決の前提」として表示してしまう。
 */
export function toParticipantGraphRelations(
  relations: ProblemCourseMetadataInput["relations"],
  visibleNodeIds: ReadonlySet<string>,
): readonly ParticipantGraphRelation[] {
  return (relations ?? []).flatMap((r) => {
    const { type, source, target } = r;
    if (typeof source !== "string" || typeof target !== "string") return [];
    if (!PARTICIPANT_RELATION_TYPES.includes(type as ParticipantRelationType)) return [];
    // 他問題の node を指す edge は残す (= cross-problem の requires が前提解決の要)。
    // 落とした種別 (assessment / misconception / audience) を指す edge だけを弾く。
    const dropped = (id: string) =>
      id.startsWith("assessment.") || id.startsWith("misconception.") || id.startsWith("audience.");
    if (dropped(source) || dropped(target)) return [];
    if (!visibleNodeIds.has(source) && !source.startsWith("problem.")) return [];
    return [{ type: type as ParticipantRelationType, source, target }];
  });
}
