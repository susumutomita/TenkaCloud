import type {
  BulkCompetitorAccountEntry,
  BulkCreateCompetitorAccountsRequest,
} from "../api/competitor-accounts-client";

/**
 * 一括登録の入力を読む。
 *
 * operator が実際に手元に持っているものは 2 通りある。
 *
 * 1. `aws cloudformation list-stack-instances --query '...Account' --output text` の出力
 *    (= 空白か改行で区切られた 12 桁の列)。 StackSet で OU へ bootstrap を配った直後は
 *    これがそのまま「登録すべきアカウントの全部」になる。
 * 2. alias や region を持たせた JSON。
 *
 * どちらも受ける。 JSON として読めなければ ID の列として読み直す。 「JSON にしてから
 * 貼り直す」 を要求すると、 1 の経路がただの手作業に戻ってしまう。
 */

const ACCOUNT_ID_RE = /^\d{12}$/;
const REGION_RE = /^[a-z]{2}-[a-z]+-\d+$/;
const ROLE_NAME_RE = /^[A-Za-z0-9_+=,.@-]{1,64}$/;
const ALIAS_MAX = 120;

/** backend (`BULK_COMPETITOR_ACCOUNTS_MAX_ENTRIES`) と同じ 1 request の上限。 */
export const BULK_MAX_ENTRIES = 100;

export interface BulkParseSuccess {
  readonly ok: true;
  readonly accounts: readonly BulkCompetitorAccountEntry[];
  readonly defaults?: BulkCreateCompetitorAccountsRequest["defaults"];
}

export interface BulkParseFailure {
  readonly ok: false;
  /** 表示用の理由。 1 行目に何が悪いか、必要なら該当行を添える。 */
  readonly errors: readonly string[];
}

export type BulkParseResult = BulkParseSuccess | BulkParseFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 空白・改行・カンマ区切りの ID 列として読む (= CLI 出力をそのまま貼れるようにする)。 */
function parseAccountIdList(text: string): BulkParseResult {
  const tokens = text
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return { ok: false, errors: ["入力が空です"] };

  const errors: string[] = [];
  for (const token of tokens) {
    if (!ACCOUNT_ID_RE.test(token)) {
      errors.push(`AWS Account ID として読めません: ${token}`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, accounts: tokens.map((awsAccountId) => ({ awsAccountId })) };
}

/** 検証済みの任意フィールド 1 つ。 `undefined` は 「指定なし」、 失敗は `errors` に積む。 */
function optionalField(
  raw: Record<string, unknown>,
  key: "region" | "competitorRoleName" | "alias",
  valid: (value: string) => boolean,
  message: string,
  errors: string[],
): { readonly ok: true; readonly value?: string } | { readonly ok: false } {
  const value = raw[key];
  if (value === undefined) return { ok: true };
  if (typeof value !== "string" || !valid(value)) {
    errors.push(message);
    return { ok: false };
  }
  return { ok: true, value };
}

function parseEntry(
  raw: unknown,
  index: number,
  errors: string[],
): BulkCompetitorAccountEntry | undefined {
  const label = `accounts[${index}]`;
  if (typeof raw === "string") {
    if (!ACCOUNT_ID_RE.test(raw)) {
      errors.push(`${label}: AWS Account ID は 12 桁の数字です (${raw})`);
      return undefined;
    }
    return { awsAccountId: raw };
  }
  if (!isRecord(raw)) {
    errors.push(`${label}: オブジェクトか AWS Account ID の文字列である必要があります`);
    return undefined;
  }

  const awsAccountId = raw.awsAccountId;
  if (typeof awsAccountId !== "string" || !ACCOUNT_ID_RE.test(awsAccountId)) {
    errors.push(`${label}: awsAccountId は 12 桁の数字です`);
    return undefined;
  }

  const region = optionalField(
    raw,
    "region",
    (value) => REGION_RE.test(value),
    `${label}: region の形式が不正です`,
    errors,
  );
  const competitorRoleName = optionalField(
    raw,
    "competitorRoleName",
    (value) => ROLE_NAME_RE.test(value),
    `${label}: competitorRoleName の形式が不正です`,
    errors,
  );
  const alias = optionalField(
    raw,
    "alias",
    (value) => value.length > 0 && value.length <= ALIAS_MAX,
    `${label}: alias は 1〜${ALIAS_MAX} 文字です`,
    errors,
  );
  if (!region.ok || !competitorRoleName.ok || !alias.ok) return undefined;

  return {
    awsAccountId,
    ...(region.value !== undefined ? { region: region.value } : {}),
    ...(competitorRoleName.value !== undefined
      ? { competitorRoleName: competitorRoleName.value }
      : {}),
    ...(alias.value !== undefined ? { alias: alias.value } : {}),
  };
}

/**
 * `[...]` をそのまま、 `{accounts: [...]}` はその field を accounts の候補として返す。
 *
 * 呼ばれるのは入力が `{` / `[` で始まり、かつ `JSON.parse` が成功したときだけなので、
 * `json` は配列かオブジェクトのどちらかにしかならない。 `isRecord` の false 側は型を
 * 絞るために要るが実行時には到達しない。
 */
function resolveRawAccounts(json: unknown): unknown {
  if (Array.isArray(json)) return json;
  /* v8 ignore next */
  return isRecord(json) ? json.accounts : undefined;
}

function parseDefaults(
  raw: unknown,
  errors: string[],
): BulkCreateCompetitorAccountsRequest["defaults"] {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    errors.push("defaults はオブジェクトである必要があります");
    return undefined;
  }
  const defaults: { region?: string; competitorRoleName?: string } = {};
  if (raw.region !== undefined) {
    if (typeof raw.region !== "string" || !REGION_RE.test(raw.region)) {
      errors.push("defaults.region の形式が不正です");
    } else {
      defaults.region = raw.region;
    }
  }
  if (raw.competitorRoleName !== undefined) {
    if (typeof raw.competitorRoleName !== "string" || !ROLE_NAME_RE.test(raw.competitorRoleName)) {
      errors.push("defaults.competitorRoleName の形式が不正です");
    } else {
      defaults.competitorRoleName = raw.competitorRoleName;
    }
  }
  return defaults;
}

/**
 * 貼り付けられたテキストを一括登録の入力として読む。
 *
 * 受ける形:
 *   - `{ "defaults": {...}, "accounts": [...] }`
 *   - `[ {...}, "222222222222", ... ]`
 *   - 空白 / 改行 / カンマ区切りの ID 列 (= JSON でない)
 *
 * 同じ ID が 2 回出てくる場合はここで弾く。 backend も弾くが、 送る前に画面で分かる方が
 * 直すのが早い。
 */
export function parseBulkAccountsInput(text: string): BulkParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, errors: ["入力が空です"] };

  // JSON かどうかは `JSON.parse` の成否では判定できない。 12 桁のアカウント ID 1 件
  // (`222222222222`) はそれ自体が妥当な JSON (= 数値) なので、 成否で振り分けると
  // 「ID を 1 つ貼る」 が JSON 経路に落ちて 「accounts が配列ではありません」 になる。
  // ID の列が `{` / `[` で始まることは無いので、 先頭の 1 文字で決める。
  const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  if (!looksLikeJson) return finalize(parseAccountIdList(trimmed));

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return { ok: false, errors: ["JSON として読めません"] };
  }

  const errors: string[] = [];
  const defaults = isRecord(json) ? parseDefaults(json.defaults, errors) : undefined;
  const rawAccounts = resolveRawAccounts(json);
  if (!Array.isArray(rawAccounts)) {
    return {
      ok: false,
      errors: ['accounts が配列ではありません ({ "accounts": [...] } か配列を渡してください)'],
    };
  }

  const accounts: BulkCompetitorAccountEntry[] = [];
  rawAccounts.forEach((raw, index) => {
    const entry = parseEntry(raw, index, errors);
    if (entry) accounts.push(entry);
  });
  if (errors.length > 0) return { ok: false, errors };

  return finalize(
    defaults && Object.keys(defaults).length > 0
      ? { ok: true, accounts, defaults }
      : { ok: true, accounts },
  );
}

/** 件数上限と request 内の重複を、 送信前に画面で確定させる。 */
function finalize(result: BulkParseResult): BulkParseResult {
  if (!result.ok) return result;
  const errors: string[] = [];
  if (result.accounts.length === 0) {
    errors.push("登録するアカウントがありません");
  }
  if (result.accounts.length > BULK_MAX_ENTRIES) {
    errors.push(
      `1 回に登録できるのは ${BULK_MAX_ENTRIES} 件までです (${result.accounts.length} 件)`,
    );
  }
  const seen = new Set<string>();
  for (const entry of result.accounts) {
    if (seen.has(entry.awsAccountId)) {
      errors.push(`同じ AWS Account ID が複数回あります: ${entry.awsAccountId}`);
    }
    seen.add(entry.awsAccountId);
  }
  return errors.length > 0 ? { ok: false, errors } : result;
}
