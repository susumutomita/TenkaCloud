/**
 * Issue #607: Endpoint override registration form (ADR-012 Phase 3.A / Phase 5 UI 補完)。
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
import { useEffect, useState } from "react";
import {
  deleteProblemEndpointOverride,
  listProblemEndpoints,
  type ParticipantEndpointView,
  PortalValidationError,
  putProblemEndpointOverride,
} from "../api/portal-client";

interface EndpointOverrideFormProps {
  readonly apiBaseUrl: string;
  readonly teamLoginKey: string;
  readonly problemId: string;
  /** 親 (= ProblemDetail) の problem.stackOutputs から default が組み立てられない時の
   *   shortcut。 endpoints は server-side で defaultUrl も計算済で返ってくるので不要。 */
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
function formatValidationError(err: unknown): string {
  if (err instanceof PortalValidationError) {
    switch (err.errorCode) {
      case "invalid_url":
        return "URL の形式が不正です (http:// または https:// で始まる絶対 URL を指定)。";
      case "slot_not_overridable":
        return "この slot は override 不可です。";
      case "unknown_slot":
        return "この slot は metadata に存在しません。";
      case "no_endpoints":
        return "この問題には endpoint が宣言されていません。";
      default:
        return `エラー: ${err.errorCode}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

export function EndpointOverrideForm({
  apiBaseUrl,
  teamLoginKey,
  problemId,
}: EndpointOverrideFormProps) {
  const [endpoints, setEndpoints] = useState<readonly ParticipantEndpointView[] | undefined>(
    undefined,
  );
  const [listError, setListError] = useState<string | undefined>(undefined);
  const [editState, setEditState] = useState<Record<string, SlotEditState>>({});

  // 初回 + problemId 変更時に endpoints を引く。 (= mount 時 fetch、 polling は外側 view が
  // 別途やっているのでここでは 1 回でよい)
  useEffect(() => {
    let cancelled = false;
    listProblemEndpoints(apiBaseUrl, teamLoginKey, problemId)
      .then((res) => {
        if (cancelled) return;
        setEndpoints(res.endpoints);
        setListError(undefined);
      })
      .catch((err) => {
        if (cancelled) return;
        setListError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, teamLoginKey, problemId]);

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
      patchEditState(slot, { error: "URL を入力してください" });
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
      setEndpoints(res.endpoints);
      patchEditState(slot, { value: "", busy: false, error: undefined });
    } catch (err) {
      patchEditState(slot, { busy: false, error: formatValidationError(err) });
    }
  }

  async function handleDelete(slot: string): Promise<void> {
    patchEditState(slot, { busy: true, error: undefined });
    try {
      const res = await deleteProblemEndpointOverride(apiBaseUrl, teamLoginKey, problemId, slot);
      setEndpoints(res.endpoints);
      patchEditState(slot, EMPTY_SLOT_STATE);
    } catch (err) {
      patchEditState(slot, { busy: false, error: formatValidationError(err) });
    }
  }

  // 該当 problem に endpoint がない (= flag-only / no-endpoints kind) なら section ごと skip。
  if (listError === "no_endpoints") return null;
  if (endpoints && endpoints.length === 0) return null;

  return (
    <Container
      header={
        <Header
          variant="h2"
          description="自チームの service URL を Lambda / ECS / App Runner 等の再ホスト先に切り替えるとスコア engine がその URL を probe します。 URL は https:// または http:// の絶対 URL で。"
        >
          Endpoint 登録
        </Header>
      }
    >
      {listError !== undefined && listError !== "no_endpoints" && (
        <Alert type="error" header="Endpoint 一覧の取得に失敗しました">
          {listError}
        </Alert>
      )}
      {!endpoints && listError === undefined && <Box>読み込み中…</Box>}
      {endpoints && endpoints.length > 0 && (
        <SpaceBetween size="m">
          {endpoints.map((ep) => {
            const state = editState[ep.slot] ?? EMPTY_SLOT_STATE;
            const effective = ep.effectiveUrl ?? "—";
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
                  <Box variant="awsui-key-label">Effective URL</Box>
                  <Box variant="code">{effective}</Box>
                  {ep.overrideUrl && (
                    <Box variant="small" color="text-status-info">
                      override 中 (default: <code>{ep.defaultUrl ?? "—"}</code>)
                    </Box>
                  )}
                  {ep.overridable ? (
                    <FormField
                      label="新しい URL を登録"
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
                          登録
                        </Button>
                        {ep.overrideUrl && (
                          <Button
                            variant="normal"
                            onClick={() => handleDelete(ep.slot)}
                            disabled={state.busy}
                          >
                            override 解除
                          </Button>
                        )}
                      </SpaceBetween>
                    </FormField>
                  ) : (
                    <Box variant="small" color="text-status-inactive">
                      この slot は override 不可 (固定 default URL)
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
