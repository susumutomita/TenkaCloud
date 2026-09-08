import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ProblemDiagram } from "../../src/components/ProblemDiagram";
import en from "../../src/i18n/locales/en.json";
import ja from "../../src/i18n/locales/ja.json";

it.each([ja, en])("keeps one caption and replaces a broken image with recovery text", (locale) => {
  const strings = locale.problem_detail;
  const t = (key: string) => strings[key.split(".")[1] as keyof typeof strings];
  const { rerender } = render(<ProblemDiagram key="first" src="/assets/first.svg" t={t} />);
  const img = screen.getByRole("img", { name: strings.info_diagram_alt });
  expect(screen.getAllByText(strings.info_diagram_label)).toHaveLength(1);
  expect(img).toHaveAttribute("src", "/assets/first.svg");
  fireEvent.error(img);
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(screen.getAllByText(strings.info_diagram_label)).toHaveLength(1);
  expect(screen.getByText(strings.info_diagram_failed)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: new RegExp(strings.info_diagram_open) })).toHaveAttribute(
    "href",
    "/assets/first.svg",
  );
  // The detail page keys the component by URL, so a new problem can load normally.
  rerender(<ProblemDiagram key="second" src="/assets/second.svg" t={t} />);
  expect(screen.getByRole("img")).toHaveAttribute("src", "/assets/second.svg");
});
