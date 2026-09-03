import type { StatusIndicatorProps } from "@cloudscape-design/components/status-indicator";
import {
  type ApplicationStatus,
  type ApplicationStatusOverall,
  type AttackProbeOutcome,
  type AttackProbeResult,
  type ParticipantHintView,
  type ParticipantProblemView,
  PortalScoringGateError,
  PortalValidationError,
  type SubmitFlagOutcome,
} from "../api/portal-client";
import { findProblemMetadata } from "../data/problems";
import type { LocaleCode } from "../i18n";

export type ProblemPanelT = (
  key: string,
  params?: Readonly<Record<string, string | number>>,
) => string;

/**
 * Issue #1917: uptime kind の participant-safe な集約 health を StatusIndicator と人間可読ラベルに
 * 変換する pure helper。競技者は「なぜ減点されたか」を、落ちている個別 endpoint URL を
 * 知らずとも「サービスが degraded/down」という形で把握できる (per-endpoint は露出しない)。
 */
const APP_STATUS_INDICATOR: Record<ApplicationStatusOverall, StatusIndicatorProps.Type> = {
  healthy: "success",
  degraded: "warning",
  down: "error",
  unknown: "pending",
};

export function describeApplicationStatus(
  status: ApplicationStatus,
  t: ProblemPanelT,
): { readonly type: StatusIndicatorProps.Type; readonly label: string } {
  return {
    type: APP_STATUS_INDICATOR[status.overall],
    label: t(`problem_panel.health_${status.overall}`, {
      healthy: status.healthyCount,
      total: status.totalCount,
    }),
  };
}

/**
 * Issue #2422: 1 attack-probe の直近サイクルの結果を StatusIndicator + 人間可読ラベルに変換する。
 * defender は「green (200) なのに満点にならない理由」= まだ刺さっている probe を、 正確な endpoint /
 * 脆弱性クラスを知らずとも「landed → -N pt このサイクル」という形で把握できる (非スポイラー)。
 *
 *   - landed  → error   「−penalty pt (このサイクル)」= 脆弱、 まだ刺さっている
 *   - blocked → success 「防御成功 (0 pt)」= 防げている
 *   - skipped → pending 「判定不能」= slot 未解決 / 到達不能 (可用性は別途)
 *
 * `label` / `symptom` は問題側 metadata が明示した非スポイラー文言のみ。 label 不在なら index で採番。
 */
const ATTACK_PROBE_INDICATOR: Record<AttackProbeOutcome, StatusIndicatorProps.Type> = {
  landed: "error",
  blocked: "success",
  skipped: "pending",
};

export interface AttackProbeRow {
  readonly type: StatusIndicatorProps.Type;
  readonly name: string;
  readonly outcomeLabel: string;
  readonly symptom?: string;
}

export function describeAttackProbe(
  probe: AttackProbeResult,
  index: number,
  t: ProblemPanelT,
): AttackProbeRow {
  const name = probe.label?.trim()
    ? probe.label
    : t("problem_panel.attack_probe_default_name", {
        index: index + 1,
      });
  const delta = probe.outcome === "landed" ? -probe.penalty : 0;
  return {
    type: ATTACK_PROBE_INDICATOR[probe.outcome],
    name,
    outcomeLabel: t(`problem_panel.attack_probe_${probe.outcome}`, {
      penalty: probe.penalty,
      delta,
    }),
    ...(probe.symptom?.trim() ? { symptom: probe.symptom } : {}),
  };
}

/**
 * Issue #2422: 攻撃 probe の集約要約。 landed が 1 つでもあれば warning (= 減点中) を、 全て
 * blocked/skipped なら success 寄りの中立を返し、 セクション見出しの StatusIndicator に使う。
 */
export function summarizeAttackProbes(
  probes: readonly AttackProbeResult[],
  t: ProblemPanelT,
): { readonly type: StatusIndicatorProps.Type; readonly label: string } {
  const landed = probes.filter((p) => p.outcome === "landed").length;
  if (landed > 0) {
    return {
      type: "warning",
      label: t("problem_panel.attack_probe_summary_landed", { landed, total: probes.length }),
    };
  }
  return {
    type: "success",
    label: t("problem_panel.attack_probe_summary_clear", { total: probes.length }),
  };
}

type ProblemPanelValidationMessageKey =
  | "problem_panel.submit_error_prefix"
  | "problem_panel.validation_error";

/**
 * Issue #1006: scoring gate (= 競技開始前 / 終了後 / 一時停止) のエラーを 「いつ開始 / 終了か」
 * を添えた人間可読 message に変換する。 backend が startsAt / endsAt を返すようになったので、
 * UI 側で 「あと N 分」 を計算して表示する。 #1093: i18n 化。
 */
function describeScoringGate(
  t: ProblemPanelT,
  err: PortalScoringGateError,
  now: Date = new Date(),
): string {
  if (err.kind === "scoring_not_started") {
    if (!err.startsAt) return t("problem_panel.scoring_gate_not_started_no_eta");
    const startsAt = new Date(err.startsAt);
    if (Number.isNaN(startsAt.getTime())) {
      return t("problem_panel.scoring_gate_not_started_unknown");
    }
    const diffMs = startsAt.getTime() - now.getTime();
    if (diffMs <= 0) {
      return t("problem_panel.scoring_gate_not_started_passed", {
        startsAt: startsAt.toLocaleString(),
      });
    }
    const minutes = Math.ceil(diffMs / 60_000);
    return t("problem_panel.scoring_gate_not_started_remaining", {
      minutes,
      startsAt: startsAt.toLocaleString(),
    });
  }
  if (err.kind === "scoring_ended") {
    if (!err.endsAt) return t("problem_panel.scoring_gate_ended_no_eta");
    const endsAt = new Date(err.endsAt);
    if (Number.isNaN(endsAt.getTime())) return t("problem_panel.scoring_gate_ended_unknown");
    return t("problem_panel.scoring_gate_ended_at", { endsAt: endsAt.toLocaleString() });
  }
  return t("problem_panel.scoring_gate_paused");
}

/**
 * [#3008] 「この機材ではこの問題の結果に意味が無いので起動しない」を、 参加者の locale で
 * 具体的に説明する。
 *
 * server も同じ事実から en / ja の文面を作るが、 それは CLI 用。 portal は i18n を持って
 * いるので、 文面ではなく `code` と構造化 field (required architecture / 実 architecture /
 * 欠けている CPU flag) を受け取り、 自分の resource で組み立てる。 server 文面をそのまま
 * 出すと portal の言語切替が効かない 1 か所になる。
 *
 * `code` が未知のときは generic に落ちる。 拒否理由が読めないことはあっても、 拒否そのものが
 * 「不明なエラー」に化けてはいけない。
 */
function describeIncompatibleHost(
  t: ProblemPanelT,
  details: Readonly<Record<string, unknown>> | undefined,
): string {
  const list = (value: unknown): string =>
    Array.isArray(value) ? value.filter((v) => typeof v === "string").join(", ") : "";
  const required = list(details?.requiredArchitectures);
  const host = typeof details?.hostArchitecture === "string" ? details.hostArchitecture : "";
  const flags = list(details?.missingCpuFlags);
  switch (details?.code) {
    case "unsupported_architecture":
      return t("problem_panel.incompatible_host_unsupported_architecture", { required, host });
    case "unknown_host_architecture":
      return t("problem_panel.incompatible_host_unknown_architecture", { required });
    case "missing_cpu_flags":
      return t("problem_panel.incompatible_host_missing_cpu_flags", { flags });
    case "unknown_cpu_flags":
      return t("problem_panel.incompatible_host_unknown_cpu_flags", { flags });
    default:
      return t("problem_panel.incompatible_host_generic");
  }
}

export function formatProblemPanelActionError(
  t: ProblemPanelT,
  err: unknown,
  validationMessageKey: ProblemPanelValidationMessageKey,
): string {
  if (err instanceof PortalScoringGateError) return describeScoringGate(t, err);
  if (err instanceof PortalValidationError) {
    // Issue #2283: Progression Gate。 locked 問題への flag 提出 / hint reveal は backend が
    // 409 challenge_prerequisite_not_met で拒否する。 UI は通常 lock 表示で先回りするので
    // 到達しないが、 polling 反映前の隙間で届いたときに親切文言を出す (defense-in-depth)。
    if (err.errorCode === "challenge_prerequisite_not_met") {
      return t("problem_panel.prerequisite_locked_error");
    }
    if (err.errorCode === "incompatible_host") return describeIncompatibleHost(t, err.details);
    return t(validationMessageKey, { errorCode: err.errorCode });
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function shouldRefreshAfterFlagSubmit(result: SubmitFlagOutcome): boolean {
  return result.kind === "ok" || result.kind === "already_scored";
}

/**
 * #2054 i18n: resolve a revealed hint's content for the current locale. The en
 * override lives in `i18n.en.content` (present only once revealed, mirroring
 * `content`); ja is the canonical `content`. Empty/missing → canonical.
 */
function localizeHint(hint: ParticipantHintView): ParticipantHintView {
  const enContent = hint.i18n?.en?.content;
  return enContent?.trim() ? { ...hint, content: enContent } : hint;
}

/**
 * #2054 i18n: resolve the displayed problem text for the current locale so the
 * portal's locale switcher localizes the live API view (name / description /
 * instructions / operation video + revealed hint content). ja is the top-level canonical and is
 * returned unchanged; en overlays each field from `i18n.en`, falling back to the
 * canonical value when an override is missing or empty.
 */
export function localizeProblem(
  problem: ParticipantProblemView,
  lang: LocaleCode,
): ParticipantProblemView {
  if (lang !== "en") return problem;
  const en = problem.i18n?.en;
  const hints = problem.scoring?.hints;
  // #2711 follow-up: multi-flag の per-flag hints も locale 解決する。 以前は問題レベルの
  // hints だけを map しており、 ドリルのヒントが en locale でも ja のまま表示されていた。
  const flags = problem.scoring?.flags;
  return {
    ...problem,
    ...(en?.name?.trim() ? { name: en.name } : {}),
    ...(en?.description?.trim() ? { description: en.description } : {}),
    ...(en?.instructions?.trim() ? { instructions: en.instructions } : {}),
    ...(en?.writeup?.trim() ? { writeup: en.writeup } : {}),
    ...(en?.videoUrl?.trim() ? { videoUrl: en.videoUrl } : {}),
    ...(problem.scoring && (hints || flags)
      ? {
          scoring: {
            ...problem.scoring,
            ...(hints ? { hints: hints.map(localizeHint) } : {}),
            ...(flags
              ? {
                  flags: flags.map((flag) =>
                    flag.hints ? { ...flag, hints: flag.hints.map(localizeHint) } : flag,
                  ),
                }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * [#2527 Slice 6] ProblemPanel の pure view-model helpers — 表示判定・整形のみで
 * React state を持たない層。ProblemPanel.tsx (view + composition) から verbatim 移設。
 */

const SCORING_KIND_KEY: Record<string, string> = {
  flag: "problem_panel.kind_flag",
  "multi-flag": "problem_panel.kind_multi_flag",
  uptime: "problem_panel.kind_uptime",
  "uptime-flat": "problem_panel.kind_uptime",
  "uptime-multi": "problem_panel.kind_uptime",
  "phased-polling": "problem_panel.kind_phased",
  "attack-detection": "problem_panel.kind_attack",
};

type FlagScoringInfo = NonNullable<ParticipantProblemView["scoring"]>;
type StackOutputEntry = [label: string, value: string];

/** uptime kind で `lastScoredAt` がこの閾値より古ければ「停滞」表示。 */
const STALE_THRESHOLD_MS = 2 * 60 * 1000;

const AUTO_DELETE_SOON_THRESHOLD_MS = 15 * 60 * 1000;
const HTTP_URL_OUTPUT_RE = /^https?:\/\//i;

export function describeRemainingUntilAutoDelete(t: ProblemPanelT, diffMs: number): string {
  const totalMinutes = Math.max(1, Math.ceil(diffMs / 60_000));
  return t("problem_panel.auto_delete_remaining_minutes", { minutes: totalMinutes });
}

export function buildAutoDeleteNotice(
  t: ProblemPanelT,
  expiresAt: number,
  nowMs: number,
): { readonly type: "warning"; readonly body: string } | undefined {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return undefined;
  const expiresAtMs = expiresAt * 1000;
  const expiresAtLabel = new Date(expiresAtMs).toLocaleString();
  const diffMs = expiresAtMs - nowMs;
  if (diffMs <= 0) {
    return {
      type: "warning",
      body: t("problem_panel.auto_delete_expired_body", { expiresAt: expiresAtLabel }),
    };
  }
  if (diffMs <= AUTO_DELETE_SOON_THRESHOLD_MS) {
    const remaining = describeRemainingUntilAutoDelete(t, diffMs);
    return {
      type: "warning",
      body: t("problem_panel.auto_delete_soon_body", { remaining, expiresAt: expiresAtLabel }),
    };
  }
  return undefined;
}

export function isHttpUrlOutput(value: string): boolean {
  return HTTP_URL_OUTPUT_RE.test(value);
}

// Codespaces gives each forwarded port its own origin. Recover a terminal
// loopback hint only when the target hostname has the exact same codespace name
// and forwarding domain as this portal's 5175 origin.
export function codespacesLoopbackUrl(
  value: string,
  portalHostname = globalThis.location?.hostname,
): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const credentialFreePrefix = `${url.protocol}//${url.host}/`;
  if (
    url.protocol !== "https:" ||
    !url.href.startsWith(credentialFreePrefix) ||
    url.port ||
    !portalHostname
  ) {
    return undefined;
  }
  const portal = /^(?<name>.+)-5175\.(?<domain>.+)$/.exec(portalHostname);
  if (!portal?.groups) return undefined;
  const prefix = `${portal.groups.name}-`;
  const suffix = `.${portal.groups.domain}`;
  if (!url.hostname.startsWith(prefix) || !url.hostname.endsWith(suffix)) return undefined;
  const rawPort = url.hostname.slice(prefix.length, -suffix.length);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return `http://localhost:${port}${url.pathname}${url.search}`;
}

export function splitStackOutputs(stackOutputs: ParticipantProblemView["stackOutputs"]): {
  readonly accessUrlEntries: StackOutputEntry[];
  readonly detailEntries: StackOutputEntry[];
} {
  const entries = Object.entries(stackOutputs);
  const accessUrlEntries = entries.filter(([, value]) => isHttpUrlOutput(value));
  const nonUrlEntries = entries.filter(([, value]) => !isHttpUrlOutput(value));
  return {
    accessUrlEntries,
    detailEntries: accessUrlEntries.length > 0 ? nonUrlEntries : entries,
  };
}

export function describeProblemKind(
  t: ProblemPanelT,
  scoring: ParticipantProblemView["scoring"],
): string {
  if (!scoring) return t("problem_panel.kind_unknown");
  return t(SCORING_KIND_KEY[scoring.kind] ?? "problem_panel.kind_unknown");
}

export function isUptimeScoring(scoring: ParticipantProblemView["scoring"]): boolean {
  // flag / multi-flag は Challenge (= 提出型)。 それ以外 (uptime 系 / phased / attack) は Battle 軸の
  // 「古い lastScoredAt = stale」 UX を適用する (= polling 採点だから停滞が意味を持つ)。
  return scoring ? scoring.kind !== "flag" && scoring.kind !== "multi-flag" : false;
}

export function isStaleProblem(problem: ParticipantProblemView, now: number): boolean {
  const lastScoredMs = problem.lastScoredAt ? new Date(problem.lastScoredAt).getTime() : Number.NaN;
  return (
    isUptimeScoring(problem.scoring) &&
    Number.isFinite(lastScoredMs) &&
    now - lastScoredMs > STALE_THRESHOLD_MS &&
    problem.status === "COMPLETE"
  );
}

export function getCompleteFlagScoring(
  problem: ParticipantProblemView,
): FlagScoringInfo | undefined {
  const scoring = problem.scoring;
  if (problem.status !== "COMPLETE" || scoring?.kind !== "flag") return undefined;
  return scoring;
}

/**
 * Issue #1796: deploy COMPLETE かつ multi-flag kind のときだけ MultiFlagSubmissionPanel を出す
 * (= 単一 flag kind の getCompleteFlagScoring と同方針。 deploy 未完だと flagOutputKey の値が無く
 * 提出しても no_outputs になるため)。
 */
export function getCompleteMultiFlagScoring(
  problem: ParticipantProblemView,
): FlagScoringInfo | undefined {
  const scoring = problem.scoring;
  if (problem.status !== "COMPLETE" || scoring?.kind !== "multi-flag") return undefined;
  return scoring;
}

/**
 * [#2392 Phase 2] play surface (access URL / flag 提出) を出してよいか。 lifecycle 不在は
 * AWS mode (= per-competitor container 無し) なので常に playable (後方互換)。 stopped /
 * starting / error の間は stackOutputs が空・ submit が 409 not_running になるため隠す。
 */
export function isProblemPlayable(problem: ParticipantProblemView): boolean {
  const status = problem.lifecycle?.status;
  return status === undefined || status === "running";
}

/**
 * [#2846] container terminal は docker runtime の問題にだけ出す。 simulated-cloud (= console
 * handoff で足りる) と AWS mode (lifecycle 不在、 この endpoint 自体が存在しない) には出さない。
 * stopped/starting/error は呼び出し側の `playable` 判定で既に play surface ごと隠れるため、
 * lifecycle の中だけを見れば足りる。
 *
 * [#2850] terminal は問題単位の opt-in。 shell は対象 image の中身をそのまま読めるため、
 * metadata が `runtime.terminal` を宣言した問題 (= backend が `lifecycle.terminal` を送る
 * 問題) にだけ出す。 runtimeKind === "docker" だけでは出さない — 宣言の無い docker 問題は
 * handoff も 404 になるので、 panel を出しても接続できない。
 */
export function shouldShowContainerTerminal(problem: ParticipantProblemView): boolean {
  return problem.lifecycle?.runtimeKind === "docker" && problem.lifecycle.terminal === true;
}

/**
 * #1975: パネル title は人間可読な name を優先し、 不在時 (= AWS mode で問題文未配信) は
 * problemId に fall back する。
 */
/**
 * The name a participant should see for a problem.
 *
 * [Issue #3171] The last resort used to be `problemId`, and on live that is what
 * a participant got: a card headed `ac26-crypto-battle` sitting under a page
 * titled 「PROVE / LEAK / HUNT — 暗号リアルタイム判断 Battle」, two names for one
 * problem on one screen, one of them an internal identifier.
 *
 * The catalog is consulted before giving up, the same way `ProblemDetail` has
 * always done for the page title. The team view's `name` still wins when it has
 * one — it is what the operator deployed — and the id survives only for a
 * problem that is in neither, which is a problem the catalog has never seen.
 */
export function resolveProblemTitle(problem: ParticipantProblemView): string {
  if (problem.name?.trim()) return problem.name;
  const catalogName = findProblemMetadata(problem.problemId)?.name;
  return catalogName?.trim() ? catalogName : problem.problemId;
}

/**
 * description が非空なら問題文セクションを描画する。
 *
 * #2473: instructions の正本は `ProblemInfoSection`(`ProblemDetail.tsx`)に一本化した
 * (AWS モードでも出る唯一の instructions 描画経路)。ここは description のみで判定する —
 * instructions だけ非空・description 空の問題では、もう描画するものが無いので false になる。
 *
 * TS の user-defined type guard (`problem is ... & { description: string }`) にして、
 * 呼び出し側の `if (!hasProblemStatement(problem)) return null;` 後に `problem.description`
 * が `string` に narrow されるようにする(= `?? ""` のような到達しない fallback 分岐を
 * 作らずに済む)。
 */
export function hasProblemStatement(
  problem: ParticipantProblemView,
): problem is ParticipantProblemView & { description: string } {
  return Boolean(problem.description?.trim());
}
