import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { hidesDraftProblems } from "../lib/draft-visibility";
import { draftBadge } from "./Quests.badges";

const t = (key: string) => key;

describe("draftBadge", () => {
  it("marks a draft shown by the developer toggle in local play", () => {
    render(<>{draftBadge("draft", hidesDraftProblems("local"), t)}</>);
    expect(screen.getByText("quests.draft_badge")).toBeInTheDocument();
  });

  it.each(["real", "mock"] as const)(
    "does not label a problem deployed to the team as draft in %s mode",
    (cloudMode) => {
      expect(draftBadge("draft", hidesDraftProblems(cloudMode), t)).toBeNull();
    },
  );

  it("does not mark published or unknown problems", () => {
    expect(draftBadge("ready", true, t)).toBeNull();
    expect(draftBadge(undefined, true, t)).toBeNull();
  });
});
