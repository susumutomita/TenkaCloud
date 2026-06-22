/**
 * Issue #1973: ターゲット非依存の URL ガード (SSRF 対策)。
 *
 * 参加者が渡す endpoint URL を Evaluator がそのまま fetch してはならない。 ここで
 * 「どこで動く問題アプリを評価してよいか」を **policy** として表現し、 engine 本体は
 * ターゲット (Cloudflare Workers / ローカルコンテナ / 他クラウド) を一切ハードコードしない。
 *
 *   - 公開無料モード : {@link CLOUDFLARE_WORKERS_POLICY} (= `*.workers.dev` のみ)
 *   - ローカルバックエンド : {@link LOCAL_CONTAINER_POLICY} (= loopback / private IP / http / 非標準ポート許可)
 *   - 他クラウド : `allowedHostSuffixes` に suffix を足した policy を作る (例 `.run.app`)
 *
 * 「どこで動くか」が policy に閉じるので、 新ターゲット追加で engine のコードは変わらない
 * (= 保守性)。 純粋関数なのでネットワーク無しで全分岐をテストできる。
 */

/** 評価対象 URL を受理してよい条件。 ターゲット (実行先) ごとに 1 つ作る。 */
export interface TargetPolicy {
  /**
   * 許可する hostname suffix (例 `[".workers.dev"]`)。 必ず先頭ドット付きで指定する
   * (= `foo.workers.dev.evil.example` や `xworkers.dev` の suffix spoofing を防ぐ)。
   * 空配列なら hostname suffix 制約なし (= ローカルモードで任意ホストを許す用途)。
   */
  readonly allowedHostSuffixes: readonly string[];
  /** loopback (localhost / 127.0.0.0/8 / ::1 / 0.0.0.0) を許可するか。 */
  readonly allowLoopback: boolean;
  /** private アドレス (RFC1918 / link-local / ULA) を許可するか。 */
  readonly allowPrivateIp: boolean;
  /** 標準ポート (https=443 / http=80) 以外を許可するか。 */
  readonly allowNonStandardPort: boolean;
  /** `http:` を許可するか (既定 false = `https:` のみ)。 */
  readonly allowHttp: boolean;
}

/** 公開無料チャレンジ: Cloudflare Temporary Account の `*.workers.dev` だけを許す。 */
export const CLOUDFLARE_WORKERS_POLICY: TargetPolicy = {
  allowedHostSuffixes: [".workers.dev"],
  allowLoopback: false,
  allowPrivateIp: false,
  allowNonStandardPort: false,
  allowHttp: false,
};

/**
 * ローカルバックエンド: 参加者アプリをローカルコンテナで動かして評価する用途。
 * loopback / private / http / 非標準ポートを許す (= `http://localhost:8787` 等)。
 * **クラウドにこの policy を載せてはならない** (= SSRF。 cloud では Workers / 他クラウド policy を使う)。
 */
export const LOCAL_CONTAINER_POLICY: TargetPolicy = {
  allowedHostSuffixes: [],
  allowLoopback: true,
  allowPrivateIp: true,
  allowNonStandardPort: true,
  allowHttp: true,
};

/**
 * ローカルバックエンド用に policy を緩める: 許可 suffix は保ったまま loopback / private /
 * http / 非標準ポートを足す。 これで「`wrangler dev` の localhost:8787」「ローカルコンテナ」も
 * 「実デプロイ済みの *.workers.dev」も同じ engine で評価できる。 **クラウドでは使わない**。
 */
export function widenForLocal(policy: TargetPolicy): TargetPolicy {
  return {
    allowedHostSuffixes: policy.allowedHostSuffixes,
    allowLoopback: true,
    allowPrivateIp: true,
    allowNonStandardPort: true,
    allowHttp: true,
  };
}

export type GuardResult =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly reason: string };

type HostClass = "loopback" | "private" | "publicIp" | "hostname";

// IPv6 リテラル (URL.hostname は "[::1]" のように括弧付きで返す) を分類する。
function classifyIpv6(literal: string): HostClass {
  const ip6 = literal.slice(1, -1);
  if (ip6 === "::1") return "loopback";
  if (/^f[cd][0-9a-f]{2}:/.test(ip6) || /^fe80:/.test(ip6)) return "private";
  return "publicIp";
}

// IPv4 リテラルを分類する。 オクテット範囲は WHATWG URL パーサが先に検証するので、
// ここに来る時点で各オクテットは 0〜255 (範囲外は `new URL` が "形式が不正" で弾く)。
function classifyIpv4(h: string): HostClass {
  const o = h.split(".").map(Number);
  if (o[0] === 0 || o[0] === 127) return "loopback";
  if (o[0] === 10) return "private";
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return "private";
  if (o[0] === 192 && o[1] === 168) return "private";
  if (o[0] === 169 && o[1] === 254) return "private";
  return "publicIp";
}

/** hostname を loopback / private / 公開 IP / 通常ホスト名に分類する。 */
function classifyHost(rawHostname: string): HostClass {
  const h = rawHostname.toLowerCase();
  if (h === "localhost") return "loopback";
  if (h.startsWith("[") && h.endsWith("]")) return classifyIpv6(h);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return classifyIpv4(h);
  return "hostname";
}

/** 各チェックは「不許可の理由」または null (= OK) を返す。 guardTargetUrl が順に評価する。 */
function checkProtocol(url: URL, policy: TargetPolicy): string | null {
  if (url.protocol === "http:") {
    return policy.allowHttp ? null : "http: は許可されていません (https: のみ)";
  }
  return url.protocol === "https:" ? null : `プロトコル "${url.protocol}" は許可されていません`;
}

function checkHost(url: URL, policy: TargetPolicy): string | null {
  const cls = classifyHost(url.hostname);
  if (cls === "loopback")
    return policy.allowLoopback ? null : "loopback アドレスは許可されていません";
  if (cls === "private")
    return policy.allowPrivateIp ? null : "private アドレスは許可されていません";
  if (cls === "publicIp") return "IP アドレス直接指定は許可されていません";
  if (policy.allowedHostSuffixes.length === 0) return null;
  const host = url.hostname.toLowerCase();
  const matched = policy.allowedHostSuffixes.some((s) => host.endsWith(s.toLowerCase()));
  return matched
    ? null
    : `ホスト名が許可リストに一致しません (${policy.allowedHostSuffixes.join(", ")})`;
}

function checkPort(url: URL, policy: TargetPolicy): string | null {
  // URL API は標準ポート (https=443 / http=80) を "" に正規化するので、 ここで port が
  // 非空なら必ず非標準ポート。
  if (url.port === "" || policy.allowNonStandardPort) return null;
  return "非標準ポートは許可されていません";
}

/**
 * 参加者が渡した URL を policy で検証する。 受理時のみ `URL` を返す。
 * リダイレクト追従・タイムアウト・本文サイズ上限は probe 実行側 ({@link runProbe}) の責務。
 */
export function guardTargetUrl(raw: string, policy: TargetPolicy): GuardResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "URL の形式が不正です" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "ユーザー情報付き URL は許可されていません" };
  }
  const reason = checkProtocol(url, policy) ?? checkHost(url, policy) ?? checkPort(url, policy);
  return reason ? { ok: false, reason } : { ok: true, url };
}
