import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button } from "../Button";

describe("Button", () => {
  it("プライマリボタンが正しくレンダリングされるべき", () => {
    render(<Button variant="primary">Click me</Button>);
    const button = screen.getByRole("button", { name: /click me/i });
    expect(button).toBeInTheDocument();
    expect(button).toHaveClass("bg-blue-600");
  });

  it("セカンダリボタンが正しくレンダリングされるべき", () => {
    render(<Button variant="secondary">Cancel</Button>);
    const button = screen.getByRole("button", { name: /cancel/i });
    expect(button).toBeInTheDocument();
    expect(button).toHaveClass("bg-gray-200");
  });

  it("デンジャーボタンが正しくレンダリングされるべき", () => {
    render(<Button variant="danger">Delete</Button>);
    const button = screen.getByRole("button", { name: /delete/i });
    expect(button).toBeInTheDocument();
    expect(button).toHaveClass("bg-red-600");
  });

  it("デフォルトではプライマリボタンとしてレンダリングされるべき", () => {
    render(<Button>Default</Button>);
    const button = screen.getByRole("button", { name: /default/i });
    expect(button).toHaveClass("bg-blue-600");
  });
});
