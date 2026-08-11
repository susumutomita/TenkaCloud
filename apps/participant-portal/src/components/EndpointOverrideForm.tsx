/**
 * Issue #607: Endpoint override registration form。
 *
 * 1 Battle 問題の `endpoints[]` のうち `overridable: true` な slot に対して、 競技者が
 * 自前の URL (Lambda / ECS / App Runner 等の再ホスト先) を登録 / 解除する form。 PROblem
 * Panel と並べて render することを想定 (= ProblemDetail で metadata.endpoints が空でない時のみ表示)。
 *
 * 設計判断:
 *   - 共通 component (= microservice-migration 専用ではない)。 endpoints[].overridable で gating
 *     することで、 hello-world-battle のような single fixed endpoint problem では行が出ない。
 *   - 登録 form は per-slot に展開 (= 全 slot 並行で見える、 status panel と一体)。
 *   - 400 / 409 は PortalValidationError → inline error。 409 = "slot_not_overridable" や
 *     "invalid_url" など。 portal 側 SSRF 防御は backend に閉じる。
 *   - 楽観的更新はしない (= POST 後の response で endpoints を置き換え)。
 */

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { toErrorMessage } from "@tenkacloud/web-kit";
import { useState } from "react";
import {
  deleteProblemEndpointOverride,
  type ParticipantEndpointView,
  PortalValidationError,
  putProblemEndpointOverride,
} from "../api/portal-client";
import { useT } from "../i18n";

interface EndpointOverrideFormProps {
  readonly apiBaseUrl: string;
  readonly teamLoginKey: string;
  readonly problemId: string;
  /** ProblemDetail が取得した server-side の集約 view。undefined は loading。 */
  readonly endpoints: readonly ParticipantEndpointView[] | undefined;
  readonly listError: string | undefined;
  readonly onEndpointsChange: (endpoints: readonly ParticipantEndpointView[]) => void;
}

interface SlotEditState {
  readonly value: string;
  readonly busy: boolean;
  readonly error?: string;
}

const EMPTY_SLOT_STATE: SlotEditState = { value: "", busy: false };

/**
 * portal API の error code (= "invalid_url" / "slot_not_overridable" / "no_endpoints" 等) を
 * 競技者向け日本語に変換。 未知の code は raw code を表示 (= ops が grep しやすい)。
 */
type TFn = (key: string, params?: Readonly<Record<string, string | number>>) => string;

function formatValidationError(err: unknown, t: TFn): string {
  if (err instanceof PortalValidationError) {
    switch (err.errorCode) {
      case "invalid_url":
        return t("problem_detail.endpoint_error_invalid_url");
      case "slot_not_overridable":
        return t("problem_detail.endpoint_error_slot_not_overridable");
      case "unknown_slot":
        return t("problem_detail.endpoint_error_unknown_slot");
      case "no_endpoints":
        return t("problem_detail.endpoint_error_no_endpoints");
      // Issue #2283: Progression Gate。 locked 問題への endpoint 登録 / 更新 / 削除は
      // backend が 409 challenge_prerequisite_not_met で拒否する (UI は通常 lock 表示で
      // 到達しない — defense-in-depth)。
      case "challenge_prerequisite_not_met":
        return t("problem_detail.endpoint_error_prerequisite_locked");
      default:
        return t("problem_detail.endpoint_error_generic", { errorCode: err.errorCode });
    }
  }
  return toErrorMessage(err);
}

export function EndpointOverrideForm({
  apiBaseUrl,
  teamLoginKey,
  problemId,
  endpoints,
  listError,
  onEndpointsChange,
}: EndpointOverrideFormProps) {
  const t = useT();
  const [editState, setEditState] = useState<Record<string, SlotEditState>>({});

  function patchEditState(slot: string, patch: Partial<SlotEditState>): void {
    setEditState((prev) => ({
      ...prev,
      [slot]: { ...(prev[slot] ?? EMPTY_SLOT_STATE), ...patch },
    }));
  }

  async function handleSave(slot: string): Promise<void> {
    const current = editState[slot] ?? EMPTY_SLOT_STATE;
    const trimmed = current.value.trim();
    if (trimmed.length === 0) {
      patchEditState(slot, { error: t("problem_detail.endpoint_override_url_empty") });
      return;
    }
    patchEditState(slot, { busy: true, error: undefined });
    try {
      const res = await putProblemEndpointOverride(
        apiBaseUrl,
        teamLoginKey,
        problemId,
        slot,
        trimmed,
      );
      onEndpointsChange(res.endpoints);
      patchEditState(slot, { value: "", busy: false, error: undefined });
    } catch (err) {
      patchEditState(slot, { busy: false, error: formatValidationError(err, t) });
    }
  }

  async function handleDelete(slot: string): Promise<void> {
    patchEditState(slot, { busy: true, error: undefined });
    try {
      const res = await deleteProblemEndpointOverride(apiBaseUrl, teamLoginKey, problemId, slot);
      onEndpointsChange(res.endpoints);
      patchEditState(slot, EMPTY_SLOT_STATE);
    } catch (err) {
      patchEditState(slot, { busy: false, error: formatValidationError(err, t) });
    }
  }

  // 該当 problem に endpoint がない (= flag-only / no-endpoints kind) なら section ごと skip。
  if (listError === "no_endpoints") return null;
  if (endpoints && endpoints.length === 0) return null;

  return (
    <Container
      header={
        <Header variant="h2" description={t("problem_detail.endpoint_description")}>
          {t("problem_detail.endpoint_header")}
        </Header>
      }
    >
      {listError !== undefined && listError !== "no_endpoints" && (
        <Alert type="error" header={t("problem_detail.endpoint_list_failed_header")}>
          {listError}
        </Alert>
      )}
      {!endpoints && listError === undefined && <Box>{t("problem_detail.endpoint_loading")}</Box>}
      {endpoints && endpoints.length > 0 && (
        <SpaceBetween size="m">
          {endpoints.map((ep) => {
            const state = editState[ep.slot] ?? EMPTY_SLOT_STATE;
            return (
              <Container
                key={ep.slot}
                header={
                  <Header variant="h3" description={ep.description ?? undefined}>
                    {ep.label ?? ep.slot}
                  </Header>
                }
              >
                <SpaceBetween size="s">
                  <Box variant="awsui-key-label">
                    {t("problem_detail.endpoint_effective_label")}
                  </Box>
                  {ep.effectiveUrl ? (
                    <Box variant="code">{ep.effectiveUrl}</Box>
                  ) : (
                    <Box variant="small" color="text-status-info">
                      {t("problem_detail.endpoint_not_yet_pre")} <code>{ep.defaultKey}</code>{" "}
                      {t("problem_detail.endpoint_not_yet_post")}
                    </Box>
                  )}
                  {ep.overrideUrl && (
                    <Box variant="small" color="text-status-info">
                      {t("problem_detail.endpoint_override_active_label")}{" "}
                      <code>{ep.defaultUrl ?? "—"}</code>)
                    </Box>
                  )}
                  {ep.overridable ? (
                    <FormField
                      label={t("problem_detail.endpoint_override_input_label")}
                      {...(state.error ? { errorText: state.error } : {})}
                    >
                      <SpaceBetween direction="horizontal" size="xs">
                        <Input
                          value={state.value}
                          onChange={(e) => patchEditState(ep.slot, { value: e.detail.value })}
                          placeholder="https://example.com/api"
                          disabled={state.busy}
                        />
                        <Button
                          variant="primary"
                          onClick={() => handleSave(ep.slot)}
                          loading={state.busy}
                        >
                          {t("problem_detail.endpoint_override_submit")}
                        </Button>
                        {ep.overrideUrl && (
                          <Button
                            variant="normal"
                            onClick={() => handleDelete(ep.slot)}
                            disabled={state.busy}
                          >
                            {t("problem_detail.endpoint_override_clear")}
                          </Button>
                        )}
                      </SpaceBetween>
                    </FormField>
                  ) : (
                    <Box variant="small" color="text-status-inactive">
                      {t("problem_detail.endpoint_not_overridable")}
                    </Box>
                  )}
                </SpaceBetween>
              </Container>
            );
          })}
        </SpaceBetween>
      )}
    </Container>
  );
}
