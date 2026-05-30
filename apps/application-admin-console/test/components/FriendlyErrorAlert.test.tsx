import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FriendlyErrorAlert } from "../../src/components/FriendlyErrorAlert";

/**
 * FriendlyErrorAlert (#665): title + optional hint + optional 原因候補 list の構造化表示を pin。
 */
describe("FriendlyErrorAlert", () => {
  it("should render the title only when hint and causes are absent", () => {
    render(<FriendlyErrorAlert error={{ title: "Deploy failed" }} />);
    expect(screen.getByText("Deploy failed")).toBeInTheDocument();
    expect(screen.queryByText("考えられる原因:")).not.toBeInTheDocument();
  });

  it("should render the hint when present", () => {
    render(<FriendlyErrorAlert error={{ title: "Failed", hint: "Check the ExternalId." }} />);
    expect(screen.getByText("Check the ExternalId.")).toBeInTheDocument();
  });

  it("should render the possible-causes list when non-empty", () => {
    render(
      <FriendlyErrorAlert
        error={{
          title: "AssumeRole failed",
          possibleCauses: ["ExternalId mismatch", "Role missing"],
        }}
      />,
    );
    expect(screen.getByText("考えられる原因:")).toBeInTheDocument();
    expect(screen.getByText("ExternalId mismatch")).toBeInTheDocument();
    expect(screen.getByText("Role missing")).toBeInTheDocument();
  });

  it("should not render the causes section when the list is empty", () => {
    render(<FriendlyErrorAlert error={{ title: "Failed", possibleCauses: [] }} />);
    expect(screen.queryByText("考えられる原因:")).not.toBeInTheDocument();
  });
});
