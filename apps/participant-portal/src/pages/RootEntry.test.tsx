import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config";
import { RootEntryPage } from "./RootEntry";

/**
 * #2711 フォローアップ: LP hero カードは `/portal-demo/?demo=1&goto=start` の実ファイルで
 * 着地する (= 静的ホスティングの rewrite が無い環境でも 404 fallback で崩れない)。
 * `goto=start` のとき /start へ replace、 それ以外は従来どおり Home を表示する。
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
      </Routes>
    </MemoryRouter>,
  );
}

describe("RootEntryPage", () => {
  it("should forward the LP quest-card landing (?goto=start) to /start", () => {
    renderAt("?demo=1&goto=start");
    expect(screen.getByText("start-page")).toBeDefined();
    expect(screen.queryByText("home-page")).toBeNull();
  });

  it("should render Home for every other root visit", () => {
    renderAt("?demo=1");
    expect(screen.getByText("home-page")).toBeDefined();
  });
});
