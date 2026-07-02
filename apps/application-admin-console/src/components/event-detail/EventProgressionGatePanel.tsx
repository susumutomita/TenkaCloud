import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import Multiselect from "@cloudscape-design/components/multiselect";
import RadioGroup from "@cloudscape-design/components/radio-group";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Toggle from "@cloudscape-design/components/toggle";
import { toErrorMessage } from "@tenkacloud/web-kit";
import { StatusCodes } from "http-status-codes";
import { useEffect, useState } from "react";
import { type ApiClient, ApiError } from "../../api/client";
import {
  deleteEventProgressionGate,
  type EventDetail,
  getTenantFeatureFlags,
  type ProgressionGateConfig,
  type ProgressionGatePolicy,
  type ProgressionGateTeamOverride,
  putEventProgressionGate,
  putTenantFeatureFlags,
} from "../../api/events-client";
import { Field } from "./shared";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

/**
 * Issue #2283: per-tenant runtime flag key (ADR-035)。 backend
 * (infrastructure/lib/problem-deploy/handlers/shared/progression-gate.ts の
 * `CHALLENGE_PREREQUISITE_GATE_FLAG`) と同じ文字列。 apps は infrastructure を import
 * できないためここに鏡像を持つ。
 */
const GATE_FLAG = "challengePrerequisiteGate";

/** 完了 bonus の上限 (backend `MAX_COMPLETION_BONUS` の鏡像)。 */
const MAX_COMPLETION_BONUS = 100_000;

/** backend `ProgressionGateInvalidReason` の鏡像 (= 400 invalid_progression_gate の reason 値)。 */
const GATE_INVALID_REASONS = [
  "gate_problem_not_in_event",
  "unlock_target_not_in_event",
  "unknown_override_team",
  "event_archived",
] as const;

/** team 行の編集値。 "inherit" = override 無し (= Event default に従う)。 */
type OverridePolicyChoice = "inherit" | ProgressionGatePolicy;
interface OverrideDraft {
  readonly policy: OverridePolicyChoice;
  readonly bonus: string;
}

function initialDrafts(stored: ProgressionGateConfig | undefined): Record<string, OverrideDraft> {
  const out: Record<string, OverrideDraft> = {};
  for (const [teamId, override] of Object.entries(stored?.teamOverrides ?? {})) {
    out[teamId] = {
      policy: override.policy,
      // completionBonus 0 / 未設定は空欄表示 (= 保存時も省略する)。
      bonus:
        override.completionBonus !== undefined && override.completionBonus > 0
          ? String(override.completionBonus)
          : "",
    };
  }
  return out;
}

/** bonus 入力 1 個の検証。空欄は「省略」(= 0 扱い) で valid。 */
function isValidBonusInput(bonus: string): boolean {
  const trimmed = bonus.trim();
  if (trimmed === "") return true;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 0 && n <= MAX_COMPLETION_BONUS;
}

/**
 * client-side 検証 (backend schema の鏡像)。 違反があれば i18n key を返す。
 * gate ∉ targets は UI 構造 (option から gate を除外 + gate 変更時に prune) で担保するが、
 * 保存直前にもここで検査して防御する。
 */
function validateDraft(args: {
  readonly gateProblemId: string | null;
  readonly unlockTargetIds: readonly string[];
  readonly drafts: Readonly<Record<string, OverrideDraft>>;
  readonly teamIds: readonly string[];
}): string | null {
  const { gateProblemId, unlockTargetIds, drafts, teamIds } = args;
  if (!gateProblemId) return "gate.error_gate_required";
  const targets = unlockTargetIds.filter((id) => id !== gateProblemId);
  if (targets.length === 0) return "gate.error_no_targets";
  // #2283: 保存 (buildTeamOverrides) と表示は detail.teams のみを走査するため、 検証も
  // 実在 team の draft に限定する。 でないと除去済み team の残骸 draft が「見えないエラー」で
  // Save を永続 block する。
  for (const teamId of teamIds) {
    const draft = drafts[teamId];
    if (draft && draft.policy !== "inherit" && !isValidBonusInput(draft.bonus)) {
      return "gate.error_bonus_range";
    }
  }
  return null;
}

/**
 * #2283: GET /feature-flags 失敗のうち 「demo mode (Issue #1954) の fixture client が
 * feature-flags API 未実装 (NOT_IMPLEMENTED) を投げた」 場合だけ true。 これは
 * 「flag 行なし = 機能 OFF」 と同義に扱い、 常時表示の Gate tab を error alert で
 * 赤くしない (= read-only の無効 Alert 表示に落とす)。
 */
function isDemoFlagsUnsupported(err: unknown): boolean {
  return err instanceof ApiError && err.status === StatusCodes.NOT_IMPLEMENTED;
}

/**
 * 保存エラーを operator 向け文言に変換する。 backend contract (Issue #2283):
 *   - 409 `{ error: "feature_disabled" }` — tenant flag が途中で OFF になった
 *   - 400 `{ error: "invalid_progression_gate", reason }` — cross-entity 検証失敗
 * ApiError.message は response body を含む (`API 400: {...}`) ので reason を regex で拾う
 * (useEventOperations の formatEndEventError と同じ手法)。
 */
function mapGateSaveError(err: unknown, t: Translate): string {
  if (err instanceof ApiError) {
    if (err.status === StatusCodes.CONFLICT && err.message.includes("feature_disabled")) {
      return t("gate.error_feature_disabled");
    }
    if (err.status === StatusCodes.BAD_REQUEST) {
      const reason = err.message.match(/"reason"\s*:\s*"([a-z_]+)"/)?.[1];
      if (reason && (GATE_INVALID_REASONS as readonly string[]).includes(reason)) {
        return t(`gate.error_reason_${reason}`);
      }
    }
  }
  return toErrorMessage(err);
}

/** Flag OFF 時の read-only 表示 (保存済み設定があるときのみ)。 */
function StoredGateSummary({
  stored,
  t,
}: {
  readonly stored: ProgressionGateConfig;
  readonly t: Translate;
}) {
  return (
    <SpaceBetween size="s">
      <Header variant="h3">{t("gate.stored_readonly_header")}</Header>
      <Field label={t("gate.gate_problem_label")}>
        <code>{stored.gateProblemId}</code>
      </Field>
      <Field label={t("gate.unlock_targets_label")}>
        <code>{stored.unlockTargetIds.join(", ")}</code>
      </Field>
      <Field label={t("gate.default_policy_label")}>
        <code>{stored.defaultPolicy}</code>
      </Field>
      <Field label={t("gate.overrides_header")}>
        {t("gate.stored_overrides_count", {
          count: Object.keys(stored.teamOverrides ?? {}).length,
        })}
      </Field>
    </SpaceBetween>
  );
}

/**
 * Flag ON 時の Gate 編集 form。 「Gate を有効化する」 概念 = 設定 (progressionGate) の有無:
 * `detail.progressionGate` が undefined なら空 form、 あれば prefill。 保存は full-replace の
 * PUT、 除去は confirm modal を挟んだ DELETE (既存 danger 操作の Modal パターン踏襲)。
 */
function GateEditor({
  apiClient,
  canMutateTenant,
  detail,
  onRefresh,
  t,
}: {
  readonly apiClient: ApiClient | null;
  readonly canMutateTenant: boolean;
  readonly detail: EventDetail;
  readonly onRefresh: () => void;
  readonly t: Translate;
}) {
  const stored = detail.progressionGate;
  const [gateProblemId, setGateProblemId] = useState<string | null>(stored?.gateProblemId ?? null);
  const [unlockTargetIds, setUnlockTargetIds] = useState<readonly string[]>(
    stored?.unlockTargetIds ?? [],
  );
  const [defaultPolicy, setDefaultPolicy] = useState<ProgressionGatePolicy>(
    stored?.defaultPolicy ?? "required",
  );
  const [drafts, setDrafts] = useState<Record<string, OverrideDraft>>(() => initialDrafts(stored));
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removeInFlight, setRemoveInFlight] = useState(false);

  const problemIds = detail.problems.map((p) => p.problemId);
  const targetOptions = problemIds
    .filter((id) => id !== gateProblemId)
    .map((id) => ({ value: id, label: id }));
  const validationErrorKey = validateDraft({
    gateProblemId,
    unlockTargetIds,
    drafts,
    teamIds: detail.teams.map((team) => team.teamId),
  });

  const draftFor = (teamId: string): OverrideDraft =>
    drafts[teamId] ?? { policy: "inherit", bonus: "" };
  const setDraft = (teamId: string, next: OverrideDraft) =>
    setDrafts((prev) => ({ ...prev, [teamId]: next }));

  const handleGateChange = (next: string) => {
    setGateProblemId(next);
    // 自己参照 (gate ∈ targets) を UI 段階で防ぐ: gate 変更時に target から除外する。
    setUnlockTargetIds((prev) => prev.filter((id) => id !== next));
  };

  const buildTeamOverrides = ():
    | Readonly<Record<string, ProgressionGateTeamOverride>>
    | undefined => {
    const out: Record<string, ProgressionGateTeamOverride> = {};
    // override は「実在 team のみ」 (= detail.teams を走査): 過去 team の残骸 draft を送らない。
    for (const team of detail.teams) {
      const draft = draftFor(team.teamId);
      if (draft.policy === "inherit") continue;
      const trimmed = draft.bonus.trim();
      const bonus = trimmed === "" ? 0 : Number(trimmed);
      // bonus 0 / 空欄は completionBonus を省略する (= backend 省略時 0 と同義)。
      out[team.teamId] =
        bonus > 0 ? { policy: draft.policy, completionBonus: bonus } : { policy: draft.policy };
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  const handleSave = async () => {
    if (!apiClient || !canMutateTenant || saveInFlight || validationErrorKey) return;
    // validateDraft が gateProblemId 非 null を保証済み。
    /* v8 ignore next */
    if (!gateProblemId) return;
    const teamOverrides = buildTeamOverrides();
    const config: ProgressionGateConfig = {
      gateProblemId,
      unlockTargetIds: unlockTargetIds.filter((id) => id !== gateProblemId),
      defaultPolicy,
      ...(teamOverrides ? { teamOverrides } : {}),
    };
    setSaveInFlight(true);
    setSaveError(null);
    setSavedFlash(false);
    try {
      await putEventProgressionGate(apiClient, detail.eventId, config);
      setSavedFlash(true);
      onRefresh();
    } catch (err) {
      setSaveError(mapGateSaveError(err, t));
    } finally {
      setSaveInFlight(false);
    }
  };

  const handleRemove = async () => {
    if (!apiClient || !canMutateTenant || removeInFlight) return;
    setRemoveInFlight(true);
    setSaveError(null);
    try {
      await deleteEventProgressionGate(apiClient, detail.eventId);
      setConfirmRemove(false);
      onRefresh();
    } catch (err) {
      setSaveError(toErrorMessage(err));
    } finally {
      setRemoveInFlight(false);
    }
  };

  const policyChoiceLabel = (choice: OverridePolicyChoice): string =>
    t(`gate.policy_${choice === "inherit" ? "inherit" : choice}`);

  return (
    <SpaceBetween size="l">
      {saveError && (
        <Alert type="error" header={t("gate.error_save_header")}>
          {saveError}
        </Alert>
      )}
      {savedFlash && (
        <Alert type="success" dismissible onDismiss={() => setSavedFlash(false)}>
          {t("gate.saved_flash")}
        </Alert>
      )}

      <Field label={t("gate.gate_problem_label")}>
        <Select
          selectedOption={gateProblemId ? { value: gateProblemId, label: gateProblemId } : null}
          options={problemIds.map((id) => ({ value: id, label: id }))}
          placeholder={t("gate.gate_problem_placeholder")}
          onChange={({ detail: d }) => {
            if (d.selectedOption.value) handleGateChange(d.selectedOption.value);
          }}
          disabled={!canMutateTenant}
        />
      </Field>
      <Field label={t("gate.unlock_targets_label")}>
        <Multiselect
          selectedOptions={unlockTargetIds.map((id) => ({ value: id, label: id }))}
          options={targetOptions}
          placeholder={t("gate.unlock_targets_placeholder")}
          onChange={({ detail: d }) =>
            setUnlockTargetIds(
              d.selectedOptions
                .map((o) => o.value)
                .filter((v): v is string => typeof v === "string"),
            )
          }
          disabled={!canMutateTenant}
        />
      </Field>
      <Field label={t("gate.default_policy_label")}>
        <RadioGroup
          value={defaultPolicy}
          // #2283: RadioGroup は group-level disabled prop を持たないため、 他 control と同じ
          // read-only guard を per-item disabled で掛ける。
          items={[
            { value: "required", label: t("gate.policy_required"), disabled: !canMutateTenant },
            { value: "off", label: t("gate.policy_off"), disabled: !canMutateTenant },
          ]}
          onChange={({ detail: d }) => setDefaultPolicy(d.value as ProgressionGatePolicy)}
        />
      </Field>

      <Header variant="h3" description={t("gate.overrides_description")}>
        {t("gate.overrides_header")}
      </Header>
      {detail.teams.length === 0 ? (
        <Box variant="small" color="text-status-inactive">
          {t("gate.overrides_empty")}
        </Box>
      ) : (
        <SpaceBetween size="xs">
          {detail.teams.map((team) => {
            const draft = draftFor(team.teamId);
            const overridden = draft.policy !== "inherit";
            return (
              <SpaceBetween key={team.teamId} direction="horizontal" size="xs" alignItems="center">
                <Box variant="strong">{team.displayName || team.internalSlug}</Box>
                <Select
                  selectedOption={{ value: draft.policy, label: policyChoiceLabel(draft.policy) }}
                  options={(["inherit", "required", "off"] as const).map((choice) => ({
                    value: choice,
                    label: policyChoiceLabel(choice),
                  }))}
                  onChange={({ detail: d }) =>
                    setDraft(team.teamId, {
                      ...draft,
                      policy: (d.selectedOption.value ?? "inherit") as OverridePolicyChoice,
                    })
                  }
                  disabled={!canMutateTenant}
                />
                <Input
                  type="number"
                  inputMode="numeric"
                  placeholder={t("gate.bonus_placeholder")}
                  value={draft.bonus}
                  onChange={({ detail: d }) => setDraft(team.teamId, { ...draft, bonus: d.value })}
                  // bonus は override したときだけ意味を持つ (= inherit 行は入力不可)。
                  disabled={!canMutateTenant || !overridden}
                />
              </SpaceBetween>
            );
          })}
        </SpaceBetween>
      )}

      {validationErrorKey && (
        <Box variant="small" color="text-status-error">
          {t(validationErrorKey)}
        </Box>
      )}
      <SpaceBetween direction="horizontal" size="xs">
        <Button
          variant="primary"
          loading={saveInFlight}
          disabled={!apiClient || !canMutateTenant || validationErrorKey !== null || saveInFlight}
          onClick={() => void handleSave()}
        >
          {t("gate.save_button")}
        </Button>
        {stored && (
          <Button
            loading={removeInFlight}
            disabled={!apiClient || !canMutateTenant || removeInFlight}
            onClick={() => setConfirmRemove(true)}
          >
            {t("gate.remove_button")}
          </Button>
        )}
      </SpaceBetween>

      {confirmRemove && (
        <Modal
          visible
          header={t("gate.modal_remove_header")}
          onDismiss={() => setConfirmRemove(false)}
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button onClick={() => setConfirmRemove(false)}>{t("gate.modal_cancel")}</Button>
                <Button
                  variant="primary"
                  loading={removeInFlight}
                  disabled={!canMutateTenant}
                  onClick={() => void handleRemove()}
                >
                  {t("gate.modal_remove_confirm")}
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          {t("gate.modal_remove_body")}
        </Modal>
      )}
    </SpaceBetween>
  );
}

/**
 * Issue #2283: Event Detail の "Progression / Gate (Advanced)" tab の本体 panel。
 *
 * tab 自体は常時表示し、 挙動は per-tenant runtime flag `challengePrerequisiteGate`
 * (既定 OFF) で切り替える。 有効判定は **`GET /feature-flags` (tenant DDB row) のみ** —
 * `config.features` は使わない。 backend の enforcement (`tenant-feature-flags.ts`) が
 * 同じ行だけを見るため、 判定源を一致させないと「UI は編集可なのに保存が 409」の
 * ちぐはぐが起きる。
 *
 *   - Flag OFF: 無効 Alert + 保存済み設定の read-only 表示。 Toggle で ON 化
 *     (`PUT /admin/feature-flags`, TenantAdmin のみ — 403 は role エラー文言)。
 *   - Flag ON: Gate 編集 form (`GateEditor`)。 Toggle で OFF 化 (鏡像フロー)。
 */
export function EventProgressionGatePanel({
  apiClient,
  canMutateTenant,
  detail,
  onRefresh,
  t,
}: {
  readonly apiClient: ApiClient | null;
  readonly canMutateTenant: boolean;
  readonly detail: EventDetail;
  readonly onRefresh: () => void;
  readonly t: Translate;
}) {
  const [flags, setFlags] = useState<Readonly<Record<string, boolean>> | null>(null);
  const [flagsError, setFlagsError] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [toggleInFlight, setToggleInFlight] = useState(false);

  useEffect(() => {
    if (!apiClient) return;
    let cancelled = false;
    (async () => {
      try {
        const fetched = await getTenantFeatureFlags(apiClient);
        if (!cancelled) setFlags(fetched);
      } catch (err) {
        if (cancelled) return;
        // #2283: demo NOT_IMPLEMENTED は「flag 行なし = 機能 OFF」扱い (isDemoFlagsUnsupported)。
        if (isDemoFlagsUnsupported(err)) {
          setFlags({});
        } else {
          setFlagsError(toErrorMessage(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiClient]);

  // registry default false: tenant 行に true が無い限り無効 (= backend 判定と同一)。
  const enabled = flags?.[GATE_FLAG] === true;

  const handleToggleFlag = async (next: boolean) => {
    if (!apiClient || toggleInFlight) return;
    setToggleInFlight(true);
    setToggleError(null);
    try {
      // #2283: PUT /admin/feature-flags は full-replace。 mount 時 snapshot (state の flags) に
      // merge すると、 他 admin / 他 tab がその後に変えた flag を黙って巻き戻すため、
      // 直前に最新 flags を再取得してそちらへ merge する。
      const current = await getTenantFeatureFlags(apiClient);
      const updated = await putTenantFeatureFlags(apiClient, {
        ...current,
        [GATE_FLAG]: next,
      });
      setFlags(updated);
    } catch (err) {
      setToggleError(
        err instanceof ApiError && err.status === StatusCodes.FORBIDDEN
          ? t("gate.error_toggle_forbidden")
          : toErrorMessage(err),
      );
    } finally {
      setToggleInFlight(false);
    }
  };

  return (
    <Container
      header={
        <Header variant="h2" description={t("gate.description")}>
          {t("gate.header")}
        </Header>
      }
    >
      <SpaceBetween size="l">
        {flagsError && (
          <Alert type="error" header={t("gate.flags_error_header")}>
            {flagsError}
          </Alert>
        )}
        {toggleError && <Alert type="error">{toggleError}</Alert>}
        {flags === null ? (
          !flagsError && (
            <Box variant="small" color="text-status-inactive">
              {t("gate.loading")}
            </Box>
          )
        ) : (
          <>
            <Toggle
              checked={enabled}
              disabled={!apiClient || toggleInFlight}
              onChange={({ detail: d }) => void handleToggleFlag(d.checked)}
            >
              {t("gate.feature_toggle_label")}
            </Toggle>
            {enabled ? (
              <GateEditor
                // #2283: 保存済み設定が変わったら remount して stale form を防ぐ
                // (Remove + refresh 後 / 他 session の保存が refresh で届いた後)。
                key={JSON.stringify(detail.progressionGate ?? null)}
                apiClient={apiClient}
                canMutateTenant={canMutateTenant}
                detail={detail}
                onRefresh={onRefresh}
                t={t}
              />
            ) : (
              <>
                <Alert type="info" header={t("gate.disabled_alert_header")}>
                  {t("gate.disabled_alert_body")}
                </Alert>
                {detail.progressionGate && (
                  <StoredGateSummary stored={detail.progressionGate} t={t} />
                )}
              </>
            )}
          </>
        )}
      </SpaceBetween>
    </Container>
  );
}
