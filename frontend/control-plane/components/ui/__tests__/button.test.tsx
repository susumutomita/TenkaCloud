import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button, buttonVariants } from "../button";

describe("Button コンポーネント", () => {
  describe("レンダリング", () => {
    it("children を正しくレンダリングすべき", () => {
      render(<Button>クリック</Button>);
      expect(
        screen.getByRole("button", { name: "クリック" }),
      ).toBeInTheDocument();
    });

    it("追加の className を適用すべき", () => {
      render(<Button className="custom-class">テスト</Button>);
      expect(screen.getByRole("button")).toHaveClass("custom-class");
    });

    it("ref を正しく転送すべき", () => {
      const ref = createRef<HTMLButtonElement>();
      render(<Button ref={ref}>テスト</Button>);
      expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    });

    it("disabled 状態をサポートすべき", () => {
      render(<Button disabled>無効</Button>);
      expect(screen.getByRole("button")).toBeDisabled();
    });

    it("type 属性を設定できるべき", () => {
      render(<Button type="submit">送信</Button>);
      expect(screen.getByRole("button")).toHaveAttribute("type", "submit");
    });
  });

  describe("バリアント", () => {
    it("default バリアントをレンダリングすべき", () => {
      render(<Button variant="default">Default</Button>);
      expect(screen.getByRole("button")).toHaveClass("bg-primary");
    });

    it("destructive バリアントをレンダリングすべき", () => {
      render(<Button variant="destructive">Destructive</Button>);
      expect(screen.getByRole("button")).toHaveClass("bg-destructive");
    });

    it("outline バリアントをレンダリングすべき", () => {
      render(<Button variant="outline">Outline</Button>);
      expect(screen.getByRole("button")).toHaveClass("border");
    });

    it("secondary バリアントをレンダリングすべき", () => {
      render(<Button variant="secondary">Secondary</Button>);
      expect(screen.getByRole("button")).toHaveClass("bg-secondary");
    });

    it("ghost バリアントをレンダリングすべき", () => {
      render(<Button variant="ghost">Ghost</Button>);
      expect(screen.getByRole("button")).toHaveClass("hover:bg-accent");
    });

    it("link バリアントをレンダリングすべき", () => {
      render(<Button variant="link">Link</Button>);
      expect(screen.getByRole("button")).toHaveClass("underline-offset-4");
    });
  });

  describe("サイズ", () => {
    it("default サイズをレンダリングすべき", () => {
      render(<Button size="default">Default</Button>);
      expect(screen.getByRole("button")).toHaveClass("h-10");
    });

    it("sm サイズをレンダリングすべき", () => {
      render(<Button size="sm">Small</Button>);
      expect(screen.getByRole("button")).toHaveClass("h-9");
    });

    it("lg サイズをレンダリングすべき", () => {
      render(<Button size="lg">Large</Button>);
      expect(screen.getByRole("button")).toHaveClass("h-11");
    });

    it("icon サイズをレンダリングすべき", () => {
      render(<Button size="icon">🔍</Button>);
      expect(screen.getByRole("button")).toHaveClass("w-10");
    });
  });

  describe("インタラクション", () => {
    it("クリックイベントを処理すべき", async () => {
      const user = userEvent.setup();
      const handleClick = vi.fn();
      render(<Button onClick={handleClick}>クリック</Button>);

      await user.click(screen.getByRole("button"));
      expect(handleClick).toHaveBeenCalledTimes(1);
    });

    it("disabled 時はクリックイベントを発火しないべき", async () => {
      const user = userEvent.setup();
      const handleClick = vi.fn();
      render(
        <Button onClick={handleClick} disabled>
          無効
        </Button>,
      );

      await user.click(screen.getByRole("button"));
      expect(handleClick).not.toHaveBeenCalled();
    });
  });

  describe("buttonVariants", () => {
    it("デフォルトバリアントのクラス名を返すべき", () => {
      const className = buttonVariants();
      expect(className).toContain("inline-flex");
      expect(className).toContain("rounded-md");
    });

    it("指定バリアントとサイズのクラス名を返すべき", () => {
      const className = buttonVariants({ variant: "outline", size: "sm" });
      expect(className).toContain("border");
      expect(className).toContain("h-9");
    });
  });
});
