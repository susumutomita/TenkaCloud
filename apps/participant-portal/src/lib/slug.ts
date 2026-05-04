/**
 * 任意の Unicode 文字列を ASCII slug に整形する。NFKD で正規化したあと英数字以外を
 * 落として lower-case 化し、上限長で切る。空文字なら fallback "anon" を返す。
 * 例: "日本語キー" → "anon" / "Alpha-1!" → "alpha1"
 */
export function toAsciiSlug(input: string, maxLength = 12): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]/g, "")
    .toLowerCase()
    .slice(0, maxLength);
  return slug || "anon";
}
