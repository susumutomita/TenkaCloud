import { z } from "zod";

/**
 * Issue #1727 / ADR-039 §7: customer execution plane の SQS メッセージ契約。
 *
 * hosted control plane (または relay) が、 署名済み JWS token と、 その intent が
 * digest で縛る **承認済みテンプレ本文 (base64)** を 1 メッセージに入れて送る。
 * agent が token を検証し、 同梱 bytes の digest が signed digest と一致するときだけ
 * deploy する (= bytes 改ざんは digest 不一致で fail-closed)。
 *
 * テンプレは CFn inline 上限 (51,200 bytes) 内を前提 (= 大きいものは S3 参照に拡張する
 * のが follow-up)。 SQS 本文上限 256KB にも収まる。
 */
export const IntentMessageSchema = z
  .object({
    token: z.string().min(1),
    /** 承認済みテンプレ本文の base64。 decode 後の bytes を agent が digest 照合する。 */
    templateBase64: z.string().min(1),
  })
  .strict();

export interface ParsedIntentMessage {
  readonly token: string;
  readonly templateBytes: Uint8Array;
}

/**
 * SQS body 文字列を parse・検証して token + テンプレ bytes を返す。
 * 不正 JSON / schema 不一致 / base64 不正は throw (= メッセージを処理しない)。
 */
export function parseIntentMessage(rawBody: string): ParsedIntentMessage {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new Error("intent message is not valid JSON");
  }
  const parsed = IntentMessageSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `intent message failed schema validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const templateBytes = decodeBase64(parsed.data.templateBase64);
  return { token: parsed.data.token, templateBytes };
}

function decodeBase64(value: string): Uint8Array {
  // Node の Buffer.from は不正 base64 を黙って切り詰めるので、 round-trip で厳密検証する。
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (Buffer.from(bytes).toString("base64") !== normalizeBase64(value)) {
    throw new Error("templateBase64 is not valid base64");
  }
  return bytes;
}

/** padding 差異を吸収して base64 を比較可能な正規形にする。 */
function normalizeBase64(value: string): string {
  const stripped = value.replace(/=+$/, "");
  const pad = stripped.length % 4 === 0 ? "" : "=".repeat(4 - (stripped.length % 4));
  return stripped + pad;
}
