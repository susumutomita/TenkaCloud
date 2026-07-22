from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    target = Path(path)
    source = target.read_text()
    if old not in source:
        raise SystemExit(f"anchor not found in {path}: {old[:120]!r}")
    target.write_text(source.replace(old, new, 1))


replace(
    "infrastructure/test/problem-deploy/deploy-runtime-dispatch.test.ts",
    '''    const appRunFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "app-1" }), { status: 201 }));''',
    '''    const appRunFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "user" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "app-1" }), { status: 201 }));''',
)
replace(
    "infrastructure/test/problem-deploy/deploy-runtime-dispatch.test.ts",
    '''    // AppRun REST を叩いた (list → create)、 EventBridge は使わない
    expect(appRunFetch).toHaveBeenCalledTimes(2);
    expect(appRunFetch.mock.calls[1][1].method).toBe("POST");''',
    '''    // AppRun REST を叩いた (user bootstrap → list → create)、 EventBridge は使わない
    expect(appRunFetch).toHaveBeenCalledTimes(3);
    expect(appRunFetch.mock.calls[2][1].method).toBe("POST");''',
)

replace(
    "infrastructure/test/problem-deploy/deploy-delete.test.ts",
    '''    // AppRun REST: findByName (list) → delete by id
    const appRunFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "a1", name: "tc-p-t" }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));''',
    '''    // AppRun REST: user bootstrap → findByName (list) → delete by id
    const appRunFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "user" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "a1", name: "tc-p-t" }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));''',
)
replace(
    "infrastructure/test/problem-deploy/deploy-delete.test.ts",
    '''    // SSM から鍵を引き AppRun REST を叩いた (list + DELETE)
    expect(ssmSend).toHaveBeenCalled();
    expect(appRunFetch.mock.calls[1][1].method).toBe("DELETE");''',
    '''    // SSM から鍵を引き AppRun REST を叩いた (user bootstrap + list + DELETE)
    expect(ssmSend).toHaveBeenCalled();
    expect(appRunFetch.mock.calls[2][1].method).toBe("DELETE");''',
)

bulk = "infrastructure/test/problem-deploy/event-bulk-delete.test.ts"
replace(
    bulk,
    '''    const appRunFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "a1", name: "tc-p-team-1" }] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", appRunFetch);

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);''',
    '''    const appRunFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "user" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "a1", name: "tc-p-team-1" }] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", appRunFetch);

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);''',
)
replace(
    bulk,
    '''    expect(ssmSend).toHaveBeenCalled();
    expect(appRunFetch.mock.calls[1]?.[1]?.method).toBe("DELETE");''',
    '''    expect(ssmSend).toHaveBeenCalled();
    expect(appRunFetch.mock.calls[2]?.[1]?.method).toBe("DELETE");''',
)
replace(
    bulk,
    '''    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("boom", { status: 500 })), // findByName list fails
    );''',
    '''    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: "user" }), { status: 200 }))
        .mockResolvedValueOnce(new Response("boom", { status: 500 })), // findByName list fails
    );''',
)
replace(
    bulk,
    '''    const appRunFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "a1", name: "tc-p-team-1" }] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", appRunFetch);

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);''',
    '''    const appRunFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "user" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "a1", name: "tc-p-team-1" }] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", appRunFetch);

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);''',
)
replace(
    bulk,
    '''    const appRunFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));''',
    '''    const appRunFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "user" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));''',
)
replace(
    bulk,
    '''    expect(ssmSend).toHaveBeenCalled();
    expect(appRunFetch).toHaveBeenCalledTimes(1);''',
    '''    expect(ssmSend).toHaveBeenCalled();
    expect(appRunFetch).toHaveBeenCalledTimes(2);''',
)
replace(
    bulk,
    '''    const appRunFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "a1", name: "tc-p-team-1" }] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", appRunFetch);

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);''',
    '''    const appRunFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "user" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "a1", name: "tc-p-team-1" }] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", appRunFetch);

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);''',
)

replace(
    "infrastructure/test/problem-deploy/runtime-status-reconciler.test.ts",
    '''  function stubSakuraFetch(status: string, publicUrl?: string) {
    const app = {
      id: "a1",
      name: "tc-p-team-a",
      status,
      ...(publicUrl ? { public_url: publicUrl } : {}),
    };
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/applications")
        ? new Response(JSON.stringify({ data: [{ id: "a1", name: "tc-p-team-a" }] }), {
            status: 200,
          })
        : new Response(JSON.stringify(app), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }''',
    '''  function stubSakuraFetch(status: string, publicUrl?: string) {
    const app = {
      id: "a1",
      name: "tc-p-team-a",
      status,
      ...(publicUrl ? { public_url: publicUrl } : {}),
    };
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/user")) {
        return new Response(JSON.stringify({ id: "user" }), { status: 200 });
      }
      if (parsed.pathname.endsWith("/applications")) {
        return new Response(JSON.stringify({ data: [{ id: "a1", name: "tc-p-team-a" }] }), {
          status: 200,
        });
      }
      if (parsed.pathname.endsWith("/applications/a1/status")) {
        return new Response(JSON.stringify({ status }), { status: 200 });
      }
      return new Response(JSON.stringify(app), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }''',
)
