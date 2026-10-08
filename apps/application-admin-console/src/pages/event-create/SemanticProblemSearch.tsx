import { ScrollableProblemList } from "./ScrollableProblemList";
import "./SemanticProblemSearch.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProblemSummary } from "../../data/problems";
import { useI18n } from "../../i18n";
import type { HostCatalog } from "./LocalHostEventCreate";
import { advisorCatalog } from "./problem-advisor";
import { EMBEDDING_MODEL, rankSemantic } from "./semantic-search";

function searchErrorLabel(error: string) {
  if (error.includes("3分"))
    return "検索が3分を超えたため停止しました。もう一度準備するか、下の一覧から問題を選べます。";
  return "検索を続けられません。もう一度準備するか、下の一覧から問題を選べます。";
}
function requireCatalog(catalog: HostCatalog) {
  if (catalog.loading || catalog.error)
    throw new Error("開催カタログを取得できていません。通常の選択で確認してください。");
}
interface WorkerResult {
  elapsedMs: number;
  vectors?: { id: string; vector: number[] }[];
  vector?: number[];
}
function progressText(p: {
  status: string;
  completed?: number;
  total?: number;
  file?: string;
  progress?: number;
}) {
  if (p.status === "index") return `問題の情報を準備しています ${p.completed}/${p.total}`;
  if (p.progress) return `検索用データを取得しています（${Math.round(p.progress)}%）`;
  return "検索を準備しています…";
}
interface Props {
  problems: readonly ProblemSummary[];
  catalog: HostCatalog;
  onCandidates: (ids: readonly string[] | null) => void;
}
export function SemanticProblemSearch({ problems, catalog, onCandidates }: Props) {
  const { locale } = useI18n();
  const candidates = useMemo(
    () => advisorCatalog(problems, catalog, locale),
    [problems, catalog, locale],
  );
  const scope = JSON.stringify(candidates);
  const activeScope = useRef(scope);
  const worker = useRef<Worker | null>(null);
  const pending = useRef<{
    resolve: (data: WorkerResult) => void;
    reject: (error: Error) => void;
  } | null>(null);
  const serial = useRef(0);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [vectors, setVectors] = useState<{ id: string; vector: number[] }[]>([]);
  const [results, setResults] = useState<{ id: string; score: number }[]>([]);
  const composing = useRef(false);
  const cancel = () => {
    serial.current++;
    worker.current?.terminate();
    worker.current = null;
    pending.current?.reject(new Error("停止しました。キャッシュを使って再開できます。"));
    pending.current = null;
    setReady(false);
    setBusy(false);
    setVectors([]);
    setResults([]);
    onCandidates(null);
    setStatus("検索を終了しました。下の一覧からも問題を選べます。");
  };
  useEffect(
    () => () => {
      serial.current++;
      worker.current?.terminate();
      pending.current?.reject(new Error("検索を終了しました。"));
    },
    [],
  );
  useEffect(() => {
    if (activeScope.current === scope) return;
    activeScope.current = scope;
    if (pending.current) {
      serial.current++;
      worker.current?.terminate();
      worker.current = null;
      pending.current.reject(new Error("検索範囲が変わりました。再開してください。"));
      pending.current = null;
      setReady(false);
      setBusy(false);
    }
    setResults([]);
    onCandidates(null);
    setVectors([]);
  }, [scope, onCandidates]);
  const call = (action: string, extra: object = {}) =>
    new Promise<WorkerResult>((resolve, reject) => {
      if (!worker.current) {
        reject(new Error("検索モデルを再開してください。"));
        return;
      }
      const timer = setTimeout(() => {
        serial.current++;
        worker.current?.terminate();
        worker.current = null;
        pending.current = null;
        setBusy(false);
        setReady(false);
        setError("処理が3分を超えたため停止しました。通常選択、または再開を使ってください。");
        reject(new Error("検索をタイムアウトで停止しました。"));
      }, 180000);
      pending.current = {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      worker.current.postMessage({ request: serial.current, action, ...extra });
    });
  const metrics = (stage: string, data: object) =>
    window.dispatchEvent(
      new CustomEvent("tenkacloud-embedding-metrics", {
        detail: { stage, model: EMBEDDING_MODEL, dtype: "q4", ...data },
      }),
    );
  const receive = ({ data }: MessageEvent) => {
    if (data.request !== serial.current) return;
    if (data.kind === "progress") {
      const p = data.data;
      setStatus(progressText(p));
      if (p.status === "done")
        metrics("download-file", { file: p.file, loaded: p.loaded, total: p.total });
      return;
    }
    const promise = pending.current;
    pending.current = null;
    if (!promise) return;
    if (data.kind === "error") promise.reject(new Error(data.data));
    else promise.resolve(data.data);
  };
  const load = async () => {
    setError("");
    setBusy(true);
    setStatus("検索に必要なデータを取得しています…");
    const run = ++serial.current;
    worker.current = new Worker(new URL("./semantic-search.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current.onmessage = receive;
    worker.current.onerror = () => {
      const promise = pending.current;
      pending.current = null;
      promise?.reject(new Error("モデルを実行できません。通常の選択を使ってください。"));
    };
    try {
      const data = await call("load");
      if (run !== serial.current) return;
      metrics("load", data);
      setReady(true);
      setStatus("検索できます。目的や学びたいことを入力してください。");
    } catch (e) {
      if (run === serial.current) {
        setError(String(e));
        worker.current?.terminate();
        worker.current = null;
      }
    } finally {
      if (run === serial.current) setBusy(false);
    }
  };
  const ensureIndex = async () => {
    if (vectors.length) return vectors;
    const data = await call("index", { candidates });
    if (!data.vectors) throw new Error("索引を受け取れませんでした。");
    metrics("index", { count: data.vectors.length, elapsedMs: data.elapsedMs });
    setVectors(data.vectors);
    return data.vectors;
  };
  const search = async () => {
    if (!query.trim() || busy || !ready) return;
    const run = serial.current;
    setBusy(true);
    setError("");
    setResults([]);
    onCandidates(null);
    try {
      requireCatalog(catalog);
      const indexed = await ensureIndex();
      setStatus("目的に近い候補を検索しています…");
      const data = await call("query", { query });
      if (run !== serial.current) return;
      metrics("query", { elapsedMs: data.elapsedMs, candidateCount: candidates.length });
      if (!data.vector) throw new Error("検索ベクトルを受け取れませんでした。");
      const ranked = rankSemantic(data.vector, indexed, new Set(candidates.map((p) => p.id)));
      setResults(ranked);
      onCandidates(ranked.map((p) => p.id));
      setStatus(
        "下の問題一覧を候補に絞りました。内容を確認して、一覧のチェック欄から選んでください。",
      );
    } catch (e) {
      if (run === serial.current) setError(String(e));
    } finally {
      if (run === serial.current) setBusy(false);
    }
  };
  return (
    <section className="semantic-assistant" aria-label="目的から問題を探す">
      <h3>目的から問題を探す</h3>
      <p>
        学びたいことや練習したい場面を文章で入力すると、既存の問題から候補を見つけます。
        現在のフィルターと開催対応に合う{candidates.length}件が対象です。
      </p>
      {!ready && (
        <p>
          初回の準備では約207MBの検索データを取得します。実行に必要なファイルを含め合計約235MBです。
          データはこのブラウザに保存され、端末のメモリや処理能力を使います。
          入力した目的や教材を外部に送らず、この端末内で検索します。準備せず下の一覧から選ぶこともできます。
        </p>
      )}
      <p>候補の内容と難易度・所要時間・実行環境を確認して選んでください。</p>
      <details>
        <summary>検索の仕組みと保存データ</summary>
        <p>
          EmbeddingGemma 2のテキスト専用q4モデル（約175MB）をTransformers.jsとWebGPUで実行します。
          Hugging Faceからモデルとtokenizerを取得し、ブラウザに保存します。
          タイトル・公開概要・学習目標だけを処理し、回答や非公開教材は検索に使いません。
          内容の近さから候補を探すため、条件に合わない問題や無関係な問題が表示される場合があります。
          会話や新しい問題の生成は行いません。
          <a href="https://huggingface.co/onnx-community/embeddinggemma-2-ONNX">
            モデルとApache 2.0ライセンス
          </a>
        </p>
        <button
          type="button"
          disabled={busy || ready}
          onClick={async () => {
            for (const name of await caches.keys()) {
              if (name !== "transformers-cache") continue;
              const cache = await caches.open(name);
              for (const request of await cache.keys())
                if (request.url.includes(EMBEDDING_MODEL)) await cache.delete(request);
            }
            setStatus("検索用の保存データを削除しました。");
          }}
        >
          検索用の保存データを削除
        </button>
      </details>
      {!("gpu" in navigator) ? (
        <p>このブラウザでは目的からの検索を使えません。下の一覧から問題を選べます。</p>
      ) : (
        !ready && (
          <button
            type="button"
            disabled={busy || catalog.loading || !!catalog.error}
            onClick={load}
          >
            検索を準備する
          </button>
        )
      )}
      {(ready || busy) && (
        <button type="button" onClick={cancel}>
          検索を終了する
        </button>
      )}
      {ready && (
        <>
          <label>
            学びたいこと
            <textarea
              aria-label="学びたいこと"
              value={query}
              disabled={busy}
              maxLength={2000}
              onChange={(e) => setQuery(e.target.value)}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  !composing.current &&
                  e.keyCode !== 229
                ) {
                  e.preventDefault();
                  void search();
                }
              }}
            />
          </label>
          <button
            type="button"
            disabled={busy || !query.trim() || !candidates.length}
            onClick={search}
          >
            候補を探す
          </button>
        </>
      )}
      <p role="status">{status}</p>
      {error && (
        <div role="alert">
          <p>{searchErrorLabel(error)}</p>
          <details>
            <summary>詳しい理由</summary>
            <p>{error}</p>
          </details>
        </div>
      )}
      {results.length > 0 && (
        <ScrollableProblemList label="問題の候補">
          <ol aria-label="問題の候補">
            {results.map((r) => {
              const p = candidates.find((p) => p.id === r.id);
              return (
                p && (
                  <li key={r.id}>
                    <strong>{p.name}</strong>
                    <p>
                      難易度 {p.difficulty} / {p.duration} / {p.runtime.join(", ")}
                    </p>
                    <p>{p.summary}</p>
                    <p>学習目標: {p.goals.join(" / ")}</p>
                    <details>
                      <summary>検索の詳細</summary>
                      <p>
                        内容の近さ: {r.score.toFixed(3)}。正解の確率や条件への適合率ではありません。
                      </p>
                    </details>
                  </li>
                )
              );
            })}
          </ol>
        </ScrollableProblemList>
      )}
      {results.length > 0 && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setResults([]);
            onCandidates(null);
            setStatus("目的による絞り込みを解除しました。");
          }}
        >
          目的による絞り込みを解除
        </button>
      )}
    </section>
  );
}
