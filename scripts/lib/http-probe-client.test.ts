import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { probeUrl } from "./http-probe-client";
import { probeTransport } from "./probe-transport";

describe("probeUrl (SSRF revalidation + bounded body read)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.spyOn(probeTransport, "fetch").mockImplementation(
      Object.assign(fetchMock, { preconnect: () => undefined }),
    );
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** stream-backed Response stub returning the given byte chunks via getReader(). */
  function streamResponse(status: number, chunks: readonly Uint8Array[], url?: string): unknown {
    let i = 0;
    const cancel = vi.fn(async () => undefined);
    return {
      status,
      url,
      body: {
        getReader() {
          return {
            read: async () =>
              i < chunks.length
                ? { done: false, value: chunks[i++] }
                : { done: true, value: undefined },
            cancel,
          };
        },
      },
      text: async () => chunks.map((c) => new TextDecoder().decode(c)).join(""),
    };
  }

  it("should not call fetch and return not-ok when the URL host is SSRF-blocked", async () => {
    const result = await probeUrl("http://169.254.169.254/latest/meta-data/", {
      readBody: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.status).toBeUndefined();
  });

  it("should cap the read body at MAX_BODY_BYTES (4096) for an oversized streamed response", async () => {
    const huge = new Uint8Array(5000).fill(0x61); // 5000 × 'a'
    fetchMock.mockResolvedValue(streamResponse(200, [huge]));
    const result = await probeUrl("https://team.example.com/meta", { readBody: true });
    expect(result.ok).toBe(true);
    expect(result.body).toBeDefined();
    expect((result.body as string).length).toBe(4096);
  });

  it("should treat a redirect that lands on a blocked host as not-ok and not reflect its body", async () => {
    const secret = new TextEncoder().encode("AWS_SECRET_ACCESS_KEY=leak");
    fetchMock.mockResolvedValue(
      streamResponse(200, [secret], "http://169.254.169.254/latest/meta-data/iam/"),
    );
    const result = await probeUrl("https://team.example.com/meta", { readBody: true });
    expect(result.ok).toBe(false);
    expect(result.body).toBeUndefined();
  });

  it("should read a small body via the res.text() fallback for non-stream mock responses", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "platform=ok" });
    const result = await probeUrl("https://team.example.com/meta", { readBody: true });
    expect(result.ok).toBe(true);
    expect(result.body).toBe("platform=ok");
  });
});
