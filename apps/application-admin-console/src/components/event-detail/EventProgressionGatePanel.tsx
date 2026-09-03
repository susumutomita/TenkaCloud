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
import type { ApiClient } from "../../api/client";
import type {
  EventDetail,
  ProgressionGateConfig,
  ProgressionGatePolicy,
} from "../../api/events-client";
import type { OverridePolicyChoice } from "./progression-gate-models";
import { Field } from "./shared";
import { useGateEditor, useTenantGateFlag } from "./useProgressionGate";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

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
 * Flag ON 時の Gate 編集 form (表示のみ — form state / 検証 / mutation は `useGateEditor`)。
 * 保存は full-replace の PUT、 除去は confirm modal を挟んだ DELETE (既存 danger 操作の
 * Modal パターン踏襲)。
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
  const editor = useGateEditor({ apiClient, canMutateTenant, detail, onRefresh, t });
  const stored = detail.progressionGate;

  const problemIds = detail.problems.map((p) => p.problemId);
  const targetOptions = problemIds
    .filter((id) => id !== editor.gateProblemId)
    .map((id) => ({ value: id, label: id }));

  const policyChoiceLabel = (choice: OverridePolicyChoice): string =>
    t(`gate.policy_${choice === "inherit" ? "inherit" : choice}`);

  return (
    <SpaceBetween size="l">
      {editor.saveError && (
        <Alert type="error" header={t("gate.error_save_header")}>
          {editor.saveError}
        </Alert>
      )}
      {editor.savedFlash && (
        <Alert type="success" dismissible onDismiss={editor.dismissSavedFlash}>
          {t("gate.saved_flash")}
        </Alert>
      )}

      <Field label={t("gate.gate_problem_label")}>
        <Select
          selectedOption={
            editor.gateProblemId
              ? { value: editor.gateProblemId, label: editor.gateProblemId }
              : null
          }
          options={problemIds.map((id) => ({ value: id, label: id }))}
          placeholder={t("gate.gate_problem_placeholder")}
          onChange={({ detail: d }) => {
            // option は全件 value 付きで構築するため、 undefined guard は型 narrowing の防御 (不到達)。
            /* v8 ignore next */
            if (d.selectedOption.value) editor.changeGateProblem(d.selectedOption.value);
          }}
          disabled={!canMutateTenant}
        />
      </Field>
      <Field label={t("gate.unlock_targets_label")}>
        <Multiselect
          selectedOptions={editor.unlockTargetIds.map((id) => ({ value: id, label: id }))}
          options={targetOptions}
          placeholder={t("gate.unlock_targets_placeholder")}
          onChange={({ detail: d }) =>
            editor.setUnlockTargetIds(
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
          value={editor.defaultPolicy}
          // #2283: RadioGroup は group-level disabled prop を持たないため、 他 control と同じ
          // read-only guard を per-item disabled で掛ける。
          items={[
            { value: "required", label: t("gate.policy_required"), disabled: !canMutateTenant },
            { value: "off", label: t("gate.policy_off"), disabled: !canMutateTenant },
          ]}
          onChange={({ detail: d }) => editor.setDefaultPolicy(d.value as ProgressionGatePolicy)}
        />
      </Field>
      {/*
        [Issue #3174] The event's own bonus. Without it the effective figure was
        0 with nowhere on screen to say so, and the only way to hand out a
        handicap was to override every team's policy one row at a time.
      */}
      <Field label={t("gate.default_bonus_label")}>
        <Box variant="small" color="text-body-secondary">
          {t("gate.default_bonus_description")}
        </Box>
        <Input
          type="number"
          inputMode="numeric"
          placeholder={t("gate.default_bonus_placeholder")}
          value={editor.defaultBonus}
          onChange={({ detail: d }) => editor.setDefaultBonus(d.value)}
          disabled={!canMutateTenant}
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
            const draft = editor.draftFor(team.teamId);
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
                    editor.setDraft(team.teamId, {
                      ...draft,
                      // option は全件 value 付きなので ?? の右辺は型ガード (不到達)。
                      /* v8 ignore next */
                      policy: (d.selectedOption.value ?? "inherit") as OverridePolicyChoice,
                    })
                  }
                  disabled={!canMutateTenant}
                />
                <Input
                  type="number"
                  inputMode="numeric"
                  placeholder={editor.defaultBonus.trim() || t("gate.bonus_placeholder")}
                  value={draft.bonus}
                  onChange={({ detail: d }) =>
                    editor.setDraft(team.teamId, { ...draft, bonus: d.value })
                  }
                  // [Issue #3174] Editable whatever the policy says. Disabling it
                  // on `inherit` rows is what welded the bonus to the policy
                  // override: a team could not carry a handicap without also
                  // being taken off the event's policy. Blank means "use the
                  // event's bonus", which the placeholder states.
                  disabled={!canMutateTenant}
                />
              </SpaceBetween>
            );
          })}
        </SpaceBetween>
      )}

      {editor.validationErrorKey && (
        <Box variant="small" color="text-status-error">
          {t(editor.validationErrorKey)}
        </Box>
      )}
      <SpaceBetween direction="horizontal" size="xs">
        <Button
          variant="primary"
          loading={editor.saveInFlight}
          disabled={
            !apiClient ||
            !canMutateTenant ||
            editor.validationErrorKey !== null ||
            editor.saveInFlight
          }
          onClick={() => void editor.save()}
        >
          {t("gate.save_button")}
        </Button>
        {stored && (
          <Button
            loading={editor.removeInFlight}
            disabled={!apiClient || !canMutateTenant || editor.removeInFlight}
            onClick={() => editor.setConfirmRemove(true)}
          >
            {t("gate.remove_button")}
          </Button>
        )}
      </SpaceBetween>

      {editor.confirmRemove && (
        <Modal
          visible
          header={t("gate.modal_remove_header")}
          onDismiss={() => editor.setConfirmRemove(false)}
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button onClick={() => editor.setConfirmRemove(false)}>
                  {t("gate.modal_cancel")}
                </Button>
                <Button
                  variant="primary"
                  loading={editor.removeInFlight}
                  disabled={!canMutateTenant}
                  onClick={() => void editor.remove()}
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
 * (既定 OFF) で切り替える。 有効判定・Toggle の詳細は `useTenantGateFlag` を参照。
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
  const flag = useTenantGateFlag(apiClient, t);

  return (
    <Container
      header={
        <Header variant="h2" description={t("gate.description")}>
          {t("gate.header")}
        </Header>
      }
    >
      <SpaceBetween size="l">
        {flag.flagsError && (
          <Alert type="error" header={t("gate.flags_error_header")}>
            {flag.flagsError}
          </Alert>
        )}
        {flag.toggleError && <Alert type="error">{flag.toggleError}</Alert>}
        {flag.flags === null ? (
          !flag.flagsError && (
            <Box variant="small" color="text-status-inactive">
              {t("gate.loading")}
            </Box>
          )
        ) : (
          <>
            <Toggle
              checked={flag.enabled}
              disabled={!apiClient || flag.toggleInFlight}
              onChange={({ detail: d }) => void flag.toggleFlag(d.checked)}
            >
              {t("gate.feature_toggle_label")}
            </Toggle>
            {flag.enabled ? (
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
