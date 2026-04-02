/**
 * Gameday Team Join API Proxy
 *
 * 招待コードでチーム参加エンドポイント
 */

export async function POST(request: Request) {
  const body = await request.json();
  const GAMEDAY_API_URL =
    process.env.GAMEDAY_API_URL || 'http://localhost:3020/api/gameday';
  const response = await fetch(`${GAMEDAY_API_URL}/teams/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  return Response.json(data, { status: response.status });
}
