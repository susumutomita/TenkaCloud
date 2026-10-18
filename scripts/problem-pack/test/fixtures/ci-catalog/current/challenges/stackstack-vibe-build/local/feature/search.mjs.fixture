/**
 * 掲示板アーカイブの検索機能。
 *
 * 要件は走っているアプリが持っています: `GET /api/spec` (R1〜R9)。
 * このファイルは読み取り専用でコンテナにマウントされ、 変更するたびに読み直されます。
 * 再起動は要りません。 保存した瞬間から `GET /api/search` と `GET /search` が
 * ここのコードを呼びます。
 *
 * 生成 AI に書かせて構いません (むしろ推奨です)。 採点はこのファイルの中身を読みません。
 * 走っているアプリに実際の HTTP リクエストを投げ、 返ってきたものだけで決まります。
 * 貼ったら信じる前に `GET /api/selfcheck` を 1 回通してください。
 */

/**
 * @param {{ query: string | null, posts: Array<{ id: number, title: string, author: string, body: string, at: string, visibility: string }> }} input
 * @returns {{ status: number, body: object }}
 */
export function search({ query, posts }) {
  // まだ何も実装していません。 R1〜R8 を満たすように書き換えてください。
  return { status: 200, body: { query: "", matches: [] } };
}

/**
 * @param {{ query: string, matches: Array<{ id: number, title: string, author: string, at: string }> }} input
 * @returns {string} 検索結果ページに埋め込む HTML
 */
export function renderResults({ query, matches }) {
  // まだ何も実装していません。 R9 を満たすように書き換えてください。
  return "<p>検索結果の表示はまだ実装されていません。</p>";
}
