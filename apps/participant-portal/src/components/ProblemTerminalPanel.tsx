import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  issueProblemTerminalHandoff,
  PortalValidationError,
  problemTerminalUrl,
} from "../api/portal-client";
import { useT } from "../i18n";
import { formatProblemPanelActionError, type ProblemPanelT } from "./ProblemPanel.helpers";

/**
 * [#2846] local-play container terminal UI。 `ProblemPanel` から `lifecycle.runtimeKind ===
 * "docker"` かつ running の問題にだけ差し込まれる。 TTY 無しの `/bin/sh` に繋ぐだけなので、
 * xterm.js のような pty emulator は不要 — 素の `<pre>` scrollback + 1 行 `<Input>` で足りる
 * (行編集もプロンプトも無い、 1 行送って出力を待つだけの console)。
 *
 * WebSocket 自体は ADR-014 (frontend polling-only) の例外。 同 ADR の Frontend row は AWS 向け
 * request-scoped Lambda を前提にしており、 local-play backend は単一長期プロセスなので
 * 「connection registry も fan-out cost も要らない」 という ADR の反対理由がそもそも
 * 成立しない (`scripts/local-play/problem-terminal.ts` 参照)。 AWS mode はこの endpoint 自体を
 * 持たない (`runtimeKind` が "docker" になるのは local-play だけ) ので、 この component が
 * ADR-014 の対象範囲外であることは呼び出し条件そのものが保証する。
 */

const MAX_SCROLLBACK_LINES = 500;

const SCROLLBACK_STYLE: CSSProperties = {
  margin: 0,
  padding: "8px 10px",
  maxHeight: 280,
  overflowY: "auto",
  overflowX: "hidden",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  fontSize: 12,
  lineHeight: 1.4,
  border: "1px solid #d5dbdb",
  borderRadius: 4,
};

interface ExitInfo {
  readonly code: number | null;
  readonly reason?: string;
}

/**
 * `exited` は必ず `exitInfo` を伴う discriminated union にする — 別 state atom (`phase` +
 * `exitInfo | null`) だと「phase は exited だが exitInfo が無い」という到達しないはずの
 * 組み合わせを型が許してしまい、 render 側に確認しようのない防御分岐が生まれる。
 */
type TerminalState =
  | { readonly phase: "idle" }
  | { readonly phase: "connecting" }
  | { readonly phase: "connected" }
  | { readonly phase: "exited"; readonly exitInfo: ExitInfo };

type InboundFrame =
  | { readonly type: "data"; readonly data: string }
  | { readonly type: "exit"; readonly code: number | null; readonly reason?: string };

/**
 * scrollback は先頭から `MAX_SCROLLBACK_LINES` 行だけ保持する (= 無限に伸びる DOM を防ぐ)。
 * chunk は改行区切りとは限らない (TTY 無しの生 stdout/stderr merge) ため、 行数判定は
 * 結合後にまとめて split する。
 */
function appendScrollback(current: string, chunk: string): string {
  const combined = current + chunk;
  const lines = combined.split("\n");
  if (lines.length <= MAX_SCROLLBACK_LINES) return combined;
  return lines.slice(lines.length - MAX_SCROLLBACK_LINES).join("\n");
}

/**
 * 受信フレーム (JSON text) を parse する。 contract 違反 (壊れた JSON / 未知の shape /
 * 未知の `type`) は client を落とさず黙って無視する — backend は同一 origin の local-play
 * 自前実装で、 起こり得るとすれば bug であって参加者に見せるべき「失敗」ではないため。
 */
function parseInboundFrame(raw: string): InboundFrame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (obj.type === "data" && typeof obj.data === "string") {
    return { type: "data", data: obj.data };
  }
  if (obj.type === "exit") {
    const code = typeof obj.code === "number" ? obj.code : null;
    return typeof obj.reason === "string"
      ? { type: "exit", code, reason: obj.reason }
      : { type: "exit", code };
  }
  return undefined;
}

/**
 * Issue #2846: handoff の 409 (`not_running`) だけ「起動してから接続してください」の専用
 * 文言にする。 他の error (404 unknown_problem / network) は既存の formatProblemPanelActionError
 * 経路に委譲し、 raw message をそのまま出す (= 隠さない)。 `ProblemPanelFlagSubmission.
 * formatRevealError` と同じ call-site special-case の流儀。
 */
function formatHandoffError(t: ProblemPanelT, err: unknown): string {
  if (err instanceof PortalValidationError && err.errorCode === "not_running") {
    return t("problem_panel.terminal_not_running_error");
  }
  return formatProblemPanelActionError(t, err, "problem_panel.validation_error");
}

/** handler を先に外してから close する — close 後に飛んでくる遅延 close/message で state を
 *  二重更新しない (= 呼び出し側は close 前後の順序を気にせず何度呼んでも安全)。 */
function detachSocket(ws: WebSocket | null): void {
  if (!ws) return;
  ws.onopen = null;
  ws.onmessage = null;
  ws.onclose = null;
  ws.onerror = null;
  ws.close();
}

function TerminalExitNotice({
  t,
  exitInfo,
  onReconnect,
}: {
  t: ProblemPanelT;
  exitInfo: ExitInfo;
  onReconnect: () => void;
}) {
  return (
    <Alert
      type="warning"
      header={
        exitInfo.code !== null
          ? t("problem_panel.terminal_exited_with_code", { code: exitInfo.code })
          : t("problem_panel.terminal_exited_no_code")
      }
    >
      <SpaceBetween size="xs">
        {exitInfo.reason && <Box variant="code">{exitInfo.reason}</Box>}
        <Button onClick={onReconnect}>{t("problem_panel.terminal_reconnect_button")}</Button>
      </SpaceBetween>
    </Alert>
  );
}

/**
 * `<form onSubmit>` を敢えて使わない: Cloudscape `Button` は `formAction` 既定値が
 * `"submit"` で、 同じ form に並ぶ Disconnect button まで type=submit になって Enter 抜きの
 * click でも意図せず送信を誘発する (2 button を同一 form に置く時点で罠になる)。
 * `EndpointOverrideForm` と同じ「form 無し + 各 Button に個別 onClick」の流儀に合わせ、
 * Enter 送信は Input の `onKeyDown` で明示的に拾う (IME 変換確定の Enter は
 * `isComposing` で除外)。
 */
function TerminalInputRow({
  t,
  inputValue,
  onInputChange,
  onSend,
  onDisconnect,
}: {
  t: ProblemPanelT;
  inputValue: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onDisconnect: () => void;
}) {
  return (
    <SpaceBetween direction="horizontal" size="xs" alignItems="center">
      <Input
        value={inputValue}
        onChange={(e) => onInputChange(e.detail.value)}
        onKeyDown={(e) => {
          if (e.detail.key === "Enter" && !e.detail.isComposing) onSend();
        }}
        placeholder={t("problem_panel.terminal_input_placeholder")}
        ariaLabel={t("problem_panel.terminal_input_placeholder")}
      />
      <Button onClick={onSend}>{t("problem_panel.terminal_send_button")}</Button>
      <Button onClick={onDisconnect}>{t("problem_panel.terminal_disconnect_button")}</Button>
    </SpaceBetween>
  );
}

export function ProblemTerminalPanel({
  apiBaseUrl,
  sessionToken,
  problemId,
}: {
  apiBaseUrl: string;
  sessionToken: string;
  problemId: string;
}) {
  const t = useT();
  const [state, setState] = useState<TerminalState>({ phase: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [scrollback, setScrollback] = useState("");
  const [inputValue, setInputValue] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  // handoff (fetch) は接続クリック後に unmount されても resolve/reject し得る — その時点で
  // WebSocket を新規に作ってしまうと unmount 後の接続が生き残る (= leak)。 in-flight な
  // handoff の後続処理を打ち切るための guard。
  const disposedRef = useRef(false);
  const scrollRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    // mount のたびに落とし直す。 StrictMode (dev) は mount → cleanup → mount と二度走るので、
    // 捨てられる 1 回目の cleanup が立てた `true` を本番の mount へ持ち越すと、 handoff が
    // 200 で返った直後の guard で必ず抜けて `connecting` のまま固まる。
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      detachSocket(wsRef.current);
      wsRef.current = null;
    };
  }, []);

  // 新しい出力が届くたびに一番下までスクロールする (= 実端末と同じ「最新行が見える」挙動)。
  // body は scrollback を読まず DOM 側の scrollHeight を読むが、 scrollback 変化での
  // 再実行が目的 (= useDeploymentDetail.ts の「tick 変化で re-run したいだけ」と同じ流儀)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrollback は trigger 専用
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [scrollback]);

  const handleExit = useCallback((code: number | null, reason?: string) => {
    detachSocket(wsRef.current);
    wsRef.current = null;
    setState({ phase: "exited", exitInfo: reason !== undefined ? { code, reason } : { code } });
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    setState({ phase: "connecting" });
    try {
      const ticket = await issueProblemTerminalHandoff(apiBaseUrl, sessionToken, problemId);
      if (disposedRef.current) return;
      const ws = new WebSocket(problemTerminalUrl(apiBaseUrl, problemId, ticket));
      wsRef.current = ws;
      // 一度も open しないまま届く close は handshake 失敗 (ticket 拒否、 upgrade を素通し
      // しない proxy 越し等 — Codespaces の `/__tenkacloud-local-api` bridge がまさにこれ)。
      // シェルの exit とは意味が違うので同じ「終了しました」には倒さず、 接続失敗として
      // idle + error alert に戻す。 open 後の close (= exit フレームの後始末、 server 都合の
      // 切断) だけ従来通り handleExit に倒す。
      let opened = false;
      ws.onopen = () => {
        opened = true;
        setState({ phase: "connected" });
      };
      ws.onmessage = (event) => {
        const frame = parseInboundFrame(String(event.data));
        if (!frame) return;
        if (frame.type === "data") {
          setScrollback((prev) => appendScrollback(prev, frame.data));
          return;
        }
        handleExit(frame.code, frame.reason);
      };
      ws.onclose = () => {
        if (opened) {
          // exit の理由 code はここでは無い (WS close code はプロセス終了コードと別の
          // 名前空間なので流用しない)。
          handleExit(null);
          return;
        }
        wsRef.current = null;
        setState({ phase: "idle" });
        setError(t("problem_panel.terminal_connect_failed_error"));
      };
    } catch (err) {
      if (disposedRef.current) return;
      wsRef.current = null;
      setState({ phase: "idle" });
      setError(formatHandoffError(t, err));
    }
  }, [apiBaseUrl, sessionToken, problemId, t, handleExit]);

  const disconnect = useCallback(() => {
    detachSocket(wsRef.current);
    wsRef.current = null;
    setState({ phase: "idle" });
  }, []);

  const sendLine = useCallback(() => {
    const ws = wsRef.current;
    // Send は phase === "connected" のときだけ描画される (= wsRef は ws.onopen で必ず
    // 埋まっている)。 再入不能な防御分岐 (HintsPanel.handleReveal と同じ流儀)。
    /* v8 ignore next */
    if (!ws) return;
    ws.send(JSON.stringify({ type: "input", data: `${inputValue}\n` }));
    setScrollback((prev) => appendScrollback(prev, `${inputValue}\n`));
    setInputValue("");
  }, [inputValue]);

  return (
    <Container header={<Header variant="h3">{t("problem_panel.terminal_header")}</Header>}>
      <SpaceBetween size="s">
        {error && (
          <Alert type="error" header={t("problem_panel.terminal_error_header")}>
            {error}
          </Alert>
        )}
        {state.phase === "idle" && (
          <Button variant="primary" onClick={() => void connect()}>
            {t("problem_panel.terminal_connect_button")}
          </Button>
        )}
        {state.phase !== "idle" && (
          <SpaceBetween size="s">
            <pre ref={scrollRef} style={SCROLLBACK_STYLE}>
              {scrollback}
            </pre>
            {state.phase === "connecting" && (
              <StatusIndicator type="loading">
                {t("problem_panel.terminal_connecting")}
              </StatusIndicator>
            )}
            {state.phase === "connected" && (
              <TerminalInputRow
                t={t}
                inputValue={inputValue}
                onInputChange={setInputValue}
                onSend={sendLine}
                onDisconnect={disconnect}
              />
            )}
            {state.phase === "exited" && (
              <TerminalExitNotice
                t={t}
                exitInfo={state.exitInfo}
                onReconnect={() => void connect()}
              />
            )}
          </SpaceBetween>
        )}
      </SpaceBetween>
    </Container>
  );
}
