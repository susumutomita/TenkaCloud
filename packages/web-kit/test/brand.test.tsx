/**
 * TenkaCloud brand kit (logo / mark / tokens) の振る舞いを固定する unit test。
 *
 * 検証観点:
 *   - BrandMark は 3 variant の幾何を描き分け、title 有無で role="img"/装飾を切り替える
 *   - BrandLockup はマーク + ワードマークを 1 つの role="img" に束ね、縦横とワードマーク差し替えに対応
 *   - data URI ロゴは img で使える形式で、summit path / app icon 角丸を保持する
 *   - brandColors / brandFonts はトークンの正本値を保つ (brand.css と一致させる前提)
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  BRAND_MARK_VARIANTS,
  BrandLockup,
  BrandMark,
  brandColors,
  brandFonts,
  tenkaCloudAppIconDataUri,
  tenkaCloudMarkDataUri,
} from "../src";

describe("BrandMark", () => {
  it("should render the summit mark (bar + single ridge) by default and be decorative", () => {
    const { container } = render(<BrandMark />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("viewBox")).toBe("0 0 120 120");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("role")).toBeNull();
    expect(container.querySelector("rect")).not.toBeNull();
    expect(container.querySelectorAll("path")).toHaveLength(1);
  });

  it("should render the ascend mark as two chevrons with the lower one faded", () => {
    const { container } = render(<BrandMark variant="ascend" />);
    expect(container.querySelector("rect")).toBeNull();
    const paths = container.querySelectorAll("path");
    expect(paths).toHaveLength(2);
    expect(paths[1]?.getAttribute("opacity")).toBe("0.55");
  });

  it("should render the cloudpeak mark as a faded cloud plus a solid peak", () => {
    const { container } = render(<BrandMark variant="cloudpeak" />);
    const paths = container.querySelectorAll("path");
    expect(paths).toHaveLength(2);
    expect(paths[0]?.getAttribute("opacity")).toBe("0.32");
  });

  it("should apply a square size to both width and height", () => {
    const { container } = render(<BrandMark size={40} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("40");
    expect(svg?.getAttribute("height")).toBe("40");
  });

  it("should expose an accessible name via role=img + aria-label when title is given", () => {
    render(<BrandMark title="TenkaCloud Summit" />);
    const svg = screen.getByRole("img", { name: "TenkaCloud Summit" });
    expect(svg.getAttribute("aria-hidden")).toBeNull();
    expect(svg.getAttribute("aria-label")).toBe("TenkaCloud Summit");
  });
});

describe("BrandLockup", () => {
  it("should render mark + wordmark under a single role=img named TenkaCloud", () => {
    const { container } = render(<BrandLockup />);
    const lockup = screen.getByRole("img", { name: "TenkaCloud" });
    expect(lockup.style.flexDirection).toBe("row");
    expect(container.querySelector("svg")).not.toBeNull();
    expect(screen.getByText("Tenka")).toBeInTheDocument();
    expect(screen.getByText("Cloud")).toBeInTheDocument();
  });

  it("should stack vertically when orientation is vertical", () => {
    render(<BrandLockup orientation="vertical" />);
    expect(screen.getByRole("img", { name: "TenkaCloud" }).style.flexDirection).toBe("column");
  });

  it("should accept a custom wordmark and accessible title", () => {
    render(<BrandLockup wordmark="天下クラウド" title="天下クラウド" />);
    expect(screen.getByRole("img", { name: "天下クラウド" })).toBeInTheDocument();
    expect(screen.getByText("天下クラウド")).toBeInTheDocument();
  });
});

describe("brand logo data URIs", () => {
  it("should expose the mark as an inline image data URI carrying the ink color", () => {
    expect(tenkaCloudMarkDataUri.startsWith("data:image/svg+xml,")).toBe(true);
    expect(decodeURIComponent(tenkaCloudMarkDataUri)).toContain(brandColors.ink);
    expect(decodeURIComponent(tenkaCloudMarkDataUri)).toContain("M26 90 L60 48 L94 90");
  });

  it("should expose a rounded app icon data URI (ink badge + summit ridge)", () => {
    const decoded = decodeURIComponent(tenkaCloudAppIconDataUri);
    expect(tenkaCloudAppIconDataUri.startsWith("data:image/svg+xml,")).toBe(true);
    expect(decoded).toContain('rx="26"');
    expect(decoded).toContain("M26 90 L60 48 L94 90");
  });
});

describe("brand tokens", () => {
  it("should keep the canonical brand color values", () => {
    expect(brandColors.ink).toBe("#1d1d1f");
    expect(brandColors.accent).toBe("#ff6a32");
    expect(brandColors.paper).toBe("#ffffff");
  });

  it("should lead the sans font stack with Inter", () => {
    expect(brandFonts.sans).toContain("Inter");
    expect(brandFonts.mono).toContain("JetBrains Mono");
  });

  it("should list the three brand mark variants", () => {
    expect(BRAND_MARK_VARIANTS).toEqual(["summit", "ascend", "cloudpeak"]);
  });
});
