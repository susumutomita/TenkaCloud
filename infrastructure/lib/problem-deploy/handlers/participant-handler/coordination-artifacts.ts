import type {
  CoordinationArtifactFetch,
  CoordinationArtifactStore,
} from "../../control-data/coordination-artifact-store.js";
import {
  COORDINATION_ARTIFACT_MAX_BYTES,
  COORDINATION_ARTIFACT_MAX_PER_OP,
  COORDINATION_ARTIFACT_OP_KEY,
  type CoordinationArtifactRef,
  collectProjectedArtifactIds,
} from "../../control-data/domain/coordination-artifact.js";
import type { CoordinationStateScope } from "../../control-data/domain/coordination-scope.js";

/**
 * [Issue #3152] Getting artifact bodies into the store and out of it, without
 * the plugin ever performing I/O.
 *
 * ## Why the platform stores the body, not the plugin
 *
 * `applyOp` is a pure function of `(state, teamId, op)` and every hook in the
 * SDK is documented as side-effect free. That is not incidental — it is what
 * lets the platform run untrusted problem code with minimal IAM, replay it, and
 * reason about optimistic locking at all. Handing plugins a storage handle
 * would end all three.
 *
 * So the split is: a submission carries its bodies alongside the operation, the
 * platform stores them BEFORE dispatch, and the plugin's `applyOp` receives the
 * operation with references substituted in at a reserved key. The plugin puts
 * those references in its state and its projection; it never sees or writes
 * bytes.
 *
 * ## Why fetching is authorized by the projection
 *
 * The plugin already decides what each team is allowed to see, in
 * `projectForTeam`. Reusing that decision for the fetch endpoint means there is
 * no second, separate answer to "may this team read this?" that could disagree
 * with the board the participant is looking at — and no new plugin API to get
 * wrong. If the reference is in your projection you may fetch the body; if it
 * is not, the artifact does not exist as far as you are concerned.
 */

/** One body as it arrives on the wire. */
export interface CoordinationArtifactSubmission {
  /** The name the plugin will find this reference under. */
  readonly slot: string;
  readonly contentType: string;
  readonly content: Uint8Array;
}

export type ArtifactParseOutcome =
  | { readonly ok: true; readonly submissions: readonly CoordinationArtifactSubmission[] }
  | { readonly ok: false; readonly error: string };

/** Slot names are plugin-facing object keys, so they are kept boring. */
const SLOT_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/**
 * One half (type or subtype) of a media type.
 *
 * Checked against the two halves separately rather than with one regex spanning
 * the `/`. A single pattern with a bounded repetition on each side of a literal
 * is the shape that backtracks super-linearly on a crafted input, and this
 * value arrives straight off a participant request.
 */
const CONTENT_TYPE_PART_RE = /^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,63}$/;

/** Whether `value` is a media type this platform will store and echo back. */
function isAcceptableContentType(value: string): boolean {
  const parts = value.split("/");
  return parts.length === 2 && parts.every((part) => CONTENT_TYPE_PART_RE.test(part));
}

/**
 * Validates the `artifacts` half of a submission.
 *
 * Every limit here is refused rather than trimmed. A body silently truncated to
 * fit would be stored, referenced by the plugin's state, and then fail whatever
 * the plugin checks it against — much later, and looking like a problem bug
 * rather than a rejected upload.
 */
export function parseArtifactSubmissions(raw: unknown): ArtifactParseOutcome {
  if (raw === undefined || raw === null) return { ok: true, submissions: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "artifacts_must_be_an_object" };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > COORDINATION_ARTIFACT_MAX_PER_OP) {
    return { ok: false, error: "too_many_artifacts" };
  }
  const submissions: CoordinationArtifactSubmission[] = [];
  for (const [slot, value] of entries) {
    const parsed = parseOneArtifact(slot, value);
    if (!parsed.ok) return parsed;
    submissions.push(parsed.submission);
  }
  return { ok: true, submissions };
}

type OneArtifactOutcome =
  | { readonly ok: true; readonly submission: CoordinationArtifactSubmission }
  | { readonly ok: false; readonly error: string };

/**
 * The per-slot half of {@link parseArtifactSubmissions}.
 *
 * Split out so the checks read as a list rather than as a nest. Each one refuses
 * rather than repairs, for the reason the caller's docstring gives.
 */
function parseOneArtifact(slot: string, value: unknown): OneArtifactOutcome {
  if (!SLOT_RE.test(slot)) return { ok: false, error: "invalid_artifact_slot" };
  if (typeof value !== "object" || value === null) {
    return { ok: false, error: "invalid_artifact_body" };
  }
  const { contentType, contentBase64 } = value as Record<string, unknown>;
  if (typeof contentType !== "string" || !isAcceptableContentType(contentType)) {
    return { ok: false, error: "invalid_artifact_content_type" };
  }
  if (typeof contentBase64 !== "string") return { ok: false, error: "invalid_artifact_body" };
  // Bound the ENCODED length before decoding. Decoding first would let a
  // request allocate the very memory the limit exists to cap.
  if (contentBase64.length > MAX_ENCODED_LENGTH) {
    return { ok: false, error: "artifact_too_large" };
  }
  const content = decodeBase64(contentBase64);
  if (!content) return { ok: false, error: "invalid_artifact_encoding" };
  if (content.byteLength > COORDINATION_ARTIFACT_MAX_BYTES) {
    return { ok: false, error: "artifact_too_large" };
  }
  return { ok: true, submission: { slot, contentType, content } };
}

/** Base64 expands by 4/3, plus padding. */
const MAX_ENCODED_LENGTH = Math.ceil(COORDINATION_ARTIFACT_MAX_BYTES / 3) * 4 + 4;

/**
 * Strict base64 decode.
 *
 * `Buffer.from(s, "base64")` ignores anything it does not recognise, so a
 * corrupt upload would decode to a shorter body and be stored as if it were
 * fine. Re-encoding and comparing is the cheapest way to make "this is not
 * valid base64" an answer rather than a silent truncation.
 */
function decodeBase64(value: string): Uint8Array | undefined {
  const decoded = Buffer.from(value, "base64");
  // Trailing "=" is stripped by scanning rather than by a quantified regex:
  // `/=+$/` against an attacker-supplied string is the classic super-linear
  // backtracking shape, and this value comes straight off a request.
  const stripPadding = (text: string) => {
    let end = text.length;
    while (end > 0 && text[end - 1] === "=") end -= 1;
    return text.slice(0, end);
  };
  // Any character Buffer skipped would be missing from the re-encoded form, so
  // this comparison catches exactly the truncation the naive decode hides.
  // Padding is normalised away because both a padded and an unpadded encoding
  // of the same bytes are legitimate input.
  if (stripPadding(decoded.toString("base64")) !== stripPadding(value)) return undefined;
  return new Uint8Array(decoded);
}

export type ArtifactStoreOutcome =
  | { readonly kind: "stored"; readonly refs: Readonly<Record<string, CoordinationArtifactRef>> }
  /** The scope was torn down mid-submission; nothing was left behind. */
  | { readonly kind: "scope_deleted" };

/**
 * Stores every submitted body and returns the references to hand the plugin.
 *
 * On a partial failure — the second of three bodies is rejected by the store —
 * the ones already written are removed before the error propagates. Leaving
 * them would create objects that no state references and no teardown will find,
 * because the operation they belonged to never reached the state at all.
 */
export async function storeArtifactSubmissions(
  store: CoordinationArtifactStore,
  scope: CoordinationStateScope,
  submissions: readonly CoordinationArtifactSubmission[],
): Promise<ArtifactStoreOutcome> {
  const refs: Record<string, CoordinationArtifactRef> = {};
  try {
    for (const submission of submissions) {
      const outcome = await store.put(scope, {
        contentType: submission.contentType,
        content: submission.content,
      });
      if (outcome.kind === "scope_deleted") {
        await discardArtifacts(store, scope, Object.values(refs));
        return { kind: "scope_deleted" };
      }
      refs[submission.slot] = outcome.ref;
    }
  } catch (err) {
    await discardArtifacts(store, scope, Object.values(refs));
    throw err;
  }
  return { kind: "stored", refs };
}

/**
 * Removes bodies whose operation did not survive.
 *
 * Called when the plugin rejected the operation, when the optimistic-lock write
 * conflicted, or when a later body in the same submission failed. In all three
 * the state never referenced these objects, so they are unreachable the instant
 * the request ends.
 *
 * Failures are swallowed on purpose: the caller is already reporting a more
 * important outcome to the participant, and an object left behind is covered by
 * the bucket's own expiry. Turning a rejected move into a 500 because the
 * cleanup of its upload failed would be a strictly worse answer.
 */
export async function discardArtifacts(
  store: CoordinationArtifactStore,
  scope: CoordinationStateScope,
  refs: readonly CoordinationArtifactRef[],
): Promise<void> {
  await Promise.allSettled(refs.map((ref) => store.remove(scope, ref.artifactId)));
}

/**
 * Puts the issued references onto the operation under the reserved key.
 *
 * A reserved top-level key rather than placeholders substituted through the
 * operation's body: the operation is plugin-defined `unknown`, so a
 * substitution pass would have to walk and rewrite a shape the platform does
 * not understand, and would silently rewrite any value that happened to look
 * like a placeholder. One reserved key is a contract a problem author can read
 * in one line.
 */
export function withArtifactRefs(
  op: unknown,
  refs: Readonly<Record<string, CoordinationArtifactRef>>,
): unknown {
  if (Object.keys(refs).length === 0) return op;
  if (typeof op !== "object" || op === null || Array.isArray(op)) {
    // An operation that is not an object has nowhere to carry references. The
    // caller has already validated that artifacts were submitted, so silently
    // dropping them would hand the plugin an operation missing exactly the
    // material the participant sent.
    throw new TypeError("a coordination op carrying artifacts must be a JSON object");
  }
  return { ...(op as Record<string, unknown>), [COORDINATION_ARTIFACT_OP_KEY]: refs };
}

export type ArtifactFetchOutcome =
  | { readonly kind: "ok"; readonly artifact: CoordinationArtifactFetch }
  /**
   * Either there is no such artifact, or this team's projection does not
   * reference it. One outcome for both on purpose: telling the two apart would
   * let a participant probe which artifact ids exist in a match they cannot
   * see.
   */
  | { readonly kind: "not_found" };

/**
 * Reads one artifact body on behalf of a team, if that team's own projection
 * refers to it.
 */
export async function fetchAuthorizedArtifact(
  store: CoordinationArtifactStore,
  scope: CoordinationStateScope,
  projection: unknown,
  artifactId: string,
): Promise<ArtifactFetchOutcome> {
  if (!collectProjectedArtifactIds(projection).has(artifactId)) return { kind: "not_found" };
  const artifact = await store.get(scope, artifactId);
  return artifact ? { kind: "ok", artifact } : { kind: "not_found" };
}
