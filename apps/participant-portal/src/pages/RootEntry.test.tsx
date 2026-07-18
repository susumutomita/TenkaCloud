import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config";
import { RootEntryPage, resolveGotoTarget } from "./RootEntry";

/**
 * #2711 フォローアップ: LP hero カードは `/portal-demo/?demo=1&goto=start` の実ファイルで
 * 着地する (= 静的ホスティングの rewrite が無い環境でも 404 fallback で崩れない)。
 * `goto=start` のとき /start へ replace、 内部 path の goto は deep link リロード復元
 * (landing の復旧スクリプト経由)、 それ以外は従来どおり Home を表示する。
 */

vi.mock("./Home", () => ({
  HomePage: () => <div>home-page</div>,
}));

const config = {} as AppConfig;

function renderAt(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/${search}`]}>
      <Routes>
        <Route path="/" element={<RootEntryPage config={config} />} />
        <Route path="/start" element={<div>start-page</div>} />
        <Route path="/problems/:id" element={<div>problem-page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("resolveGotoTarget", () => {
  it("should map the LP quest-card shorthand start to /start", () => {
    expect(resolveGotoTarget("start")).toBe("/start");
  });

  it("should accept an internal path for deep-link reload recovery", () => {
    expect(resolveGotoTarget("/problems/01HZX")).toBe("/problems/01HZX");
  });

  it("should reject open-redirect and traversal shapes", () => {
    expect(resolveGotoTarget(null)).toBeNull();
    expect(resolveGotoTarget("")).toBeNull();
    expect(resolveGotoTarget("problems/x")).toBeNull(); // 先頭 / なし
    expect(resolveGotoTarget("//evil.example")).toBeNull(); // protocol-relative
    expect(resolveGotoTarget("/a/../b")).toBeNull(); // traversal
    expect(resolveGotoTarget("https://evil.example/")).toBeNull(); // スキーム付き
    expect(resolveGotoTarget("/x:y")).toBeNull(); // コロン含み
  });
});

describe("RootEntryPage", () => {
  it("should forward the LP quest-card landing (?goto=start) to /start", () => {
    renderAt("?demo=1&goto=start");
    expect(screen.getByText("start-page")).toBeDefined();
    expect(screen.queryByText("home-page")).toBeNull();
  });

  it("should restore a reloaded deep link via ?goto=<path> (Cloudflare SPA fallback recovery)", () => {
    renderAt(`?goto=${encodeURIComponent("/problems/01HZX")}`);
    expect(screen.getByText("problem-page")).toBeDefined();
    expect(screen.queryByText("home-page")).toBeNull();
  });

  it("should fall back to Home for a rejected goto value", () => {
    renderAt(`?goto=${encodeURIComponent("//evil.example")}`);
    expect(screen.getByText("home-page")).toBeDefined();
  });

  it("should render Home for every other root visit", () => {
    renderAt("?demo=1");
    expect(screen.getByText("home-page")).toBeDefined();
  });
});
