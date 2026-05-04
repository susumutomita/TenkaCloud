/**
 * Microsoft Graph 低レベルクライアントのテスト。
 * `fetch` を vi.spyOn で乗っ取って、エラー整形 / propagation retry / token 解析の
 * 振る舞いを検証する。
 */

const {
  graphRequest,
  waitForGraphObjectReady,
  getGraphAccessToken,
  escapeODataString,
} = require("./client");

function jsonResponse(status, body, init = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("graph client", () => {
  describe("escapeODataString", () => {
    describe("OData filter 値に渡すとき", () => {
      it("単独のシングルクォートを 2 つに escape するべき", () => {
        expect(escapeODataString("O'Brien")).toBe("O''Brien");
      });

      it("シングルクォートが無い文字列はそのまま返すべき", () => {
        expect(escapeODataString("Acme Corp")).toBe("Acme Corp");
      });
    });
  });

  describe("getGraphAccessToken", () => {
    describe("Entra OAuth endpoint が access_token を返すとき", () => {
      it("token 文字列を返すべき", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          jsonResponse(200, { access_token: "tok-123" }),
        );
        const token = await getGraphAccessToken({
          tenantId: "tenant-1",
          clientId: "client-1",
          clientSecret: "secret-1",
        });
        expect(token).toBe("tok-123");
      });
    });

    describe("Entra が 401 で token を返さないとき", () => {
      it("status 含む error を投げるべき", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response("invalid_client", { status: 401 }),
        );
        await expect(
          getGraphAccessToken({ tenantId: "t", clientId: "c", clientSecret: "s" }),
        ).rejects.toThrow(/token request failed \(401\)/);
      });
    });

    describe("response に access_token が無いとき", () => {
      it("error を投げるべき", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(200, { foo: "bar" }));
        await expect(
          getGraphAccessToken({ tenantId: "t", clientId: "c", clientSecret: "s" }),
        ).rejects.toThrow(/did not include access_token/);
      });
    });
  });

  describe("graphRequest", () => {
    describe("204 No Content のとき", () => {
      it("null を返すべき", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 204 }));
        const result = await graphRequest("tok", "/applications/abc");
        expect(result).toBeNull();
      });
    });

    describe("4xx で Graph error body を返したとき", () => {
      it("statusCode と code:message 形式を含む error を投げるべき", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          jsonResponse(404, {
            error: { code: "Request_ResourceNotFound", message: "Resource does not exist" },
          }),
        );
        await expect(graphRequest("tok", "/applications/x")).rejects.toMatchObject({
          statusCode: 404,
          message: expect.stringContaining("Request_ResourceNotFound: Resource does not exist"),
        });
      });
    });

    describe("body 付き POST のとき", () => {
      it("authorization と content-type ヘッダを付けて fetch するべき", async () => {
        const fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockResolvedValueOnce(jsonResponse(200, { id: "x" }));
        await graphRequest("tok", "/invitations", {
          method: "POST",
          body: JSON.stringify({ invitedUserEmailAddress: "a@b.com" }),
        });
        const call = fetchSpy.mock.calls[0];
        expect(call[1].headers.authorization).toBe("Bearer tok");
        expect(call[1].headers["content-type"]).toBe("application/json");
      });
    });
  });

  describe("waitForGraphObjectReady", () => {
    describe("最初の呼び出しが 404 でも 2 回目で 200 になるとき", () => {
      it("retry して resolve するべき (最低 1 回 backoff した上で)", async () => {
        const notFound = new Response(
          JSON.stringify({
            error: { code: "Request_ResourceNotFound", message: "Resource '...' does not exist" },
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
        const found = jsonResponse(200, { id: "abc" });
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(notFound).mockResolvedValueOnce(found);

        await waitForGraphObjectReady("tok", "/applications/abc", 2);
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      });
    });

    describe("404 が maxRetries 回連続したとき", () => {
      it("最終的に 404 error を re-throw するべき", async () => {
        const notFound = () =>
          new Response(
            JSON.stringify({
              error: { code: "Request_ResourceNotFound", message: "Resource does not exist" },
            }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        vi.spyOn(globalThis, "fetch")
          .mockResolvedValueOnce(notFound())
          .mockResolvedValueOnce(notFound());

        await expect(waitForGraphObjectReady("tok", "/applications/abc", 2)).rejects.toMatchObject({
          statusCode: 404,
        });
      });
    });

    describe("404 以外の error のとき", () => {
      it("retry せず即座に throw するべき", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { code: "Forbidden", message: "Access denied" } }), {
            status: 403,
          }),
        );
        await expect(waitForGraphObjectReady("tok", "/applications/abc", 4)).rejects.toMatchObject({
          statusCode: 403,
        });
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      });
    });
  });
});
