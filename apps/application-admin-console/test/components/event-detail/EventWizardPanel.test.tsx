import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EventWizardPanel } from "../../../src/components/event-detail/EventWizardPanel";
import en from "../../../src/i18n/locales/en.json";
import ja from "../../../src/i18n/locales/ja.json";
import type { WizardState } from "../../../src/lib/event-wizard";

function realT(dict: Record<string, unknown>) {
  return (key: string) => {
    const value = key
      .split(".")
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
        dict,
      );
    return typeof value === "string" ? value : key;
  };
}

const wizard = (stepIndex: number): WizardState => ({
  step: "draft",
  stepIndex,
  primary: null,
});

describe("EventWizardPanel step labels", () => {
  it("should render every step label in English for the English locale", () => {
    render(<EventWizardPanel t={realT(en)} wizard={wizard(0)} />);
    expect(screen.getByText("1. Create")).toBeInTheDocument();
    expect(screen.getByText("2. Deploy")).toBeInTheDocument();
    expect(screen.getByText("3. Set start time")).toBeInTheDocument();
    expect(screen.getByText("4. Competing")).toBeInTheDocument();
    expect(screen.getByText("5. Ended")).toBeInTheDocument();
    expect(screen.queryByText(/作成|開始時刻設定|競技中|終了/)).not.toBeInTheDocument();
  });

  it("should render every step label in Japanese for the Japanese locale", () => {
    render(<EventWizardPanel t={realT(ja)} wizard={wizard(0)} />);
    expect(screen.getByText("1. 作成")).toBeInTheDocument();
    expect(screen.getByText("2. Deploy")).toBeInTheDocument();
    expect(screen.getByText("3. 開始時刻設定")).toBeInTheDocument();
    expect(screen.getByText("4. 競技中")).toBeInTheDocument();
    expect(screen.getByText("5. 終了")).toBeInTheDocument();
  });
});
