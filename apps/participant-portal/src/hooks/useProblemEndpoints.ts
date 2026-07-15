import type { PortalEndpoint } from "@tenkacloud/portal-plugin-sdk";
import { toErrorMessage } from "@tenkacloud/web-kit";
import { useCallback, useEffect, useMemo, useState } from "react";
import { listProblemEndpoints, type ParticipantEndpointView } from "../api/portal-client";
import { buildPortalEndpointsFromServer } from "../plugins/props-builder";

export interface ProblemEndpointsState {
  /** server が override をマージ済の 1 problem の slot 一覧。未 fetch は undefined。 */
  readonly endpoints: readonly ParticipantEndpointView[] | undefined;
  /** list fetch 失敗時のメッセージ (`no_endpoints` は endpoint 未宣言 problem の正常系)。 */
  readonly listError: string | undefined;
  /** {@link endpoints} を plugin SDK 形へ marshal したもの。PortalPluginSlots にそのまま渡す。 */
  readonly portalEndpoints: readonly PortalEndpoint[] | undefined;
  /** override の POST / DELETE 後、 server 返却の endpoints で置き換える (両カードへ即時反映)。 */
  readonly replaceEndpoints: (next: readonly ParticipantEndpointView[]) => void;
}

/**
 * [Issue #2661] 1 problem の endpoint 一覧を **単一 source** として ProblemDetail が保持するための
 * hook。 server (`listProblemEndpoints`) は default URL + override URL + effective URL を集約して
 * 返すため、 この値を EndpointOverrideForm と PortalPluginSlots の双方へ同じ instance で配れば、
 * 「Endpoint 登録」 カードと問題側 plugin が同じ「自チームの service URL」 について矛盾しないことが
 * 構造的に保証される (以前は plugin が CFn stackOutputs だけを見ており、 default URL が空の
 * override 前提問題では override が反映されず「未登録」が固定していた)。
 *
 * `enabled` が false、 または problemId / teamLoginKey が無いときは fetch しない (= endpoint を
 * 宣言していない flag-only 問題へ無駄な GET を出さない)。 mount / problemId 変更で 1 回引き、
 * 以後の更新は `replaceEndpoints` (= override 操作の response) 経由で行う (polling は外側 view)。
 */
export function useProblemEndpoints(
  apiBaseUrl: string,
  teamLoginKey: string,
  problemId: string | undefined,
  enabled: boolean,
): ProblemEndpointsState {
  const [endpoints, setEndpoints] = useState<readonly ParticipantEndpointView[] | undefined>(
    undefined,
  );
  const [listError, setListError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!enabled || !problemId || teamLoginKey.length === 0) return;
    let cancelled = false;
    listProblemEndpoints(apiBaseUrl, teamLoginKey, problemId)
      .then((res) => {
        if (cancelled) return;
        setEndpoints(res.endpoints);
        setListError(undefined);
      })
      .catch((err) => {
        if (cancelled) return;
        setListError(toErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, teamLoginKey, problemId, enabled]);

  const replaceEndpoints = useCallback((next: readonly ParticipantEndpointView[]) => {
    setEndpoints(next);
    setListError(undefined);
  }, []);

  const portalEndpoints = useMemo(
    () => (endpoints ? buildPortalEndpointsFromServer(endpoints) : undefined),
    [endpoints],
  );

  return { endpoints, listError, portalEndpoints, replaceEndpoints };
}
