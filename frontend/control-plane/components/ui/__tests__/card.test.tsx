import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../card";

describe("Card コンポーネント", () => {
  describe("Card", () => {
    it("children を正しくレンダリングすべき", () => {
      render(<Card>カードコンテンツ</Card>);
      expect(screen.getByText("カードコンテンツ")).toBeInTheDocument();
    });

    it("追加の className を適用すべき", () => {
      render(<Card className="custom-class">テスト</Card>);
      expect(screen.getByText("テスト")).toHaveClass("custom-class");
    });

    it("ref を正しく転送すべき", () => {
      const ref = createRef<HTMLDivElement>();
      render(<Card ref={ref}>テスト</Card>);
      expect(ref.current).toBeInstanceOf(HTMLDivElement);
    });

    it("デフォルトスタイルを持つべき", () => {
      render(<Card>テスト</Card>);
      expect(screen.getByText("テスト")).toHaveClass("rounded-lg");
    });
  });

  describe("CardHeader", () => {
    it("children を正しくレンダリングすべき", () => {
      render(<CardHeader>ヘッダー</CardHeader>);
      expect(screen.getByText("ヘッダー")).toBeInTheDocument();
    });

    it("追加の className を適用すべき", () => {
      render(<CardHeader className="custom-header">ヘッダー</CardHeader>);
      expect(screen.getByText("ヘッダー")).toHaveClass("custom-header");
    });

    it("ref を正しく転送すべき", () => {
      const ref = createRef<HTMLDivElement>();
      render(<CardHeader ref={ref}>ヘッダー</CardHeader>);
      expect(ref.current).toBeInstanceOf(HTMLDivElement);
    });

    it("デフォルトスタイルを持つべき", () => {
      render(<CardHeader>ヘッダー</CardHeader>);
      expect(screen.getByText("ヘッダー")).toHaveClass("flex");
      expect(screen.getByText("ヘッダー")).toHaveClass("flex-col");
    });
  });

  describe("CardTitle", () => {
    it("children を正しくレンダリングすべき", () => {
      render(<CardTitle>タイトル</CardTitle>);
      expect(screen.getByText("タイトル")).toBeInTheDocument();
    });

    it("追加の className を適用すべき", () => {
      render(<CardTitle className="custom-title">タイトル</CardTitle>);
      expect(screen.getByText("タイトル")).toHaveClass("custom-title");
    });

    it("ref を正しく転送すべき", () => {
      const ref = createRef<HTMLDivElement>();
      render(<CardTitle ref={ref}>タイトル</CardTitle>);
      expect(ref.current).toBeInstanceOf(HTMLDivElement);
    });

    it("デフォルトスタイルを持つべき", () => {
      render(<CardTitle>タイトル</CardTitle>);
      expect(screen.getByText("タイトル")).toHaveClass("text-2xl");
      expect(screen.getByText("タイトル")).toHaveClass("font-semibold");
    });
  });

  describe("CardDescription", () => {
    it("children を正しくレンダリングすべき", () => {
      render(<CardDescription>説明文</CardDescription>);
      expect(screen.getByText("説明文")).toBeInTheDocument();
    });

    it("追加の className を適用すべき", () => {
      render(<CardDescription className="custom-desc">説明文</CardDescription>);
      expect(screen.getByText("説明文")).toHaveClass("custom-desc");
    });

    it("ref を正しく転送すべき", () => {
      const ref = createRef<HTMLDivElement>();
      render(<CardDescription ref={ref}>説明文</CardDescription>);
      expect(ref.current).toBeInstanceOf(HTMLDivElement);
    });

    it("デフォルトスタイルを持つべき", () => {
      render(<CardDescription>説明文</CardDescription>);
      expect(screen.getByText("説明文")).toHaveClass("text-sm");
    });
  });

  describe("CardContent", () => {
    it("children を正しくレンダリングすべき", () => {
      render(<CardContent>コンテンツ</CardContent>);
      expect(screen.getByText("コンテンツ")).toBeInTheDocument();
    });

    it("追加の className を適用すべき", () => {
      render(<CardContent className="custom-content">コンテンツ</CardContent>);
      expect(screen.getByText("コンテンツ")).toHaveClass("custom-content");
    });

    it("ref を正しく転送すべき", () => {
      const ref = createRef<HTMLDivElement>();
      render(<CardContent ref={ref}>コンテンツ</CardContent>);
      expect(ref.current).toBeInstanceOf(HTMLDivElement);
    });

    it("デフォルトスタイルを持つべき", () => {
      render(<CardContent>コンテンツ</CardContent>);
      expect(screen.getByText("コンテンツ")).toHaveClass("p-6");
    });
  });

  describe("CardFooter", () => {
    it("children を正しくレンダリングすべき", () => {
      render(<CardFooter>フッター</CardFooter>);
      expect(screen.getByText("フッター")).toBeInTheDocument();
    });

    it("追加の className を適用すべき", () => {
      render(<CardFooter className="custom-footer">フッター</CardFooter>);
      expect(screen.getByText("フッター")).toHaveClass("custom-footer");
    });

    it("ref を正しく転送すべき", () => {
      const ref = createRef<HTMLDivElement>();
      render(<CardFooter ref={ref}>フッター</CardFooter>);
      expect(ref.current).toBeInstanceOf(HTMLDivElement);
    });

    it("デフォルトスタイルを持つべき", () => {
      render(<CardFooter>フッター</CardFooter>);
      expect(screen.getByText("フッター")).toHaveClass("flex");
      expect(screen.getByText("フッター")).toHaveClass("items-center");
    });
  });

  describe("Card 組み合わせ", () => {
    it("すべてのサブコンポーネントを正しく組み合わせるべき", () => {
      render(
        <Card data-testid="card">
          <CardHeader>
            <CardTitle>カードタイトル</CardTitle>
            <CardDescription>カード説明</CardDescription>
          </CardHeader>
          <CardContent>カード本文</CardContent>
          <CardFooter>カードフッター</CardFooter>
        </Card>,
      );

      expect(screen.getByTestId("card")).toBeInTheDocument();
      expect(screen.getByText("カードタイトル")).toBeInTheDocument();
      expect(screen.getByText("カード説明")).toBeInTheDocument();
      expect(screen.getByText("カード本文")).toBeInTheDocument();
      expect(screen.getByText("カードフッター")).toBeInTheDocument();
    });
  });
});
