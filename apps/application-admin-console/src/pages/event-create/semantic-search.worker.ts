import { AutoConfig, AutoModel, AutoTokenizer, env } from "@huggingface/transformers";
import wasmModuleUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import {
  EMBEDDING_MODEL,
  EMBEDDING_REVISION,
  normalizeVector,
  type SemanticCandidate,
  semanticDocument,
} from "./semantic-search";

env.allowLocalModels = false;
// Keep module execution on our origin under CSP; the default cache wraps it in blob:.
env.useWasmCache = false;
if (!env.backends.onnx.wasm) throw new Error("ONNX Web実行環境がありません。");
env.backends.onnx.wasm.wasmPaths = { wasm: wasmUrl, mjs: wasmModuleUrl };
env.backends.onnx.wasm.numThreads = 1;
let model: Awaited<ReturnType<typeof AutoModel.from_pretrained>>;
let tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
async function embed(text: string) {
  const inputs = await tokenizer(text, { truncation: false });
  if ((inputs.input_ids.dims.at(-1) ?? 0) > 2700)
    throw new Error("文章がWebGPUの処理範囲を超えています。検索条件を短くしてください。");
  const output = await model(inputs);
  return normalizeVector(output.sentence_embedding.tolist()[0]);
}
self.onmessage = async (
  event: MessageEvent<{
    request: number;
    action: string;
    candidates?: SemanticCandidate[];
    query?: string;
  }>,
) => {
  const { request, action } = event.data;
  const started = performance.now();
  const send = (kind: string, data: unknown) => self.postMessage({ request, kind, data });
  try {
    if (action === "load") {
      const progress_callback = (progress: unknown) => send("progress", progress);
      const config = await AutoConfig.from_pretrained(EMBEDDING_MODEL, {
        revision: EMBEDDING_REVISION,
      });
      Object.assign(config, { vision_config: null, audio_config: null });
      tokenizer = await AutoTokenizer.from_pretrained(EMBEDDING_MODEL, {
        revision: EMBEDDING_REVISION,
        progress_callback,
      });
      model = await AutoModel.from_pretrained(EMBEDDING_MODEL, {
        config,
        revision: EMBEDDING_REVISION,
        device: "webgpu",
        dtype: "q4",
        progress_callback,
      });
      send("result", { elapsedMs: performance.now() - started });
    } else if (action === "index") {
      const vectors = [];
      const candidates = event.data.candidates ?? [];
      for (const [i, p] of candidates.entries()) {
        vectors.push({ id: p.id, vector: await embed(semanticDocument(p)) });
        send("progress", { status: "index", completed: i + 1, total: candidates.length });
      }
      send("result", { vectors, elapsedMs: performance.now() - started });
    } else if (action === "query") {
      send("result", {
        vector: await embed(`task: search result | query: ${event.data.query}`),
        elapsedMs: performance.now() - started,
      });
    } else throw new Error("未知の検索操作です。");
  } catch (error) {
    send("error", error instanceof Error ? error.message : String(error));
  }
};
